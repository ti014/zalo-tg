import { ThreadType } from 'zca-js';
import { createReadStream } from 'fs';
import path from 'path';
import QRCode from 'qrcode';

import type { ZaloAPI, ZaloMessage } from './types.js';
import { ZALO_MSG_TYPES } from './types.js';
import { store, msgStore, userCache, pollStore, sentMsgStore, pendingSendStore, zaloAlbumStore, aliasCache, type ZaloQuoteData } from '../store/index.js';
import { config } from '../config.js';
import {
  cleanTemp,
  downloadToTemp,
  hashFileSha256,
  splitFileForTelegram,
} from '../utils/media.js';
import { applyMentionsHtml, formatGroupMsgHtml, groupCaption, truncate, escapeHtml } from '../utils/format.js';
import {
  buildScoreText,
  getCachedGroupInfo,
  getCachedUserDisplayName,
  parseBankCardHtml,
  parseContent,
  refreshCachedGroupInfo,
  resolveUserDisplayName,
  tg,
} from './helpers.js';
import {
  decideZaloConversationPolicy,
  isMutedZaloConversation,
  isStrangerZaloUser,
} from './conversation-policy.js';
import { runZaloRequest } from './rate-limit.js';
import { getOrCreateTopic, isTopicDeletedError, sendWithTopicRecovery } from './topic.js';
import { normalizeMessageId, normalizeMessageIds } from '../domain/message-id.js';
import { contentFingerprint, type PendingSendKind } from '../domain/pending-sends.js';
import {
  isDurableZaloDelivery,
  currentDurableZaloMultipartManifest,
  ensureDurableZaloMultipartManifest,
  listDurableZaloMultipartParts,
  markDurableZaloHandled,
  markDurableZaloMultipartPartFailure,
  markDurableZaloMultipartPartSending,
  recordDurableZaloFailure,
  recordDurableZaloProviderMessageId,
  recordDurableZaloSkipped,
  type DurableZaloRelay,
} from '../application/durable-zalo.js';
import {
  currentDurableZaloMedia,
  downloadZaloMediaDurably,
} from '../application/durable-media.js';
import { lookupShadowSentTelegramId } from '../infrastructure/database/shadow-state.js';
import { isAmbiguousProviderFailure } from '../domain/provider-errors.js';

const inFlightMsgIds = new Map<string, ReturnType<typeof setTimeout>>();
const IN_FLIGHT_MSG_TTL_MS = 90_000;

function recordInvalidSourcePayload(message: string): void {
  recordDurableZaloFailure(Object.assign(new Error(message), {
    code: 'INVALID_SOURCE_PAYLOAD',
  }));
}

function markMessageInFlight(msgId: string): void {
  const existing = inFlightMsgIds.get(msgId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => inFlightMsgIds.delete(msgId), IN_FLIGHT_MSG_TTL_MS);
  inFlightMsgIds.set(msgId, timer);
}

function unmarkMessageInFlight(msgId: string | undefined): void {
  if (!msgId) return;
  const timer = inFlightMsgIds.get(msgId);
  if (timer) clearTimeout(timer);
  inFlightMsgIds.delete(msgId);
}

function unmarkMessagesInFlight(msgIds: string[]): void {
  for (const msgId of msgIds) unmarkMessageInFlight(msgId);
}

function pendingEchoIdentity(msg: ZaloMessage): { kind: PendingSendKind; fingerprint?: string } {
  const msgType = msg.data.msgType;
  const { text, media } = parseContent(msg.data.content);
  switch (msgType) {
    case ZALO_MSG_TYPES.PHOTO: return { kind: 'photo' };
    case ZALO_MSG_TYPES.VIDEO: return { kind: 'video' };
    case ZALO_MSG_TYPES.VOICE: return { kind: 'voice' };
    case ZALO_MSG_TYPES.STICKER: return { kind: 'sticker' };
    case ZALO_MSG_TYPES.POLL: {
      let question: string | undefined;
      try {
        const params = JSON.parse(media.params ?? '{}') as { question?: string };
        question = params.question;
      } catch { /* no fingerprint */ }
      return { kind: 'poll', fingerprint: contentFingerprint(question) };
    }
    case ZALO_MSG_TYPES.LOCATION:
      return { kind: 'location', fingerprint: contentFingerprint(media.href) };
    case ZALO_MSG_TYPES.LINK:
      if (media.href?.includes('google.com/maps')) {
        return { kind: 'location', fingerprint: contentFingerprint(media.href) };
      }
      return { kind: 'text', fingerprint: contentFingerprint(text ?? media.href) };
    case ZALO_MSG_TYPES.CONTACT: return { kind: 'contact' };
    case ZALO_MSG_TYPES.FILE:
    case ZALO_MSG_TYPES.GIF:
    case ZALO_MSG_TYPES.DOODLE:
      return { kind: 'document' };
    default: return { kind: 'text', fingerprint: contentFingerprint(text ?? undefined) };
  }
}

export function registerZaloMessageHandler(api: ZaloAPI, durableRelay?: DurableZaloRelay): void {
  api.listener.on('message', (msg: ZaloMessage) => {
    if (durableRelay) {
      durableRelay.enqueue(msg);
      return;
    }
    void handleZaloMessage(api, msg);
  });
}

