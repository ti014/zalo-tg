import { ThreadType } from 'zca-js';
import path from 'path';
import QRCode from 'qrcode';

import type { ZaloAPI, ZaloMessage } from './types.js';
import { ZALO_MSG_TYPES } from './types.js';
import { store, msgStore, userCache, pollStore, sentMsgStore, pendingSendStore, zaloAlbumStore, aliasCache, type ZaloQuoteData } from '../store/index.js';
import { config } from '../config.js';
import {
  cleanTemp,
  convertSpriteSheetToGif,
  downloadToTemp,
  downloadToTempFromCandidates,
  hashFileSha256,
  splitFileForTelegram,
} from '../utils/media.js';
import {
  applyZaloMarkupHtml,
  formatGroupMsgHtml,
  groupCaption,
  truncate,
  escapeHtml,
  type ZaloStyle,
} from '../utils/format.js';
import {
  buildScoreText,
  getCachedGroupInfo,
  parseBankCardHtml,
  parseContent,
  refreshCachedGroupInfo,
  resolveUserDisplayName,
  canRetryMemberCache,
  ensureGroupMemberCache,
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
import { resolveTelegramReplyTarget } from '../domain/zalo-reply.js';
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
import {
  resolveZaloLinkContent,
  resolveZaloPhotoContent,
  resolveZaloTextBody,
} from './message-content.js';
import { maybeAutoReply } from './auto-reply.js';
import { parseDeletedZaloMessages, parseEcard, parseMissedCall } from './system-events.js';
import {
  sendTelegramAnimationWithFallback,
  telegramDocumentInput,
  telegramMediaInput,
  withTelegramMediaFallback,
} from '../telegram/media-input.js';

const inFlightMsgIds = new Map<string, ReturnType<typeof setTimeout>>();
const IN_FLIGHT_MSG_TTL_MS = 90_000;

function sendTelegramPhotoFile(
  filePath: string,
  options: Parameters<typeof tg.sendPhoto>[2],
  label = 'Photo upload',
) {
  return withTelegramMediaFallback(
    forceMultipart => tg.sendPhoto(
      config.telegram.groupId,
      telegramMediaInput(filePath, forceMultipart),
      options,
    ),
    label,
  );
}

function sendTelegramDocumentFile(
  filePath: string,
  fileName: string,
  options: Parameters<typeof tg.sendDocument>[2],
  label = 'Document upload',
  chatId: string | number = config.telegram.groupId,
) {
  return withTelegramMediaFallback(
    forceMultipart => tg.sendDocument(
      chatId,
      telegramDocumentInput(filePath, fileName, forceMultipart),
      options,
    ),
    label,
  );
}

function sendTelegramAnimationFile(
  filePath: string,
  fileName: string,
  options: Parameters<typeof tg.sendAnimation>[2],
): Promise<{ message_id: number }> {
  return sendTelegramAnimationWithFallback<{ message_id: number }>(
    filePath,
    fileName,
    {
      animation: media => tg.sendAnimation(config.telegram.groupId, media, options),
      video: media => tg.sendVideo(
        config.telegram.groupId,
        media,
        options as Parameters<typeof tg.sendVideo>[2],
      ),
      document: media => tg.sendDocument(
        config.telegram.groupId,
        media,
        options as Parameters<typeof tg.sendDocument>[2],
      ),
    },
  );
}

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
            sentMsgStore.append(pendingTgMsgId, {
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
      const ownUid = String(api.getOwnId?.() ?? '');
      const senderUid = msg.isSelf && ownUid ? ownUid : (msg.data.uidFrom ?? '');
      const providerSenderName = msg.isSelf ? 'Bạn' : (msg.data.dName ?? senderUid);
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
        muteSilent: config.zalo.muteSilent,
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

      if (
        type === ThreadType.Group
        && canRetryMemberCache(zaloId)
      ) {
        void ensureGroupMemberCache(api, zaloId).catch(error => {
          console.warn('[Zalo] Lazy member-cache warmup failed:', error);
        });
      }

      const { text, media } = parseContent(msg.data.content);
      if (!msg.isSelf && text !== null && type === ThreadType.User) {
        void maybeAutoReply(api, zaloId, type).catch(error => {
          console.warn('[AutoReply] Unexpected error:', error);
        });
      }

      const eagerMediaUrl = (() => {
        if (msgType === ZALO_MSG_TYPES.VIDEO || msgType === ZALO_MSG_TYPES.VOICE
            || msgType === ZALO_MSG_TYPES.FILE) return media.href;
        return undefined;
      })();
      const extGuess = eagerMediaUrl
        ? (path.extname(eagerMediaUrl.split('?')[0] ?? '').toLowerCase() || '.bin')
        : '.bin';
      const earlyDlPromise = eagerMediaUrl && !isDurableZaloDelivery()
        ? downloadToTemp(eagerMediaUrl, `dl_${Date.now()}${extGuess}`)
        : null;

      const senderName = msg.isSelf
        ? 'Bạn'
        : await resolveUserDisplayName(
          api,
          senderUid,
          providerSenderName || 'ai đó',
          type === ThreadType.Group ? zaloId : undefined,
        );
      if (senderUid) {
        if (type === ThreadType.Group) userCache.saveForGroup(senderUid, senderName, zaloId);
        else userCache.save(senderUid, senderName);
      }

      let displayName = senderName;
      let groupAvatarUrl: string | undefined;
      if (type === ThreadType.Group) {
        const info = getCachedGroupInfo(zaloId) ?? await refreshCachedGroupInfo(api, zaloId);
        displayName = info?.name || senderName;
        groupAvatarUrl = info?.avt;
      } else {
        displayName = await resolveUserDisplayName(api, zaloId, providerSenderName);
      }

      const topicId = await getOrCreateTopic(zaloId, type, displayName, groupAvatarUrl);

      let tgReplyMsgId: number | undefined;
      if (msg.data.quote) {
        tgReplyMsgId = resolveTelegramReplyTarget(
          msg.data.quote,
          zaloId,
          type,
          {
            incomingTelegramId: alias => msgStore.getTgMsgId(alias),
            incomingConversation: telegramMessageId => msgStore.getQuote(telegramMessageId),
            sentTelegramId: alias => sentMsgStore.getByZaloMsgId(alias),
            sentConversation: telegramMessageId => sentMsgStore.get(telegramMessageId),
          },
        );
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

      const caption = groupCaption(senderName);
      const tgOpts  = { ...tgBase, parse_mode: 'HTML' as const, caption };

      const zaloMsgIds = normalizeMessageIds([
        msg.data.msgId,
        msg.data.realMsgId,
        msg.data.cliMsgId,
      ]);
      const zaloQuoteData: ZaloQuoteData = {
        msgId:    normalizeMessageId(msg.data.msgId) ?? '',
        cliMsgId: normalizeMessageId(msg.data.cliMsgId) ?? '',
        uidFrom:  senderUid,
        ts:       msg.data.ts,
        msgType:  msgType,
        content:  text !== null
          ? (msg.data.content as string)
          : (media as Record<string, unknown>),
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
              sent = await sendTelegramDocumentFile(
                partPaths[index]!,
                durablePart?.providerFilename
                  ?? `${stableFileName}.part${String(partNo).padStart(3, '0')}`,
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
                `Split document part ${partNo}`,
                durableManifest?.telegramChatId ?? config.telegram.groupId,
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
        const body = resolveZaloTextBody(text, msg.data.content, media);
        if (!body.trim()) {
          recordInvalidSourcePayload('Zalo text message has no content.');
          return;
        }
        const safeBody = truncate(body);
        let styles: ZaloStyle[] | undefined;
        for (const rawProperties of [msg.data.textProperties, media.params]) {
          try {
            if (!rawProperties) continue;
            const parsed = JSON.parse(rawProperties) as { styles?: ZaloStyle[] };
            if (Array.isArray(parsed.styles) && parsed.styles.length > 0) {
              styles = parsed.styles;
              break;
            }
          } catch { /* Ignore malformed provider style metadata. */ }
        }

        const safeStyles = styles
          ?.filter(style => style.start < safeBody.length)
          .map(style => ({
            ...style,
            len: Math.min(style.len, safeBody.length - style.start),
          }));
        const safeMentions = msg.data.mentions
          ?.filter(mention => mention.pos < safeBody.length)
          .map(mention => ({
            ...mention,
            len: Math.min(mention.len, safeBody.length - mention.pos),
            label: mention.type === 0
              ? `@${aliasCache.get(mention.uid) ?? userCache.getNameInGroup(mention.uid, zaloId) ?? userCache.getName(mention.uid) ?? safeBody.slice(mention.pos, mention.pos + mention.len).replace(/^@/, '')}`
              : undefined,
          }));
        const bodyHtml = safeMentions?.length || safeStyles?.length
          ? applyZaloMarkupHtml(safeBody, safeMentions, safeStyles)
          : escapeHtml(safeBody);
        const tgText = formatGroupMsgHtml(senderName, bodyHtml);
        const sent = await tg.sendMessage(
          config.telegram.groupId,
          tgText,
          { ...tgBase, parse_mode: 'HTML' },
        );
        saveTgMapping(sent);
        return;
      }

      if (msgType === ZALO_MSG_TYPES.PHOTO) {
        const photo = resolveZaloPhotoContent(media);
        if (!photo) {
          console.warn('[ZaloHandler] Photo: no URL found in content:', media);
          recordInvalidSourcePayload('Zalo photo message has no media URL.');
          return;
        }

        const albumKey = `${zaloId}:${senderUid}`;

        if (isDurableZaloDelivery()) {
          const localPath = await downloadZaloMediaDurably(photo.urls, `photo_${Date.now()}.jpg`);
          try {
            const sent = await sendWithTopicRecovery(
              zaloId,
              type,
              displayName,
              groupAvatarUrl,
              topic => sendTelegramPhotoFile(
                localPath,
                {
                  ...tgBase,
                  message_thread_id: topic,
                  parse_mode: 'HTML' as const,
                  caption: photo.caption
                    ? `${groupCaption(senderName)}\n${escapeHtml(photo.caption)}`
                    : groupCaption(senderName),
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
          photo.urls,
          zaloMsgIds,
          photo.caption,
          { senderName, topicId, tgBase, zaloQuote: zaloQuoteData },
          async (buf) => {
            try {
              if (buf.items.length === 1) {
                const item = buf.items[0]!;
                const localPath = await downloadToTempFromCandidates(
                  item.urls,
                  `photo_${Date.now()}.jpg`,
                );
                try {
                  const sent = await sendWithTopicRecovery(
                    zaloId,
                    type,
                    displayName,
                    groupAvatarUrl,
                    topic => sendTelegramPhotoFile(
                      localPath,
                      {
                        ...buf.tgBase,
                        message_thread_id: topic,
                        parse_mode: 'HTML' as const,
                        caption: buf.caption
                          ? `${groupCaption(buf.senderName)}\n${escapeHtml(buf.caption)}`
                          : groupCaption(buf.senderName),
                      },
                    ),
                    buf.topicId,
                  );
                  if (item.zaloQuote) {
                    msgStore.save(sent.message_id, item.msgIds, item.zaloQuote);
                  }
                } finally { await cleanTemp(localPath); }
              } else {
                const localPaths: string[] = [];
                try {
                  const dlResults = await Promise.allSettled(buf.items.map(item =>
                    downloadToTempFromCandidates(item.urls, `photo_${Date.now()}.jpg`)));
                  const downloaded = dlResults.flatMap((result, index) => {
                    if (result.status === 'fulfilled') {
                      return [{ localPath: result.value, item: buf.items[index]! }];
                    }
                    console.warn('[ZaloHandler] Album: skipping failed photo download:', result.reason);
                    return [];
                  });
                  if (downloaded.length === 0) return;
                  localPaths.push(...downloaded.map(entry => entry.localPath));
                  const captionText = buf.caption
                    ? `${groupCaption(buf.senderName)}\n${escapeHtml(buf.caption)}`
                    : groupCaption(buf.senderName);
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
                        ? sendTelegramPhotoFile(
                            batch[0]!,
                            {
                              message_thread_id: topic,
                              ...(firstItemCaption ? { caption: firstItemCaption, parse_mode: 'HTML' as const } : {}),
                            },
                          ).then(sent => [sent])
                        : withTelegramMediaFallback(
                            forceMultipart => tg.sendMediaGroup(
                              config.telegram.groupId,
                              batch.map((lp, j) => ({
                                type: 'photo' as const,
                                media: telegramMediaInput(lp, forceMultipart),
                                ...(j === 0 && firstItemCaption ? { caption: firstItemCaption, parse_mode: 'HTML' as const } : {}),
                              })),
                              { message_thread_id: topic } as Parameters<typeof tg.sendMediaGroup>[2],
                            ),
                            'Photo album upload',
                          ),
                      activeAlbumTopicId,
                      topic => { activeAlbumTopicId = topic; },
                    );
                    for (let j = 0; j < sentMsgs.length; j++) {
                      const source = downloaded[i + j]?.item;
                      const sent = sentMsgs[j];
                      if (!source || !sent || !source.zaloQuote) continue;
                      msgStore.save(sent.message_id, source.msgIds, source.zaloQuote);
                    }
                  }
                } finally {
                  for (const lp of localPaths) await cleanTemp(lp);
                }
              }
            } finally {
              unmarkMessagesInFlight(buf.items.flatMap(item => item.msgIds));
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
        try {
          const sent = await sendTelegramPhotoFile(localPath, tgOpts, 'Doodle upload');
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      if (msgType === ZALO_MSG_TYPES.GIF) {
        const urls = [media.href, media.thumb]
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
        if (urls.length === 0) {
          console.warn('[ZaloHandler] GIF: no URL found in content:', media);
          recordInvalidSourcePayload('Zalo GIF message has no media URL.');
          return;
        }
        const ext = path.extname(urls[0]!.split('?')[0] ?? '').toLowerCase() || '.mp4';
        const localPath = await downloadZaloMediaDurably(urls, `gif_${Date.now()}${ext}`);
        try {
          if (await sendAsSplitDocumentsIfNeeded(localPath, `animation${ext}`)) return;
          const sent = await sendTelegramAnimationFile(localPath, `zalo_gif${ext}`, tgOpts);
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
          const sent = await sendTelegramDocumentFile(localPath, fileName, tgOpts);
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
          const sent = await withTelegramMediaFallback(
            forceMultipart => tg.sendVideo(
              config.telegram.groupId,
              telegramMediaInput(localPath, forceMultipart),
              tgOpts,
            ),
            'Video upload',
          );
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
          const sent = await withTelegramMediaFallback(
            forceMultipart => tg.sendVoice(
              config.telegram.groupId,
              telegramMediaInput(localPath, forceMultipart),
              tgOpts,
            ),
            'Voice upload',
          );
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
          let detail = details?.[0];
          const categoryId = Number(media.cateId ?? media.catId);
          if (!detail && Number.isFinite(categoryId) && categoryId > 0
              && typeof api.getStickerCategoryDetail === 'function') {
            const category = await runZaloRequest(
              {
                label: `getStickerCategoryDetail(${categoryId})`,
                priority: 'low',
                maxRetries: 0,
              },
              () => api.getStickerCategoryDetail(categoryId),
            ) as Array<{ id?: number }>;
            detail = category.find(item => Number(item.id) === Number(stickerId));
          }
          const spriteUrl = typeof detail?.stickerSpriteUrl === 'string'
            ? detail.stickerSpriteUrl
            : undefined;
          const totalFrames = Number(detail?.totalFrames);
          if (spriteUrl && Number.isFinite(totalFrames) && totalFrames > 1) {
            let spritePath: string | undefined;
            let gifPath: string | undefined;
            try {
              spritePath = await downloadZaloMediaDurably(
                spriteUrl,
                `sticker_sprite_${Date.now()}.png`,
              );
              gifPath = await convertSpriteSheetToGif(
                spritePath,
                totalFrames,
                Number(detail?.duration),
              );
              const sent = await sendTelegramAnimationFile(
                gifPath,
                `zalo_sticker_${stickerId}.gif`,
                {
                  ...tgBase,
                  caption: `${groupCaption(senderName)} <i>(sticker động)</i>`,
                  parse_mode: 'HTML',
                },
              );
              saveTgMapping(sent);
              return;
            } catch (error) {
              if (isAmbiguousProviderFailure(error)) throw error;
              console.warn(
                `[ZaloHandler] Animated sticker ${stickerId} failed; using a static fallback:`,
                error,
              );
            } finally {
              if (gifPath) await cleanTemp(gifPath);
              if (spritePath) await cleanTemp(spritePath);
            }
          }
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
              sent = await withTelegramMediaFallback(
                forceMultipart => tg.sendSticker(
                  config.telegram.groupId,
                  telegramMediaInput(localPath, forceMultipart),
                  tgBase as Parameters<typeof tg.sendSticker>[2],
                ),
                'Sticker upload',
              );
            } catch (stickerSendError) {
              if (isAmbiguousProviderFailure(stickerSendError)) throw stickerSendError;
              try {
                sent = await sendTelegramPhotoFile(
                  localPath,
                  tgOpts,
                  'Sticker photo fallback',
                );
              } catch (photoError) {
                if (isAmbiguousProviderFailure(photoError)) throw photoError;
                sent = await sendTelegramDocumentFile(
                  localPath,
                  `zalo_sticker_${stickerId}${ext}`,
                  tgOpts as Parameters<typeof tg.sendDocument>[2],
                  'Sticker document fallback',
                );
              }
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
        const missedCall = parseMissedCall(media);
        if (missedCall) {
          const sent = await tg.sendMessage(
            config.telegram.groupId,
            `${groupCaption(senderName)}\n${missedCall.video ? '📹 Cuộc gọi video nhỡ' : '📞 Cuộc gọi thoại nhỡ'}`,
            { ...tgBase, parse_mode: 'HTML' },
          );
          saveTgMapping(sent);
          return;
        }
        const link = resolveZaloLinkContent(media);
        if (!link) {
          recordInvalidSourcePayload('Zalo link message has no URL.');
          return;
        }
        const { href, title } = link;
        const hrefAttr = escapeHtml(href).replace(/"/g, '&quot;');
        const titleEsc = escapeHtml(title);
        const linkText = `${groupCaption(senderName)}\n<a href="${hrefAttr}">${titleEsc}</a>`;
        const sent = await tg.sendMessage(config.telegram.groupId, linkText, {
          ...tgBase,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: false },
        });
        saveTgMapping(sent);
        return;
      }

      if (msgType === ZALO_MSG_TYPES.ECARD) {
        const ecard = parseEcard(media);
        const lines: string[] = [groupCaption(senderName)];
        lines.push(`🎂 <b>${escapeHtml(ecard.title)}</b>`);
        if (ecard.description && ecard.description !== ecard.title) {
          lines.push(escapeHtml(ecard.description));
        }
        if (ecard.notification) lines.push(`<i>${escapeHtml(ecard.notification)}</i>`);
        const caption = lines.join('\n');
        if (ecard.imageUrl) {
          try {
            const localPath = await downloadZaloMediaDurably(ecard.imageUrl, `ecard_${Date.now()}.png`);
            try {
              const sent = await sendTelegramPhotoFile(
                localPath,
                { ...tgBase, caption, parse_mode: 'HTML' },
                'E-card upload',
              );
              saveTgMapping(sent);
            } finally {
              await cleanTemp(localPath);
            }
            return;
          } catch (error) {
            if (isAmbiguousProviderFailure(error)) throw error;
          }
        }
        const sent = await tg.sendMessage(
          config.telegram.groupId,
          caption,
          { ...tgBase, parse_mode: 'HTML' },
        );
        saveTgMapping(sent);
        return;
      }

      if (msgType === 'chat.delete') {
        const deleted = parseDeletedZaloMessages(msg.data.content);
        if (deleted.length === 0) return;
        const actorName = await resolveUserDisplayName(api, msg.data.uidFrom, 'Admin');
        for (const item of deleted) {
          const ids = [item.globalDelMsgId, item.clientDelMsgId, item.destId]
            .map(value => value === undefined || String(value) === '0' ? '' : String(value))
            .filter(Boolean);
          const telegramMessageId = ids
            .map(id => msgStore.getTgMsgId(id) ?? sentMsgStore.getByZaloMsgId(id))
            .find((id): id is number => id !== undefined);
          const text = telegramMessageId === undefined
            ? `<i>🗑 Admin <b>${escapeHtml(actorName)}</b> đã xoá một tin nhắn chưa được bridge trên Zalo</i>`
            : `<i>🗑 Tin nhắn này đã bị <b>${escapeHtml(actorName)}</b> (admin) xoá trên Zalo</i>`;
          await tg.sendMessage(
            config.telegram.groupId,
            text,
            {
              message_thread_id: topicId,
              parse_mode: 'HTML',
              ...(telegramMessageId === undefined ? {} : {
                reply_parameters: { message_id: telegramMessageId, allow_sending_without_reply: true },
              }),
            },
          );
        }
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
                const fullCaption = `${groupCaption(senderName)}\n${caption}`;
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
        const msgText = `${groupCaption(senderName)}\n${body}`;
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
            console.warn('[Zalo→TG] Location was delivered but its optional sender caption failed:', captionError);
          }
          saveTgMapping(sent);
        } else {
          const mapsUrl = media.href || '#';
          const mapsAttr = escapeHtml(mapsUrl).replace(/"/g, '&quot;');
          const body    = `📍 <a href="${mapsAttr}">Vị trí</a>`;
          const msgText = `${groupCaption(senderName)}\n${body}`;
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
            const body = `${groupCaption(senderName)}📊 <b>${escapeHtml(question)}</b>\n`
              + `<i>Cuộc bình chọn mới (${options.length} lựa chọn)</i>`;
            const sent = await tg.sendMessage(config.telegram.groupId, body, { ...tgBase, parse_mode: 'HTML' });
            saveTgMapping(sent);
            return;
          }

          const header = `${senderName} tạo bình chọn`;

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
          const header = `${senderName} vừa bình chọn`;
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
          const contactName = await resolveUserDisplayName(api, uid, uid || 'Không rõ');
          const qrUrl: string | undefined =
            (typeof rawContent === 'object' && rawContent !== null && 'qrCodeUrl' in rawContent)
              ? String((rawContent as Record<string, unknown>).qrCodeUrl)
              : media.qrCodeUrl;

          const body = `👤 <b>Danh thiếp</b>\nTên: <b>${escapeHtml(contactName)}</b>\nZalo ID: <code>${uid}</code>`;
          const fullText = `${groupCaption(senderName)}\n${body}`;

          if (qrUrl) {
            try {
              const localPath = await downloadZaloMediaDurably(qrUrl, `qr_${Date.now()}.jpg`);
              const sent = await sendTelegramPhotoFile(
                localPath,
                { ...tgBase, caption: fullText, parse_mode: 'HTML' },
                'Contact QR upload',
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
      const fallback = `${groupCaption(senderName)}\n<i>[${msgType}]</i>`;
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