export async function handleZaloMessage(
  api: ZaloAPI,
  msg: ZaloMessage,
  topicRetryAttempt = 0,
): Promise<void> {
  let keepInFlightUntilTtl = false;
  try {
      markDurableZaloHandled();
      if (msg.isSelf) {
        const selfMsgIds = normalizeMessageIds([
          msg.data.msgId,
          msg.data.realMsgId,
          msg.data.cliMsgId,
        ]);
        const tgSentMsgId = selfMsgIds
          .map(id => sentMsgStore.getByZaloMsgId(id))
          .find((id): id is number => id !== undefined)
          ?? lookupShadowSentTelegramId(
            msg.threadId,
            msg.type as 0 | 1,
            selfMsgIds,
          );
        const pendingIdentity = pendingEchoIdentity(msg);
        const pendingTgMsgId = tgSentMsgId ?? pendingSendStore.consume({
          conversationId: msg.threadId,
          aliases: selfMsgIds,
          ...pendingIdentity,
        });
        const isEcho = pendingTgMsgId !== undefined;
        if (pendingTgMsgId !== undefined) {
          const existing = sentMsgStore.get(pendingTgMsgId);
          const nextMsgId = normalizeMessageId(msg.data.realMsgId)
            ?? normalizeMessageId(msg.data.msgId)
            ?? existing?.msgId;
          const nextCliMsgId = normalizeMessageId(msg.data.cliMsgId) ?? existing?.cliMsgId;
          if (nextMsgId !== undefined) {
            sentMsgStore.save(pendingTgMsgId, {
              msgId: nextMsgId,
              cliMsgId: nextCliMsgId,
              zaloId: msg.threadId,
              threadType: msg.type as 0 | 1,
            });
          }
        }
        if (isEcho) {
          recordDurableZaloSkipped(
            'SKIPPED_BOT_ECHO',
            'Message is the Zalo echo of a Telegram-originated send.',
          );
          console.log(`[Zalo→TG] Skip bot echo (${selfMsgIds.join(', ')})`);
          return;
        }
      }

      const primaryMsgId = normalizeMessageId(msg.data.msgId);
      if (primaryMsgId) {
        if (msgStore.getTgMsgId(primaryMsgId) !== undefined || inFlightMsgIds.has(primaryMsgId)) {
          const multipartParts = listDurableZaloMultipartParts();
          const multipartCanFinalize = currentDurableZaloMultipartManifest() !== undefined
            && multipartParts.length > 0
            && multipartParts.every(part => part.status === 'SENT');
          if (!multipartCanFinalize) {
            recordDurableZaloSkipped(
              'SKIPPED_DUPLICATE_SOURCE',
              'Message was already mapped or is currently being delivered.',
            );
            console.log(`[Zalo→TG] Skip duplicate/reaction re-emit msgId=${primaryMsgId}`);
            return;
          }
          console.log(
            `[Zalo→TG] Finalize completed multipart delivery msgId=${primaryMsgId}`,
          );
        }
        markMessageInFlight(primaryMsgId);
      }

      const zaloId     = msg.threadId;
      const type       = msg.type as 0 | 1;
      const senderName = msg.data.dName ?? msg.data.uidFrom;
      const msgType    = msg.data.msgType ?? ZALO_MSG_TYPES.TEXT;

      const muteState = await isMutedZaloConversation(api, zaloId, type);
      const strangerState = type === ThreadType.User && config.zalo.skipStrangerMessages
        ? await isStrangerZaloUser(api, zaloId)
        : false;
      const policy = decideZaloConversationPolicy({
        type,
        muteState,
        strangerState,
        skipMutedGroups: config.zalo.skipMutedGroups,
        skipStrangerMessages: config.zalo.skipStrangerMessages,
      });
      const forwardSilently = policy.silent;
      if (!policy.forward && policy.reason === 'muted_group') {
        recordDurableZaloSkipped(
          'SKIPPED_MUTED_GROUP',
          'Message skipped by the configured muted-group policy.',
        );
        console.log(`[Zalo→TG] Skip muted group ${zaloId}`);
        return;
      }
      if (!policy.forward && policy.reason === 'stranger_dm') {
        recordDurableZaloSkipped(
          'SKIPPED_STRANGER_DM',
          'Message skipped by the configured stranger-message policy.',
        );
        console.log(`[Zalo→TG] Skip stranger conversation ${zaloId}`);
        return;
      }
      if (policy.strangerStateUnknown) {
        console.warn(`[Zalo→TG] Stranger status unknown for ${zaloId}; forwarding to avoid message loss.`);
      }

      if (type === ThreadType.Group) {
        userCache.saveForGroup(msg.data.uidFrom, senderName, zaloId);
      } else {
        userCache.save(msg.data.uidFrom, senderName);
      }

      const { text, media } = parseContent(msg.data.content);

      const eagerMediaUrl = (() => {
        if (msgType === ZALO_MSG_TYPES.VIDEO || msgType === ZALO_MSG_TYPES.VOICE ||
            msgType === ZALO_MSG_TYPES.GIF   || msgType === ZALO_MSG_TYPES.FILE) return media.href;
        return undefined;
      })();
      const extGuess = eagerMediaUrl
        ? (path.extname(eagerMediaUrl.split('?')[0] ?? '').toLowerCase() || '.bin')
        : '.bin';
      const earlyDlPromise = eagerMediaUrl && !isDurableZaloDelivery()
        ? downloadToTemp(eagerMediaUrl, `dl_${Date.now()}${extGuess}`)
        : null;

      let displayName = senderName;
      let groupAvatarUrl: string | undefined;
      if (type === ThreadType.Group) {
        const info = getCachedGroupInfo(zaloId);
        displayName = info?.name || senderName;
        groupAvatarUrl = info?.avt;
        if (!info) {
          void refreshCachedGroupInfo(api, zaloId).catch(() => undefined);
        }
      } else {
        const aliasName = aliasCache.get(zaloId);
        const realName = aliasName ?? getCachedUserDisplayName(zaloId, senderName);
        displayName = aliasName ?? aliasCache.label(zaloId, realName);
        if (!aliasName && !userCache.getName(zaloId)?.trim()) {
          void resolveUserDisplayName(api, zaloId, senderName).catch(() => undefined);
        }
      }

      const topicId = await getOrCreateTopic(zaloId, type, displayName, groupAvatarUrl);

      let tgReplyMsgId: number | undefined;
      if (msg.data.quote) {
        const globalId = String(msg.data.quote.globalMsgId);
        tgReplyMsgId = msgStore.getTgMsgId(globalId) ?? sentMsgStore.getByZaloMsgId(globalId);
      }

      const tgBase: {
        message_thread_id: number;
        disable_notification?: boolean;
        reply_parameters?: { message_id: number; allow_sending_without_reply: boolean };
      } = {
        message_thread_id: topicId,
        ...(forwardSilently ? { disable_notification: true } : {}),
      };
      if (tgReplyMsgId !== undefined) {
        tgBase.reply_parameters = { message_id: tgReplyMsgId, allow_sending_without_reply: true };
      }

      const caption = type === ThreadType.Group ? groupCaption(senderName) : undefined;
      const tgOpts  = { ...tgBase, parse_mode: 'HTML' as const, caption };

      const zaloMsgIds = normalizeMessageIds([
        msg.data.msgId,
        msg.data.realMsgId,
        msg.data.cliMsgId,
      ]);
      const zaloQuoteData: ZaloQuoteData = {
        msgId:    normalizeMessageId(msg.data.msgId) ?? '',
        cliMsgId: normalizeMessageId(msg.data.cliMsgId) ?? '',
        uidFrom:  msg.data.uidFrom,
        ts:       msg.data.ts,
        msgType:  msgType,
        content:  msg.data.content as string | Record<string, unknown>,
        ttl:      msg.data.ttl ?? 0,
        zaloId,
        threadType: type,
      };
      const saveTgMappingOnly = (sent: { message_id: number }) => {
        msgStore.save(sent.message_id, zaloMsgIds, zaloQuoteData);
      };
      const saveTgMapping = (sent: { message_id: number }) => {
        recordDurableZaloProviderMessageId(sent.message_id);
        saveTgMappingOnly(sent);
      };

      const sendAsSplitDocumentsIfNeeded = async (
        localPath: string,
        fileName: string,
      ): Promise<boolean> => {
        const existingManifest = currentDurableZaloMultipartManifest();
        const partSizeBytes = existingManifest?.partSizeBytes
          ?? config.telegram.uploadPartBytes;
        const stableFileName = existingManifest?.originalFilename ?? fileName;
        const partPaths = await splitFileForTelegram(localPath, partSizeBytes);
        if (partPaths.length === 0) return false;
        let acceptedPartCount = 0;
        try {
          let durableParts = listDurableZaloMultipartParts();
          let durableManifest = existingManifest;
          if (isDurableZaloDelivery()) {
            const sourceMedia = currentDurableZaloMedia(0);
            const sourceIntegrity = sourceMedia?.media.sha256
              && sourceMedia.media.byteSize !== null
              ? {
                sha256: sourceMedia.media.sha256,
                byteSize: sourceMedia.media.byteSize,
              }
              : await hashFileSha256(localPath);
            const partIntegrity = await Promise.all(
              partPaths.map(partPath => hashFileSha256(partPath)),
            );
            durableManifest = ensureDurableZaloMultipartManifest({
              sourceMediaId: existingManifest?.sourceMediaId
                ?? sourceMedia?.media.id,
              sourceSha256: sourceIntegrity.sha256,
              sourceByteSize: sourceIntegrity.byteSize,
              originalFilename: stableFileName,
              partSizeBytes,
              telegramChatId: existingManifest?.telegramChatId
                ?? String(config.telegram.groupId),
              telegramThreadId: existingManifest?.telegramThreadId
                ?? tgBase.message_thread_id,
              disableNotification: existingManifest?.disableNotification
                ?? Boolean(tgBase.disable_notification),
              replyToMessageId: existingManifest?.replyToMessageId
                ?? tgBase.reply_parameters?.message_id,
              parts: partIntegrity.map((integrity, index) => ({
                partNo: index + 1,
                byteOffset: index * partSizeBytes,
                byteSize: integrity.byteSize,
                sha256: integrity.sha256,
                providerFilename: `${stableFileName}.part${String(index + 1).padStart(3, '0')}`,
              })),
            });
            durableParts = listDurableZaloMultipartParts();
          }

          const accepted = new Map<number, number>();
          for (let index = 0; index < partPaths.length; index += 1) {
            const partNo = index + 1;
            const durablePart = durableParts.find(part => part.partNo === partNo);
            if (durablePart?.status === 'UNKNOWN') {
              throw Object.assign(
                new Error(`Multipart part ${partNo} requires operator reconciliation.`),
                { code: 'MULTIPART_PART_UNKNOWN' },
              );
            }
            if (durablePart?.status === 'SENT' && durablePart.providerMessageId) {
              const existingMessageId = Number(durablePart.providerMessageId);
              if (!Number.isSafeInteger(existingMessageId) || existingMessageId <= 0) {
                throw Object.assign(
                  new Error(`Invalid Telegram receipt for multipart part ${partNo}.`),
                  { code: 'PART_RECEIPT_INVALID' },
                );
              }
              accepted.set(partNo, existingMessageId);
              acceptedPartCount = accepted.size;
              continue;
            }
            if (isDurableZaloDelivery()) {
              markDurableZaloMultipartPartSending(partNo);
            }

            let sent: { message_id: number };
            try {
              const targetBase = durableManifest ? {
                ...(durableManifest.telegramThreadId
                  ? { message_thread_id: durableManifest.telegramThreadId }
                  : {}),
                ...(durableManifest.disableNotification
                  ? { disable_notification: true }
                  : {}),
                ...(durableManifest.replyToMessageId
                  ? {
                    reply_parameters: {
                      message_id: durableManifest.replyToMessageId,
                      allow_sending_without_reply: true,
                    },
                  }
                  : {}),
              } : tgBase;
              sent = await tg.sendDocument(
                durableManifest?.telegramChatId ?? config.telegram.groupId,
                {
                  source: createReadStream(partPaths[index]!),
                  filename: durablePart?.providerFilename
                    ?? `${stableFileName}.part${String(partNo).padStart(3, '0')}`,
                },
                {
                  ...targetBase,
                  parse_mode: 'HTML',
                  ...(index === 0 ? {
                    caption: `${caption ? `${caption}\n` : ''}`
                      + `Tệp <b>${escapeHtml(stableFileName)}</b> vượt ngưỡng upload `
                      + `${Math.round(partSizeBytes / 1024 / 1024)} MB đã cấu hình, `
                      + `đã chia thành ${partPaths.length} phần. Ghép theo thứ tự `
                      + `<code>.part001</code>, <code>.part002</code>, ...`,
                  } : {}),
                },
              );
              if (isDurableZaloDelivery()) {
                recordDurableZaloProviderMessageId(sent.message_id, {
                  receiptKind: 'part',
                  ordinal: index,
                  isPrimary: index === 0,
                  providerConversationId: durableManifest?.telegramChatId,
                  providerThreadId: durableManifest?.telegramThreadId == null
                    ? undefined
                    : String(durableManifest.telegramThreadId),
                });
              }
            } catch (error) {
              if (isDurableZaloDelivery()) {
                const code = String((error as { code?: unknown }).code ?? '');
                const ambiguous = isAmbiguousProviderFailure(error)
                  || code === 'RECEIPT_WRITE_FAILED';
                markDurableZaloMultipartPartFailure(
                  partNo,
                  ambiguous ? 'UNKNOWN' : 'PENDING',
                  error,
                );
              }
              throw error;
            }
            accepted.set(partNo, sent.message_id);
            acceptedPartCount = accepted.size;
          }

          const firstMessageId = accepted.get(1);
          if (firstMessageId === undefined) {
            throw Object.assign(
              new Error('Multipart delivery completed without a primary Telegram receipt.'),
              { code: 'MULTIPART_PRIMARY_RECEIPT_MISSING' },
            );
          }
          saveTgMappingOnly({ message_id: firstMessageId });
          return true;
        } catch (error) {
          const sentPartCount = Math.max(
            acceptedPartCount,
            listDurableZaloMultipartParts().filter(part => part.status === 'SENT').length,
          );
          if (sentPartCount > 0) {
            throw Object.assign(
              new Error(
                `Telegram accepted ${sentPartCount}/${partPaths.length} part(s) of a split file.`,
                { cause: error },
              ),
              { code: 'PARTIAL_CHUNK_UPLOAD' },
            );
          }
          throw error;
        } finally {
          await Promise.all(partPaths.map(partPath => cleanTemp(partPath)));
        }
      };

      if (msgType === ZALO_MSG_TYPES.TEXT || (text !== null)) {
        const body = text ?? (typeof msg.data.content === 'string' ? msg.data.content : '');
        if (!body.trim()) {
          recordInvalidSourcePayload('Zalo text message has no content.');
          return;
        }
        const mentions = msg.data.mentions;
        const bodyHtml = mentions?.length
          ? applyMentionsHtml(truncate(body), mentions)
          : escapeHtml(truncate(body));
        const tgText = type === ThreadType.Group
          ? formatGroupMsgHtml(senderName, bodyHtml)
          : bodyHtml;
        const sent = await tg.sendMessage(
          config.telegram.groupId,
          tgText,
          { ...tgBase, parse_mode: 'HTML' },
        );
        saveTgMapping(sent);
        return;
      }

      if (msgType === ZALO_MSG_TYPES.PHOTO) {
        let url = media.href;
        if (media.params) {
          try {
            const p = JSON.parse(media.params) as { hd?: string };
            if (p.hd) url = p.hd;
          } catch { /* ignore */ }
        }
        if (!url) {
          console.warn('[ZaloHandler] Photo: no URL found in content:', media);
          recordInvalidSourcePayload('Zalo photo message has no media URL.');
          return;
        }

        const photoCaption = media.description?.trim() || undefined;
        const albumKey = `${zaloId}:${msg.data.uidFrom}`;

        if (isDurableZaloDelivery()) {
          const localPath = await (earlyDlPromise ?? downloadZaloMediaDurably(url, `photo_${Date.now()}.jpg`));
          try {
            const sent = await sendWithTopicRecovery(
              zaloId,
              type,
              displayName,
              groupAvatarUrl,
              topic => tg.sendPhoto(
                config.telegram.groupId,
                { source: createReadStream(localPath) },
                {
                  ...tgBase,
                  message_thread_id: topic,
                  parse_mode: 'HTML' as const,
                  caption: type === ThreadType.Group
                    ? photoCaption
                      ? `${groupCaption(senderName)}\n${escapeHtml(photoCaption)}`
                      : groupCaption(senderName)
                    : photoCaption ? escapeHtml(photoCaption) : undefined,
                },
              ),
              topicId,
            );
            saveTgMapping(sent);
          } finally {
            await cleanTemp(localPath);
          }
          return;
        }

        keepInFlightUntilTtl = true;
        zaloAlbumStore.add(
          albumKey,
          url,
          zaloMsgIds[0],
          { senderName, topicId, tgBase, zaloQuote: zaloQuoteData },
          async (buf) => {
            try {
              if (buf.urls.length === 1) {
                const singleUrl = buf.urls[0]!;
                const localPath = await (earlyDlPromise ?? downloadToTemp(singleUrl, `photo_${Date.now()}.jpg`));
                try {
                  const sent = await sendWithTopicRecovery(
                    zaloId,
                    type,
                    displayName,
                    groupAvatarUrl,
                    topic => tg.sendPhoto(
                      config.telegram.groupId,
                      { source: createReadStream(localPath) },
                      {
                        ...buf.tgBase,
                        message_thread_id: topic,
                        parse_mode: 'HTML' as const,
                        caption: type === ThreadType.Group
                          ? photoCaption
                            ? `${groupCaption(buf.senderName)}\n${escapeHtml(photoCaption)}`
                            : groupCaption(buf.senderName)
                          : photoCaption ? escapeHtml(photoCaption) : undefined,
                      },
                    ),
                    buf.topicId,
                  );
                  msgStore.save(sent.message_id, buf.zaloMsgIds, {
                    msgId: buf.zaloMsgIds[0]!,
                    cliMsgId: '',
                    uidFrom: msg.data.uidFrom,
                    ts: msg.data.ts,
                    msgType,
                    content: msg.data.content as string | Record<string, unknown>,
                    ttl: msg.data.ttl ?? 0,
                    zaloId,
                    threadType: type,
                  });
                } finally { await cleanTemp(localPath); }
              } else {
                const localPaths: string[] = [];
                try {
                  const dlResults = await Promise.allSettled(buf.urls.map(u => downloadToTemp(u, `photo_${Date.now()}.jpg`)));
                  const dlPaths = dlResults.flatMap(r => {
                    if (r.status === 'fulfilled') return [r.value];
                    console.warn('[ZaloHandler] Album: skipping failed photo download:', r.reason);
                    return [];
                  });
                  if (dlPaths.length === 0) return;
                  localPaths.push(...dlPaths);
                  const captionText = type === ThreadType.Group
                    ? photoCaption
                      ? `${groupCaption(buf.senderName)}\n${escapeHtml(photoCaption)}`
                      : groupCaption(buf.senderName)
                    : photoCaption ? escapeHtml(photoCaption) : undefined;
                  const BATCH = 10;
                  let activeAlbumTopicId = buf.topicId;
                  for (let i = 0; i < localPaths.length; i += BATCH) {
                    const batch = localPaths.slice(i, i + BATCH);
                    const firstItemCaption = i === 0 ? captionText : undefined;
                    const sentMsgs = await sendWithTopicRecovery(
                      zaloId,
                      type,
                      displayName,
                      groupAvatarUrl,
                      topic => batch.length === 1
                        ? tg.sendPhoto(
                            config.telegram.groupId,
                            { source: createReadStream(batch[0]!) },
                            {
                              message_thread_id: topic,
                              ...(firstItemCaption ? { caption: firstItemCaption, parse_mode: 'HTML' as const } : {}),
                            },
                          ).then(sent => [sent])
                        : tg.sendMediaGroup(
                            config.telegram.groupId,
                            batch.map((lp, j) => ({
                              type: 'photo' as const,
                              media: { source: createReadStream(lp) },
                              ...(j === 0 && firstItemCaption ? { caption: firstItemCaption, parse_mode: 'HTML' as const } : {}),
                            })),
                            { message_thread_id: topic } as Parameters<typeof tg.sendMediaGroup>[2],
                          ),
                      activeAlbumTopicId,
                      topic => { activeAlbumTopicId = topic; },
                    );
                    for (let j = 0; j < sentMsgs.length; j++) {
                      const sourceMsgId = buf.zaloMsgIds[i + j];
                      const sent = sentMsgs[j];
                      if (!sourceMsgId || !sent || !buf.zaloQuote) continue;
                      msgStore.save(sent.message_id, [sourceMsgId], {
                        ...buf.zaloQuote,
                        msgId: sourceMsgId,
                      });
                    }
                  }
                } finally {
                  for (const lp of localPaths) await cleanTemp(lp);
                }
              }
            } finally {
              unmarkMessagesInFlight(buf.zaloMsgIds);
            }
          },
        );

        return;
      }

      if (msgType === ZALO_MSG_TYPES.DOODLE) {
        const url = media.href || media.thumb;
        if (!url) {
          console.warn('[ZaloHandler] Doodle: no URL');
          recordInvalidSourcePayload('Zalo doodle message has no media URL.');
          return;
        }
        const localPath = await downloadZaloMediaDurably(url, `doodle_${Date.now()}.jpg`);
        const stream = createReadStream(localPath);
        try {
          const sent = await tg.sendPhoto(config.telegram.groupId, { source: stream }, tgOpts);
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      if (msgType === ZALO_MSG_TYPES.GIF) {
        const url = media.href;
        if (!url) {
          console.warn('[ZaloHandler] GIF: no URL found in content:', media);
          recordInvalidSourcePayload('Zalo GIF message has no media URL.');
          return;
        }
        const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.mp4';
        const localPath = await (earlyDlPromise ?? downloadZaloMediaDurably(url, `gif_${Date.now()}${ext}`));
        try {
          if (await sendAsSplitDocumentsIfNeeded(localPath, `animation${ext}`)) return;
          const stream = createReadStream(localPath);
          const sent = await tg.sendAnimation(
            config.telegram.groupId,
            { source: stream },
            tgOpts,
          );
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      if (msgType === ZALO_MSG_TYPES.FILE) {
        const url = media.href;
        const fileName = media.title ?? `file_${Date.now()}`;
        if (!url) {
          console.warn('[ZaloHandler] File: no URL found in content:', media);
          recordInvalidSourcePayload('Zalo file message has no media URL.');
          return;
        }
        const localPath = await (earlyDlPromise ?? downloadZaloMediaDurably(url, fileName));
        try {
          if (await sendAsSplitDocumentsIfNeeded(localPath, fileName)) return;
          const sent = await tg.sendDocument(
            config.telegram.groupId,
            { source: createReadStream(localPath), filename: fileName },
            tgOpts,
          );
          saveTgMapping(sent);
        } finally {
          await cleanTemp(localPath);
        }
        return;
      }

      if (msgType === ZALO_MSG_TYPES.VIDEO) {
        const url = media.href;
        if (!url) {
          console.warn('[ZaloHandler] Video: no URL found in content:', media);
          recordInvalidSourcePayload('Zalo video message has no media URL.');
          return;
        }
        const fileName = `video_${Date.now()}.mp4`;
        const localPath = await (earlyDlPromise ?? downloadZaloMediaDurably(url, fileName));
        try {
          if (await sendAsSplitDocumentsIfNeeded(localPath, fileName)) return;
          const stream = createReadStream(localPath);
          const sent = await tg.sendVideo(config.telegram.groupId, { source: stream }, tgOpts);
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      if (msgType === ZALO_MSG_TYPES.VOICE) {
        const url = media.href;
        if (!url) {
          console.warn('[ZaloHandler] Voice: no URL found in content:', media);
          recordInvalidSourcePayload('Zalo voice message has no media URL.');
          return;
        }
        const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.m4a';
        const fileName = `voice_${Date.now()}${ext}`;
        const localPath = await (earlyDlPromise ?? downloadZaloMediaDurably(url, fileName));
        try {
          if (await sendAsSplitDocumentsIfNeeded(localPath, fileName)) return;
          const stream = createReadStream(localPath);
          const sent = await tg.sendVoice(config.telegram.groupId, { source: stream }, tgOpts);
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      if (msgType === ZALO_MSG_TYPES.STICKER) {
        const stickerId = media.id;
        if (!stickerId) {
          console.warn('[ZaloHandler] Sticker: no id in content:', media);
          recordInvalidSourcePayload('Zalo sticker message has no sticker ID.');
          return;
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const details: any[] = await runZaloRequest(
            { label: `getStickersDetail(${stickerId})`, priority: 'low', maxRetries: 0 },
            () => api.getStickersDetail([stickerId]),
          );
          const detail = details?.[0];
          const url: string | undefined =
            detail?.stickerWebpUrl ?? detail?.stickerUrl ?? detail?.stickerSpriteUrl;
          if (!url) {
            console.warn('[ZaloHandler] Sticker: no URL in detail:', detail);
            recordDurableZaloFailure(Object.assign(
              new Error('Zalo sticker detail has no downloadable URL.'),
              { code: 'STICKER_URL_MISSING' },
            ));
            return;
          }
          const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.webp';
          const localPath = await downloadZaloMediaDurably(url, `sticker_${Date.now()}${ext}`);
          try {
            let sent: { message_id: number };
            try {
              const stream = createReadStream(localPath);
              sent = await tg.sendSticker(
                config.telegram.groupId,
                { source: stream },
                tgBase as Parameters<typeof tg.sendSticker>[2],
              );
            } catch (stickerSendError) {
              if (isAmbiguousProviderFailure(stickerSendError)) throw stickerSendError;
              const stream = createReadStream(localPath);
              sent = await tg.sendPhoto(config.telegram.groupId, { source: stream }, tgOpts);
            }
            saveTgMapping(sent);
          } finally { await cleanTemp(localPath); }
        } catch (stickerErr) {
          if (isTopicDeletedError(stickerErr)) {
            const staleTopicId = store.getTopicByZalo(zaloId, type);
            if (staleTopicId !== undefined) {
              console.warn(`[Zalo→TG] Topic ${staleTopicId} was deleted — removing stale mapping for ${zaloId}`);
              store.remove(staleTopicId);
            }
            throw stickerErr;
          } else {
            throw stickerErr;
          }
        }
        return;
      }

      if (msgType === ZALO_MSG_TYPES.LINK) {
        const href  = media.href;
        const title = media.title ?? href;
        if (!href) {
          recordInvalidSourcePayload('Zalo link message has no URL.');
          return;
        }
        const hrefAttr = escapeHtml(href).replace(/"/g, '&quot;');
        const titleEsc = escapeHtml(title ?? href);
        const linkText = type === ThreadType.Group
          ? `${groupCaption(senderName)}\n<a href="${hrefAttr}">${titleEsc}</a>`
          : `<a href="${hrefAttr}">${titleEsc}</a>`;
        const sent = await tg.sendMessage(config.telegram.groupId, linkText, {
          ...tgBase,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: false },
        });
        saveTgMapping(sent);
        return;
      }

      if (msgType === ZALO_MSG_TYPES.WEBCONTENT) {
        if (media.action === 'zinstant.bankcard' && media.params) {
          try {
            const parsedParams = JSON.parse(media.params) as {
              pcItem?: { data_url?: string };
              item?:   { data_url?: string };
            };
            const dataUrl = parsedParams.pcItem?.data_url ?? parsedParams.item?.data_url;
            if (dataUrl) {
              const htmlResp = await fetch(`${dataUrl}?data=html`);
              const html = await htmlResp.text();
              const info = parseBankCardHtml(html);
              if (info) {
                const qrBuf = await QRCode.toBuffer(info.vietqr, {
                  width: 300, margin: 2,
                  color: { dark: '#000000ff', light: '#ffffffff' },
                });
                let caption = `🏦 <b>Tài khoản ngân hàng</b>`;
                if (info.bankName)      caption += `\nNgân hàng: <b>${escapeHtml(info.bankName)}</b>`;
                if (info.accountNumber) caption += `\nSTK: <code>${escapeHtml(info.accountNumber)}</code>`;
                if (info.holderName)    caption += `\nChủ TK: <b>${escapeHtml(info.holderName)}</b>`;
                const fullCaption = type === ThreadType.Group
                  ? `${groupCaption(senderName)}\n${caption}`
                  : caption;
                const sent = await tg.sendPhoto(
                  config.telegram.groupId,
                  { source: qrBuf },
                  { ...tgBase, caption: fullCaption, parse_mode: 'HTML' },
                );
                saveTgMapping(sent);
                return;
              }
            }
          } catch (err) {
            if (isAmbiguousProviderFailure(err)) throw err;
            console.error('[ZaloHandler] bankcard parse error:', err);
          }
        }

        let label = media.title || '';
        try {
          if (media.params) {
            const p = JSON.parse(media.params) as {
              customMsg?: { msg?: { vi?: string; en?: string } };
            };
            const vi = p.customMsg?.msg?.vi;
            const en = p.customMsg?.msg?.en;
            if (vi && vi.trim()) label = vi.trim();
            else if (en && en.trim()) label = en.trim();
          }
        } catch { /* use fallback */ }
        if (!label) label = '[Nội dung web]';

        const ACTION_ICONS: Record<string, string> = {
          'zinstant.bankcard': '🏦',
          'zinstant.transfer': '💸',
          'zinstant.invoice':  '🧾',
          'zinstant.qr':       '📷',
        };
        const icon = ACTION_ICONS[media.action ?? ''] ?? '📋';
        const body = `${icon} ${escapeHtml(label)}`;
        const msgText = type === ThreadType.Group ? `${groupCaption(senderName)}\n${body}` : body;
        const sent = await tg.sendMessage(config.telegram.groupId, msgText, {
          ...tgBase,
          parse_mode: 'HTML',
        });
        saveTgMapping(sent);
        return;
      }

      if (msgType === ZALO_MSG_TYPES.LOCATION) {
        let lat: number | undefined;
        let lng: number | undefined;
        try {
          const p = JSON.parse(media.params ?? '{}') as { latitude?: number; longitude?: number };
          lat = p.latitude;
          lng = p.longitude;
        } catch { /* ignore */ }

        if (lat !== undefined && lng !== undefined) {
          const sent = await tg.sendLocation(
            config.telegram.groupId,
            lat,
            lng,
            { ...tgBase } as Parameters<typeof tg.sendLocation>[3],
          );
          if (type === ThreadType.Group) {
            try {
              const captionMessage = await tg.sendMessage(
                config.telegram.groupId,
                `${groupCaption(senderName)}📍 Vị trí`,
                { ...tgBase, parse_mode: 'HTML' },
              );
              recordDurableZaloProviderMessageId(captionMessage.message_id, {
                receiptKind: 'auxiliary',
                ordinal: 1,
                isPrimary: false,
              });
            } catch (captionError) {
              console.warn('[Zalo→TG] Location was delivered but its optional group caption failed:', captionError);
            }
          }
          saveTgMapping(sent);
        } else {
          const mapsUrl = media.href || '#';
          const mapsAttr = escapeHtml(mapsUrl).replace(/"/g, '&quot;');
          const body    = `📍 <a href="${mapsAttr}">Vị trí</a>`;
          const msgText = type === ThreadType.Group ? `${groupCaption(senderName)}\n${body}` : body;
          const sent    = await tg.sendMessage(config.telegram.groupId, msgText, { ...tgBase, parse_mode: 'HTML' });
          saveTgMapping(sent);
        }
        return;
      }

      if (msgType === ZALO_MSG_TYPES.POLL) {
        let pollId: number | undefined;
        let question = '';
        let isAnonymous = false;
        let action = '';
        try {
          const p = JSON.parse(media.params ?? '{}') as {
            pollId?: number;
            question?: string;
            isAnonymous?: boolean;
            action?: string;
          };
          pollId      = p.pollId;
          question    = p.question ?? '';
          isAnonymous = p.isAnonymous ?? false;
          action      = media.action ?? '';
        } catch { /* ignore */ }

        console.log(`[ZaloHandler] Poll event: action="${action}" pollId=${pollId}`);

        if (!pollId) {
          recordInvalidSourcePayload('Zalo poll message has no poll ID.');
          return;
        }

        let pollDetail: Awaited<ReturnType<typeof api.getPollDetail>> | undefined;
        try {
          pollDetail = await runZaloRequest(
            { label: `getPollDetail(${pollId})`, priority: 'low', maxRetries: 0 },
            () => api.getPollDetail(pollId),
          );
          console.log(`[ZaloHandler] Poll detail: num_vote=${pollDetail?.num_vote} options=`, pollDetail?.options?.map((o: { content: string; votes: number }) => `${o.content}=${o.votes}`).join(','));
        } catch (e) {
          console.warn('[ZaloHandler] getPollDetail failed:', e);
        }

        const existingEntry = pollStore.getByPollId(pollId);
        console.log(`[ZaloHandler] Poll existingEntry=${existingEntry ? 'found' : 'NOT found'}`);
        type ZaloPollOption = { option_id: number; content: string; votes: number; voted: boolean; voters: string[] };

        if (action === 'create' && !existingEntry) {
          const options: ZaloPollOption[] = pollDetail?.options ?? [];
          if (options.length < 2) {
            const body = type === ThreadType.Group
              ? `${groupCaption(senderName)}📊 <b>${escapeHtml(question)}</b>\n<i>Cuộc bình chọn mới (${options.length} lựa chọn)</i>`
              : `📊 <b>${escapeHtml(question)}</b>`;
            const sent = await tg.sendMessage(config.telegram.groupId, body, { ...tgBase, parse_mode: 'HTML' });
            saveTgMapping(sent);
            return;
          }

          const header = type === ThreadType.Group
            ? `${senderName} tạo bình chọn`
            : 'Bình chọn mới';

          const tgPollMsg = await tg.sendPoll(
            config.telegram.groupId,
            question,
            options.map(o => o.content),
            {
              ...tgBase,
              is_anonymous:        isAnonymous,
              allows_multiple_answers: pollDetail?.allow_multi_choices ?? false,
              question_parse_mode: undefined,
            } as Parameters<typeof tg.sendPoll>[3],
          );
          saveTgMapping(tgPollMsg);

          const scoreText = buildScoreText(header, pollDetail?.options ?? [], pollDetail?.closed ?? false);
          let tgScoreMsgId = tgPollMsg.message_id;
          try {
            const tgScoreMsg = await tg.sendMessage(
              config.telegram.groupId,
              scoreText,
              { ...tgBase, parse_mode: 'HTML' },
            );
            tgScoreMsgId = tgScoreMsg.message_id;
            recordDurableZaloProviderMessageId(tgScoreMsg.message_id, {
              receiptKind: 'auxiliary',
              ordinal: 1,
              isPrimary: false,
            });
          } catch (scoreError) {
            console.warn('[Zalo→TG] Poll was delivered but its optional score message failed:', scoreError);
          }

          pollStore.save({
            pollId,
            zaloGroupId:  zaloId,
            tgPollMsgId:  tgPollMsg.message_id,
            tgPollUUID:   (tgPollMsg as { poll?: { id?: string } }).poll?.id ?? '',
            tgScoreMsgId,
            tgThreadId:   topicId,
            options: options.map(o => ({ option_id: o.option_id, content: o.content })),
          });
        } else {
          await new Promise(r => setTimeout(r, 800));
          let updatedDetail = pollDetail;
          try {
            updatedDetail = await runZaloRequest(
              { label: `getPollDetail(${pollId}:update)`, priority: 'low', maxRetries: 0 },
              () => api.getPollDetail(pollId),
            );
          } catch { /* use existing */ }
          const header = type === ThreadType.Group
            ? `${senderName} vừa bình chọn`
            : 'Cập nhật bình chọn';
          const detailOptions = updatedDetail?.options ?? [];
          const scoreText = buildScoreText(
            header,
            detailOptions.length > 0 ? detailOptions : (existingEntry?.options.map(o => ({ ...o, votes: 0, voted: false, voters: [] })) ?? []),
            updatedDetail?.closed ?? false,
          );
          console.log(`[ZaloHandler] Poll ${pollId} score:`, detailOptions.map((o: { content: string; votes: number }) => `${o.content}=${o.votes}`).join(', '));

          if (existingEntry) {
            try {
              await tg.editMessageText(
                config.telegram.groupId,
                existingEntry.tgScoreMsgId,
                undefined,
                scoreText,
                {
                  parse_mode: 'HTML',
                  reply_markup: updatedDetail?.closed
                    ? { inline_keyboard: [] }
                    : { inline_keyboard: [[{ text: '🔒 Khoá bình chọn', callback_data: `lock_poll:${pollId}` }]] },
                },
              );
              recordDurableZaloProviderMessageId(existingEntry.tgScoreMsgId, {
                receiptKind: 'edit',
                ordinal: 0,
                isPrimary: true,
              });
              console.log(`[ZaloHandler] Poll ${pollId} score message edited OK`);
            } catch (editErr) {
              if (isAmbiguousProviderFailure(editErr)) throw editErr;
              console.warn(`[ZaloHandler] Poll ${pollId} edit failed, sending new:`, editErr);
              const newScore = await tg.sendMessage(
                config.telegram.groupId,
                scoreText,
                { message_thread_id: existingEntry.tgThreadId, parse_mode: 'HTML',
                  reply_parameters: { message_id: existingEntry.tgPollMsgId, allow_sending_without_reply: true } },
              );
              recordDurableZaloProviderMessageId(newScore.message_id, {
                receiptKind: 'primary',
                ordinal: 0,
                isPrimary: true,
              });
              pollStore.updateScoreMsg(pollId, newScore.message_id);
            }
          } else {
            const sent = await tg.sendMessage(
              config.telegram.groupId,
              scoreText,
              { ...tgBase, parse_mode: 'HTML' },
            );
            saveTgMapping(sent);
          }
        }
        return;
      }

      {
        const rawContent = msg.data.content;
        const contactUid: string | undefined =
          (typeof rawContent === 'object' && rawContent !== null && 'contactUid' in rawContent)
            ? String((rawContent as Record<string, unknown>).contactUid)
            : (media.contactUid ? String(media.contactUid) : undefined);

        if (contactUid || msgType === ZALO_MSG_TYPES.CONTACT) {
          const uid = contactUid ?? '';
          let contactName = userCache.getName(uid) ?? uid;
          if (uid && contactName === uid) {
            try {
              const resp = await runZaloRequest(
                { label: `getUserInfo(contact:${uid})`, priority: 'low', maxRetries: 0 },
                () => api.getUserInfo(uid),
              ) as {
                changed_profiles?: Record<string, { displayName?: string }>;
              };
              contactName = resp?.changed_profiles?.[uid]?.displayName ?? uid;
              if (contactName !== uid) userCache.save(uid, contactName);
            } catch { /* non-fatal */ }
          }
          const qrUrl: string | undefined =
            (typeof rawContent === 'object' && rawContent !== null && 'qrCodeUrl' in rawContent)
              ? String((rawContent as Record<string, unknown>).qrCodeUrl)
              : media.qrCodeUrl;

          const body = `👤 <b>Danh thiếp</b>\nTên: <b>${escapeHtml(contactName)}</b>\nZalo ID: <code>${uid}</code>`;
          const fullText = type === ThreadType.Group ? `${groupCaption(senderName)}\n${body}` : body;

          if (qrUrl) {
            try {
              const localPath = await downloadZaloMediaDurably(qrUrl, `qr_${Date.now()}.jpg`);
              const stream = createReadStream(localPath);
              const sent = await tg.sendPhoto(
                config.telegram.groupId,
                { source: stream },
                { ...tgBase, caption: fullText, parse_mode: 'HTML' },
              );
              saveTgMapping(sent);
              await cleanTemp(localPath);
            } catch (qrError) {
              if (isAmbiguousProviderFailure(qrError)) throw qrError;
              const sent = await tg.sendMessage(config.telegram.groupId, fullText, { ...tgBase, parse_mode: 'HTML' });
              saveTgMapping(sent);
            }
          } else {
            const sent = await tg.sendMessage(config.telegram.groupId, fullText, { ...tgBase, parse_mode: 'HTML' });
            saveTgMapping(sent);
          }
          return;
        }
      }

      console.log(`[ZaloHandler] Unhandled msgType="${msgType}" content:`, JSON.stringify(msg.data.content));
      const fallback = type === ThreadType.Group
        ? `${groupCaption(senderName)}\n<i>[${msgType}]</i>`
        : `<i>[${msgType}]</i>`;
      const sentFallback = await tg.sendMessage(config.telegram.groupId, fallback, {
        ...tgBase,
        parse_mode: 'HTML',
      });
      saveTgMapping(sentFallback);
    } catch (err) {
      if (isTopicDeletedError(err)) {
        const staleTopicId = store.getTopicByZalo(msg.threadId, msg.type as 0 | 1);
        if (staleTopicId !== undefined) {
          console.warn(`[Zalo→TG] Topic ${staleTopicId} was deleted — removing stale mapping for ${msg.threadId}`);
          store.remove(staleTopicId);
        }
        if (topicRetryAttempt === 0) {
          unmarkMessageInFlight(normalizeMessageId(msg.data.msgId));
          await handleZaloMessage(api, msg, 1);
        } else {
          recordDurableZaloFailure(err);
          console.error('[ZaloHandler] Topic recovery failed after one retry:', err);
        }
      } else {
        recordDurableZaloFailure(err);
        console.error('[ZaloHandler] Error:', err);
      }
    } finally {
      if (!keepInFlightUntilTtl) unmarkMessageInFlight(normalizeMessageId(msg.data.msgId));
    }
}
