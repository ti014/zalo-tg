import { ThreadType } from 'zca-js';
import type { Context, NarrowedContext } from 'telegraf';
import type { Message, Update } from 'telegraf/types';

import type { TgHandlerContext } from './types.js';
import {
  aliasCache,
  store,
  msgStore,
  sentMsgStore,
  pendingSendStore,
  mediaGroupStore,
  userCache,
} from '../store/index.js';
import type { MediaGroupItem } from '../store/index.js';
import { tgBot } from './bot.js';
import { config } from '../config.js';
import {
  downloadToTemp,
  cleanTemp,
  convertToM4a,
  compressGifForZalo,
  convertTgsToGif,
  convertVideoToGif,
  convertVideoToMp4,
  extractVideoThumbnail,
  forceUltraSmallGif,
  ZALO_GIF_MAX_BYTES,
} from '../utils/media.js';
import { resolveTgMentions, type TgEntity } from './helpers.js';
import { runZaloRequest } from '../zalo/rate-limit.js';
import { contentFingerprint, type PendingSendKind } from '../domain/pending-sends.js';
import {
  isDurableTelegramDelivery,
  markDurableTelegramHandled,
  recordDurableTelegramFailure,
  recordDurableTelegramProviderMessageId,
  recordDurableTelegramSkipped,
} from '../application/durable-telegram.js';
import { isAmbiguousProviderFailure } from '../domain/provider-errors.js';
import { downloadTelegramMediaDurably } from '../application/durable-media.js';
import { isAnonymousAdminUpdate } from './authorization-policy.js';
import { buildReplyAutoMention, splitZaloText } from '../domain/text-chunks.js';

interface ZaloSendMessageResult {
  message?: { msgId?: number; cliMsgId?: number } | null;
  attachment?: Array<{ msgId?: number; cliMsgId?: number }>;
}

interface ZaloCreatePollResult {
  poll_id?: number;
  options?: Array<{ option_id?: number; content: string; votes?: number }>;
}

const TELEGRAM_BOT_DOWNLOAD_MAX_BYTES = config.telegram.downloadMaxBytes;
const TELEGRAM_BOT_DOWNLOAD_MAX_MB = TELEGRAM_BOT_DOWNLOAD_MAX_BYTES / 1024 / 1024;
const ZALO_PROVIDER_CALL_TIMEOUT_MS = 90_000;

export type TelegramMessageContext = NarrowedContext<Context, Update.MessageUpdate<Message>>;

function withZaloProviderTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(
        new Error(`${label} timed out after ${ZALO_PROVIDER_CALL_TIMEOUT_MS / 1_000}s.`),
        { code: 'ETIMEDOUT' },
      )), ZALO_PROVIDER_CALL_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function formatFileSize(sizeBytes?: number): string {
  return sizeBytes ? ` (${(sizeBytes / 1024 / 1024).toFixed(1)} MB)` : '';
}

export function registerMessageHandler({ bot, getApi }: TgHandlerContext): void {
  bot.on('message', ctx => processTelegramMessage(ctx, getApi));
}

export async function processTelegramMessage(
  ctx: TelegramMessageContext,
  getApi: TgHandlerContext['getApi'],
): Promise<void> {
  try {
      const msg = ctx.message;
      if (ctx.from?.is_bot && !isAnonymousAdminUpdate(ctx.update)) return;
      if (ctx.chat.id !== config.telegram.groupId) return;

      const topicId =
        'message_thread_id' in msg ? (msg.message_thread_id as number | undefined) : undefined;
      if (!topicId) return;
      markDurableTelegramHandled();

      const currentApi = getApi();
      if (!currentApi) {
        console.warn('[TG→Zalo] currentApi is null – Zalo not connected. Ignoring message.');
        recordDurableTelegramFailure(Object.assign(
          new Error('Zalo is not connected.'),
          { code: 'ZALO_OFFLINE' },
        ));
        return;
      }

      const api = currentApi;

      const entry = store.getEntryByTopic(topicId);
      if (!entry) {
        console.warn(`[TG→Zalo] No Zalo mapping for topicId=${topicId}`);
        recordDurableTelegramFailure(Object.assign(
          new Error(`No Zalo mapping for Telegram topic ${topicId}.`),
          { code: 'TOPIC_MAPPING_MISSING' },
        ));
        return;
      }

      const { zaloId } = entry;
      const threadType: ThreadType = entry.type === 1 ? ThreadType.Group : ThreadType.User;

      const notifyError = async (action: string, err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: number }).code;
        recordDurableTelegramFailure(err);
        console.error(`[TG→Zalo] ${action} failed (zaloId=${zaloId}, type=${threadType}):`, err);

        let hint = '';
        if (code === 114) {
          hint = threadType === ThreadType.User
            ? '\n💡 <i>Zalo từ chối: chưa kết bạn hoặc người dùng đã bật giới hạn tin nhắn từ người lạ.</i>'
            : '\n💡 <i>Zalo từ chối tham số (code 114).</i>';
        } else if (code === 221) {
          hint = '\n<i>Zalo đang giới hạn request. Bot đã retry, nếu vẫn lỗi hãy chờ vài phút rồi gửi lại.</i>';
        } else if (code === -216) {
          hint = '\n💡 <i>Phiên đăng nhập Zalo hết hạn. Dùng /login để đăng nhập lại.</i>';
        }

        await tgBot.telegram
          .sendMessage(
            config.telegram.groupId,
            `⚠️ Gửi thất bại: <b>${action}</b>\n<code>${errMsg}${code != null ? ` (code ${code})` : ''}</code>${hint}`,
            { message_thread_id: topicId, parse_mode: 'HTML' },
          )
          .catch(() => undefined);
      };

      const sendZalo = <T>(label: string, request: () => Promise<T>, maxRetries = 2): Promise<T> =>
        runZaloRequest(
          { label: `${label}(${zaloId})`, priority: 'high', maxRetries },
          () => withZaloProviderTimeout(request(), label),
        );

      const beginPendingSend = (kind: PendingSendKind, fingerprint?: string): string =>
        pendingSendStore.begin({
          conversationId: zaloId,
          telegramMessageId: msg.message_id,
          kind,
          fingerprint: contentFingerprint(fingerprint),
        });

      const saveSentMapping = (
        zaloMsgId: number,
        cliMsgId?: number,
        ordinal = 0,
      ): void => {
        recordDurableTelegramProviderMessageId(zaloMsgId, {
          receiptKind: ordinal === 0 ? 'primary' : 'auxiliary',
          ordinal,
          isPrimary: ordinal === 0,
          providerConversationId: zaloId,
        });
        sentMsgStore.append(msg.message_id, {
          msgId: zaloMsgId,
          ...(cliMsgId === undefined ? {} : { cliMsgId }),
          zaloId,
          threadType,
        });
      };

      const saveSendResultMappings = (
        result: ZaloSendMessageResult | undefined,
        startOrdinal = 0,
      ): number[] => {
        const candidates = [
          ...(result?.message?.msgId === undefined ? [] : [{
            msgId: result.message.msgId,
            cliMsgId: result.message.cliMsgId,
          }]),
          ...(result?.attachment ?? []).flatMap(attachment => (
            attachment.msgId === undefined ? [] : [{
              msgId: attachment.msgId,
              cliMsgId: attachment.cliMsgId,
            }]
          )),
        ];
        const seen = new Set<number>();
        const ids: number[] = [];
        for (const candidate of candidates) {
          if (seen.has(candidate.msgId)) continue;
          seen.add(candidate.msgId);
          saveSentMapping(candidate.msgId, candidate.cliMsgId, startOrdinal + ids.length);
          ids.push(candidate.msgId);
        }
        return ids;
      };

      const replyAutoMention = (replyToMessageId: number | undefined) => {
        if (replyToMessageId === undefined) return null;
        const quote = msgStore.getQuote(replyToMessageId);
        const uid = quote?.uidFrom;
        const displayName = uid
          ? aliasCache.get(uid)
            ?? userCache.getNameInGroup(uid, zaloId)
            ?? userCache.getName(uid)
          : undefined;
        return buildReplyAutoMention({
          group: threadType === ThreadType.Group,
          replyIsTelegramOriginated: sentMsgStore.get(replyToMessageId) !== undefined,
          uid,
          displayName,
        });
      };

      if ('text' in msg && msg.text) {
        if (msg.text.startsWith('/')) return;
        console.log(`[TG→Zalo] sendMessage → zaloId=${zaloId} type=${threadType} text="${msg.text.slice(0, 80)}"`);
        const replyToMsgId = msg.reply_to_message?.message_id;
        const zaloQuote = replyToMsgId !== undefined ? msgStore.getQuote(replyToMsgId) : undefined;

        const rawMentions = resolveTgMentions(
          msg.text,
          ('entities' in msg ? msg.entities : undefined) as ReadonlyArray<TgEntity> | undefined,
          threadType === ThreadType.Group,
          zaloId,
        );
        const automaticMention = replyAutoMention(replyToMsgId);
        const finalText = automaticMention ? automaticMention.prefix + msg.text : msg.text;
        const zaloMentions = automaticMention
          ? [
            automaticMention.mention,
            ...rawMentions.map(mention => ({
              ...mention,
              pos: mention.pos + automaticMention.prefix.length,
            })),
          ]
          : rawMentions;
        const chunks = splitZaloText(finalText, zaloMentions);

        const pendingToken = beginPendingSend('text', finalText);
        try {
          for (let index = 0; index < chunks.length; index += 1) {
            const chunk = chunks[index]!;
            const quote = index === 0 ? zaloQuote : undefined;
            const sendChunk = (includeQuote: boolean) => sendZalo<ZaloSendMessageResult>(
              index === 0 ? 'sendMessage' : 'sendMessage(chunk)',
              () => api.sendMessage(
                {
                  msg: chunk.text,
                  ...(includeQuote && quote ? { quote } : {}),
                  ...(chunk.mentions.length ? { mentions: chunk.mentions } : {}),
                },
                zaloId,
                threadType,
              ),
            );
            const sendResult = await sendChunk(true).catch(async (error: unknown) => {
              if ((error as { code?: number }).code === 114 && quote) {
                console.warn('[TG→Zalo] code 114 with quote, retrying first chunk without quote');
                return sendChunk(false);
              }
              throw error;
            });
            const zaloMsgId = sendResult?.message?.msgId;
            if (zaloMsgId !== undefined) {
              saveSentMapping(zaloMsgId, sendResult.message?.cliMsgId, index);
            }
            if (index < chunks.length - 1) {
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
          pendingSendStore.complete(pendingToken);
        } catch (err) {
          pendingSendStore.cancel(pendingToken);
          await notifyError('sendMessage', err);
        }
        return;
      }

      const notifyTooBig = async (filename: string, sizeBytes?: number) => {
        await notifyError(
          `sendAttachment(${filename})`,
          Object.assign(
            new Error(`File${formatFileSize(sizeBytes)} vượt giới hạn ${TELEGRAM_BOT_DOWNLOAD_MAX_MB} MB cấu hình — không thể tải xuống`),
            { code: 'MEDIA_TOO_LARGE' },
          ),
        );
      };

      const notifyDownloadRejected = async (filename: string, sizeBytes?: number) => {
        await notifyError(
          `sendAttachment(${filename})`,
          Object.assign(
            new Error(`Telegram Bot API từ chối tải xuống file${formatFileSize(sizeBytes)}. Nếu đang dùng cloud Bot API, giới hạn thực tế có thể thấp hơn ${TELEGRAM_BOT_DOWNLOAD_MAX_MB} MB.`),
            { code: 'MEDIA_TOO_LARGE' },
          ),
        );
      };

      const sendLocalAttachment = async (
        localPath: string,
        filename: string,
        caption?: string,
        captionMentions?: Array<{ pos: number; uid: string; len: number }>,
        kind: PendingSendKind = 'document',
      ): Promise<void> => {
        const replyToMsgId = 'reply_to_message' in msg
          ? (msg as { reply_to_message?: { message_id: number } }).reply_to_message?.message_id
          : undefined;
        const zaloQuote = replyToMsgId !== undefined ? msgStore.getQuote(replyToMsgId) : undefined;
        const pendingToken = beginPendingSend(kind);
        try {
          console.log(`[TG→Zalo] Sending ${filename} → zaloId=${zaloId} type=${threadType}`);
          const effectiveCaption = caption ?? '';
          const sendResult = await sendZalo<ZaloSendMessageResult>(
            'sendAttachment',
            () => api.sendMessage(
              {
                msg: effectiveCaption,
                attachments: [localPath],
                ...(effectiveCaption.length && zaloQuote ? { quote: zaloQuote } : {}),
                ...(captionMentions?.length ? { mentions: captionMentions } : {}),
              },
              zaloId,
              threadType,
            ),
          ).catch(async (err: unknown) => {
            if ((err as { code?: number }).code === 114) {
              console.warn('[TG→Zalo] code 114 on attachment+quote, retrying without quote');
              return sendZalo<ZaloSendMessageResult>(
                'sendAttachment(no-quote)',
                () => api.sendMessage(
                  {
                    msg: effectiveCaption,
                    attachments: [localPath],
                    ...(captionMentions?.length ? { mentions: captionMentions } : {}),
                  },
                  zaloId,
                  threadType,
                ),
              );
            }
            throw err;
          });
          saveSendResultMappings(sendResult);
          pendingSendStore.complete(pendingToken);
          console.log(`[TG→Zalo] Send OK: ${filename}`);
        } catch (err) {
          pendingSendStore.cancel(pendingToken);
          await notifyError(`sendAttachment(${filename})`, err);
        }
      };

      const sendAttachment = async (
        fileId: string,
        filename: string,
        fileSize?: number,
        caption?: string,
        captionMentions?: Array<{ pos: number; uid: string; len: number }>,
        kind: PendingSendKind = 'document',
      ) => {
        if (fileSize !== undefined && fileSize > TELEGRAM_BOT_DOWNLOAD_MAX_BYTES) {
          await notifyTooBig(filename, fileSize);
          return;
        }
        let localPath: string;
        try {
          localPath = await downloadTelegramMediaDurably(
            async () => (await ctx.telegram.getFileLink(fileId)).toString(),
            filename,
          );
        } catch (err: unknown) {
          const isTooBig = err instanceof Error && err.message.includes('file is too big');
          if (isTooBig) { await notifyDownloadRejected(filename, fileSize); return; }
          throw err;
        }
        try {
          await sendLocalAttachment(localPath, filename, caption, captionMentions, kind);
        } finally {
          await cleanTemp(localPath);
        }
      };

      const getCaptionMentions = () => {
        const cap = ('caption' in msg ? (msg as { caption?: string }).caption : undefined);
        const capEntities = ('caption_entities' in msg
          ? (msg as { caption_entities?: ReadonlyArray<TgEntity> }).caption_entities
          : undefined);
        const rawMentions = cap
          ? resolveTgMentions(cap, capEntities, threadType === ThreadType.Group, zaloId)
          : [];
        const replyToMessageId = 'reply_to_message' in msg
          ? (msg as { reply_to_message?: { message_id: number } }).reply_to_message?.message_id
          : undefined;
        const automaticMention = replyAutoMention(replyToMessageId);
        if (!automaticMention) {
          return { cap, capMentions: rawMentions.length ? rawMentions : undefined };
        }
        return {
          cap: cap
            ? automaticMention.prefix + cap
            : automaticMention.prefix.trimEnd(),
          capMentions: [
            automaticMention.mention,
            ...rawMentions.map(mention => ({
              ...mention,
              pos: mention.pos + automaticMention.prefix.length,
            })),
          ],
        };
      };

      const flushMediaGroup = async (
        items: MediaGroupItem[],
        meta: { topicId: number; zaloId: string; threadType: 0 | 1; replyToMsgId?: number },
      ) => {
        const replyMsgId = meta.replyToMsgId;
        const zaloQuote = replyMsgId !== undefined ? msgStore.getQuote(replyMsgId) : undefined;
        const caption = items[0]?.caption ?? '';
        const capMentions = items[0]?.captionMentions;
        const localPaths: string[] = [];
        let pendingToken: string | undefined;
        try {
          for (const item of items) {
            if ((item.fileSize ?? 0) > 20 * 1024 * 1024) continue;
            let fileLink: URL;
            try { fileLink = await tgBot.telegram.getFileLink(item.fileId); }
            catch { continue; }
            localPaths.push(await downloadToTemp(
              fileLink.toString(),
              item.fname,
              3,
              TELEGRAM_BOT_DOWNLOAD_MAX_BYTES,
            ));
          }
          if (localPaths.length === 0) return;
          pendingToken = beginPendingSend('photo');
          const sendResult = await sendZalo<ZaloSendMessageResult>(
            'sendMediaGroup',
            () => api.sendMessage(
              {
                msg: caption,
                attachments: localPaths,
                ...(zaloQuote ? { quote: zaloQuote } : {}),
                ...(capMentions?.length ? { mentions: capMentions } : {}),
              },
              meta.zaloId,
              meta.threadType === 1 ? ThreadType.Group : ThreadType.User,
            ),
          );
          const zaloMsgIds = saveSendResultMappings(sendResult);
          if (zaloMsgIds.length > 0) {
            console.log(`[TG→Zalo] Media group sent: ${localPaths.length} files, zaloMsgIds=${zaloMsgIds.join(',')}`);
          }
          pendingSendStore.complete(pendingToken);
        } catch (err) {
          if (pendingToken) pendingSendStore.cancel(pendingToken);
          console.error('[TG→Zalo] Media group send failed:', err);
        } finally {
          for (const lp of localPaths) await cleanTemp(lp);
        }
      };

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _api = api;

      if ('photo' in msg && msg.photo && msg.photo.length > 0) {
        const photo = msg.photo[msg.photo.length - 1]!;
        const { cap, capMentions } = getCaptionMentions();
        const mediaGroupId = ('media_group_id' in msg ? (msg as { media_group_id?: string }).media_group_id : undefined);
        if (mediaGroupId && !isDurableTelegramDelivery()) {
          const replyToMsgId = msg.reply_to_message?.message_id;
          mediaGroupStore.add(
            mediaGroupId,
            { fileId: photo.file_id, fname: 'photo.jpg', fileSize: photo.file_size, caption: cap, captionMentions: capMentions },
            { topicId, zaloId, threadType: entry.type, replyToMsgId },
            (items, meta) => { void flushMediaGroup(items, meta); },
          );
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          void _api;
          return;
        }
        await sendAttachment(photo.file_id, 'photo.jpg', photo.file_size, cap, capMentions, 'photo');
        return;
      }

      if ('animation' in msg && msg.animation) {
        const fname = msg.animation.file_name ?? 'animation.gif';
        const { cap, capMentions } = getCaptionMentions();
        if ((msg.animation.file_size ?? 0) > TELEGRAM_BOT_DOWNLOAD_MAX_BYTES) {
          await notifyTooBig(fname, msg.animation.file_size);
          return;
        }
        const isMp4Animation = msg.animation.mime_type === 'video/mp4' || fname.toLowerCase().endsWith('.mp4');

        if (isMp4Animation) {
          let sourcePath: string | undefined;
          let thumbnailPath: string | undefined;
          let fallbackGifPath: string | undefined;
          try {
            sourcePath = await downloadTelegramMediaDurably(
              async () => (await ctx.telegram.getFileLink(msg.animation!.file_id)).toString(),
              `animation_${msg.message_id}.mp4`,
            );
            try {
              const uploads: any[] = await sendZalo(
                'uploadAnimation',
                () => api.uploadAttachment([sourcePath!], zaloId, threadType),
              );
              const upload = uploads?.find((item: { fileType?: string }) => item.fileType === 'video') as
                { fileUrl?: string } | undefined;
              if (!upload?.fileUrl) throw new Error('Zalo returned no video URL for Telegram animation.');

              let thumbnailUrl = upload.fileUrl;
              try {
                thumbnailPath = await extractVideoThumbnail(sourcePath);
                const thumbnails: any[] = await sendZalo(
                  'uploadAnimationThumbnail',
                  () => api.uploadAttachment([thumbnailPath!], zaloId, threadType),
                  1,
                );
                const thumbnail = thumbnails?.[0] as { normalUrl?: string } | undefined;
                if (thumbnail?.normalUrl) thumbnailUrl = thumbnail.normalUrl;
              } catch {
                // The video URL is a valid fallback thumbnail for Zalo.
              }

              const pendingToken = beginPendingSend('sticker');
              try {
                const result = await sendZalo(
                  'sendAnimation',
                  () => (api.sendVideo as (...args: any[]) => Promise<{ msgId?: number }>)(
                    {
                      videoUrl: upload.fileUrl,
                      thumbnailUrl,
                      width: msg.animation!.width,
                      height: msg.animation!.height,
                      duration: (msg.animation!.duration ?? 0) * 1000,
                      msg: cap ?? '',
                    },
                    zaloId,
                    threadType,
                  ),
                );
                if (result?.msgId !== undefined) saveSentMapping(result.msgId);
                pendingSendStore.complete(pendingToken);
              } catch (error) {
                pendingSendStore.cancel(pendingToken);
                throw error;
              }
              console.log('[TG→Zalo] Telegram MP4 animation sent without GIF transcoding');
              return;
            } catch (videoError) {
              if (isDurableTelegramDelivery() && isAmbiguousProviderFailure(videoError)) {
                recordDurableTelegramFailure(videoError);
                console.error('[TG→Zalo] animation outcome is ambiguous; GIF fallback suppressed:', videoError);
                return;
              }
              console.warn('[TG→Zalo] MP4 animation path failed; trying high-quality GIF fallback:', videoError);
            }

            fallbackGifPath = await convertVideoToGif(sourcePath);
            await sendLocalAttachment(fallbackGifPath, 'animation.gif', cap, capMentions, 'sticker');
          } finally {
            if (fallbackGifPath) await cleanTemp(fallbackGifPath);
            if (thumbnailPath) await cleanTemp(thumbnailPath);
            if (sourcePath) await cleanTemp(sourcePath);
          }
          return;
        }

        if ((msg.animation.file_size ?? 0) <= ZALO_GIF_MAX_BYTES) {
          await sendAttachment(msg.animation.file_id, fname, msg.animation.file_size, cap, capMentions, 'sticker');
          return;
        }

        let sourcePath: string | undefined;
        let compressedPath: string | undefined;
        try {
          sourcePath = await downloadTelegramMediaDurably(
            async () => (await ctx.telegram.getFileLink(msg.animation!.file_id)).toString(),
            fname.endsWith('.gif') ? fname : `animation_${msg.message_id}.gif`,
          );
          compressedPath = await compressGifForZalo(sourcePath);
          await sendLocalAttachment(compressedPath, 'animation.gif', cap, capMentions, 'sticker');
        } finally {
          if (compressedPath && compressedPath !== sourcePath) await cleanTemp(compressedPath);
          if (sourcePath) await cleanTemp(sourcePath);
        }
        return;
      }

      if ('document' in msg && msg.document) {
        const doc   = msg.document;
        const fname = doc.file_name ?? `file_${msg.message_id}.bin`;
        const { cap, capMentions } = getCaptionMentions();
        await sendAttachment(doc.file_id, fname, doc.file_size, cap, capMentions);
        return;
      }

      if ('audio' in msg && msg.audio) {
        const audio = msg.audio;
        const fname = audio.file_name ?? `audio_${msg.message_id}.mp3`;
        const { cap, capMentions } = getCaptionMentions();
        await sendAttachment(audio.file_id, fname, audio.file_size, cap, capMentions, 'document');
        return;
      }

      if ('video' in msg && msg.video) {
        const vid   = msg.video;
        const fname = vid.file_name?.endsWith('.mp4') ? vid.file_name : `video_${msg.message_id}.mp4`;
        const { cap, capMentions } = getCaptionMentions();
        const mediaGroupId = ('media_group_id' in msg ? (msg as { media_group_id?: string }).media_group_id : undefined);
        if (mediaGroupId && !isDurableTelegramDelivery()) {
          const replyToMsgId = msg.reply_to_message?.message_id;
          mediaGroupStore.add(
            mediaGroupId,
            { fileId: vid.file_id, fname, fileSize: vid.file_size, caption: cap, captionMentions: capMentions },
            { topicId, zaloId, threadType: entry.type, replyToMsgId },
            (items, meta) => { void flushMediaGroup(items, meta); },
          );
          return;
        }

        if ((vid.file_size ?? 0) > TELEGRAM_BOT_DOWNLOAD_MAX_BYTES) {
          await notifyTooBig(fname, vid.file_size);
          return;
        }
        let localVideoPath: string;
        try {
          localVideoPath = await downloadTelegramMediaDurably(
            async () => (await ctx.telegram.getFileLink(vid.file_id)).toString(),
            fname,
          );
        } catch (err: unknown) {
          const isTooBig = err instanceof Error && err.message.includes('file is too big');
          if (isTooBig) { await notifyDownloadRejected(fname, vid.file_size); return; }
          throw err;
        }
        let localThumbPath: string | undefined;
        try {
          try { localThumbPath = await extractVideoThumbnail(localVideoPath); } catch { /* no thumb */ }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const videoUploads: any[] = await sendZalo(
            'uploadVideo',
            () => api.uploadAttachment([localVideoPath], zaloId, threadType),
          );
          const videoUpload = videoUploads?.find((r: { fileType?: string }) => r.fileType === 'video') as
            { fileUrl?: string } | undefined;

          if (!videoUpload?.fileUrl) {
            await sendAttachment(vid.file_id, fname, vid.file_size, cap, capMentions);
            return;
          }

          let thumbUrl = videoUpload.fileUrl;
          if (localThumbPath) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const thumbUploads: any[] = await sendZalo(
                'uploadVideoThumbnail',
                () => api.uploadAttachment([localThumbPath], zaloId, threadType),
                1,
              );
              const tu = thumbUploads?.[0] as { normalUrl?: string } | undefined;
              if (tu?.normalUrl) thumbUrl = tu.normalUrl;
            } catch { /* keep fallback thumbUrl */ }
          }

          const pendingToken = beginPendingSend('video');
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = await sendZalo(
              'sendVideo',
              () => (api.sendVideo as (...a: any[]) => Promise<{ msgId?: number }>)(
                {
                  videoUrl:     videoUpload.fileUrl,
                  thumbnailUrl: thumbUrl,
                  width:        vid.width,
                  height:       vid.height,
                  duration:     (vid.duration ?? 0) * 1000,
                  msg:          cap ?? '',
                },
                zaloId,
                threadType,
              ),
            );
            if (result?.msgId !== undefined) {
              saveSentMapping(result.msgId);
            }
            pendingSendStore.complete(pendingToken);
          } catch (err) {
            pendingSendStore.cancel(pendingToken);
            throw err;
          }
        } catch (err) {
          if (isDurableTelegramDelivery() && isAmbiguousProviderFailure(err)) {
            recordDurableTelegramFailure(err);
            console.error('[TG→Zalo] sendVideo outcome is ambiguous; attachment fallback suppressed:', err);
            return;
          }
          console.error('[TG→Zalo] sendVideo failed, fallback to attachment:', err);
          try {
            await sendAttachment(vid.file_id, fname, vid.file_size, cap, capMentions);
          } catch (fallbackError) {
            recordDurableTelegramFailure(fallbackError);
          }
        } finally {
          await cleanTemp(localVideoPath);
          if (localThumbPath) await cleanTemp(localThumbPath);
        }
        return;
      }

      if ('voice' in msg && msg.voice) {
        const voiceFilename = `voice_${msg.message_id}.ogg`;
        if ((msg.voice.file_size ?? 0) > TELEGRAM_BOT_DOWNLOAD_MAX_BYTES) {
          await notifyTooBig(voiceFilename, msg.voice.file_size);
          return;
        }
        let oggPath: string;
        try {
          oggPath = await downloadTelegramMediaDurably(
            async () => (await ctx.telegram.getFileLink(msg.voice.file_id)).toString(),
            voiceFilename,
          );
        } catch (err: unknown) {
          const isTooBig = err instanceof Error && err.message.includes('file is too big');
          if (isTooBig) { await notifyDownloadRejected(voiceFilename, msg.voice.file_size); return; }
          throw err;
        }
        let m4aPath: string | undefined;
        try {
          m4aPath = await convertToM4a(oggPath);
          const uploaded = await sendZalo(
            'uploadVoice',
            () => api.uploadAttachment(m4aPath, zaloId, threadType),
          ) as Array<{ fileUrl?: string }>;
          const voiceUrl = uploaded[0]?.fileUrl;
          if (!voiceUrl) throw new Error('No fileUrl from uploadAttachment');
          console.log(`[TG→Zalo] Sending voice → ${voiceUrl}`);
          const pendingToken = beginPendingSend('voice');
          try {
            const result = await sendZalo(
              'sendVoice',
              () => api.sendVoice({ voiceUrl }, zaloId, threadType),
            ) as { msgId?: number } | undefined;
            if (result?.msgId !== undefined) {
              saveSentMapping(result.msgId);
            }
            pendingSendStore.complete(pendingToken);
          } catch (err) {
            pendingSendStore.cancel(pendingToken);
            throw err;
          }
          console.log(`[TG→Zalo] Voice sent OK`);
        } catch (err) {
          if (isDurableTelegramDelivery() && isAmbiguousProviderFailure(err)) {
            recordDurableTelegramFailure(err);
            console.error('[TG→Zalo] voice outcome is ambiguous; file fallback suppressed:', err);
            return;
          }
          console.error('[TG→Zalo] Voice convert/send failed, falling back to file:', err);
          await sendAttachment(msg.voice.file_id, voiceFilename);
        } finally {
          await cleanTemp(oggPath);
          if (m4aPath) await cleanTemp(m4aPath);
        }
        return;
      }

      if ('sticker' in msg && msg.sticker) {
        const sticker = msg.sticker;
        console.log(`[TG→Zalo] Sticker flags animated=${Boolean(sticker.is_animated)} video=${Boolean(sticker.is_video)} thumb=${Boolean(sticker.thumbnail)}`);
        const { cap, capMentions } = getCaptionMentions();

        // Static Telegram stickers are already WebP files. Sending the source
        // preserves transparency and the original 512px artwork.
        if (!sticker.is_animated && !sticker.is_video) {
          await sendAttachment(
            sticker.file_id,
            `sticker_${msg.message_id}.webp`,
            sticker.file_size,
            cap,
            capMentions,
            'sticker',
          );
          return;
        }

        let sourcePath: string | undefined;
        let mp4Path: string | undefined;
        let thumbnailPath: string | undefined;
        let rawGifPath: string | undefined;
        let gifPath: string | undefined;
        try {
          const sourceExt = sticker.is_video ? '.webm' : (sticker.is_animated ? '.tgs' : '.webp');
          sourcePath = await downloadTelegramMediaDurably(
            async () => (await ctx.telegram.getFileLink(sticker.file_id)).toString(),
            `sticker_${msg.message_id}${sourceExt}`,
          );

          if (sticker.is_video) {
            try {
              mp4Path = await convertVideoToMp4(sourcePath);
              const videoUploads: any[] = await sendZalo(
                'uploadVideoSticker',
                () => api.uploadAttachment([mp4Path!], zaloId, threadType),
              );
              const videoUpload = videoUploads?.find((item: { fileType?: string }) => item.fileType === 'video') as
                { fileUrl?: string } | undefined;
              if (!videoUpload?.fileUrl) throw new Error('Zalo returned no video URL for video sticker.');

              let thumbnailUrl = videoUpload.fileUrl;
              try {
                thumbnailPath = await extractVideoThumbnail(mp4Path);
                const thumbnailUploads: any[] = await sendZalo(
                  'uploadVideoStickerThumbnail',
                  () => api.uploadAttachment([thumbnailPath!], zaloId, threadType),
                  1,
                );
                const uploadedThumbnail = thumbnailUploads?.[0] as { normalUrl?: string } | undefined;
                if (uploadedThumbnail?.normalUrl) thumbnailUrl = uploadedThumbnail.normalUrl;
              } catch {
                // Zalo can use the video URL as a fallback thumbnail.
              }

              const pendingToken = beginPendingSend('sticker');
              try {
                const result = await sendZalo(
                  'sendVideoSticker',
                  () => (api.sendVideo as (...args: any[]) => Promise<{ msgId?: number }>)(
                    {
                      videoUrl: videoUpload.fileUrl,
                      thumbnailUrl,
                      width: sticker.width,
                      height: sticker.height,
                      duration: 0,
                      msg: cap ?? '',
                    },
                    zaloId,
                    threadType,
                  ),
                );
                if (result?.msgId !== undefined) saveSentMapping(result.msgId);
                pendingSendStore.complete(pendingToken);
              } catch (error) {
                pendingSendStore.cancel(pendingToken);
                throw error;
              }
              console.log('[TG→Zalo] Video sticker sent as MP4');
              return;
            } catch (videoError) {
              if (isDurableTelegramDelivery() && isAmbiguousProviderFailure(videoError)) {
                recordDurableTelegramFailure(videoError);
                console.error('[TG→Zalo] video sticker outcome is ambiguous; fallback suppressed:', videoError);
                return;
              }
              console.warn('[TG→Zalo] Video sticker MP4 path failed; trying high-quality GIF fallback:', videoError);
            }
          }

          rawGifPath = sticker.is_video
            ? await convertVideoToGif(sourcePath)
            : await convertTgsToGif(sourcePath);
          const convertedGifPath = await compressGifForZalo(rawGifPath);
          gifPath = convertedGifPath;
          const pendingToken = beginPendingSend('sticker');
          try {
            let sendResult: ZaloSendMessageResult;
            try {
              sendResult = await sendZalo<ZaloSendMessageResult>(
                'sendStickerGif',
                () => api.sendMessage({ msg: '', attachments: [convertedGifPath] }, zaloId, threadType),
              );
            } catch (sendErr) {
              if ((sendErr as { code?: number }).code !== 200) throw sendErr;
              console.warn('[TG→Zalo] Sticker GIF exceeded Zalo upload processing limit; retrying ultra-small GIF.');
              const ultraGifPath = await forceUltraSmallGif(convertedGifPath);
              if (gifPath && gifPath !== rawGifPath) await cleanTemp(gifPath);
              gifPath = ultraGifPath;
              sendResult = await sendZalo<ZaloSendMessageResult>(
                'sendStickerGif(ultra)',
                () => api.sendMessage({ msg: '', attachments: [ultraGifPath] }, zaloId, threadType),
              );
            }
            saveSendResultMappings(sendResult);
            pendingSendStore.complete(pendingToken);
          } catch (err) {
            pendingSendStore.cancel(pendingToken);
            throw err;
          }
          console.log(`[TG→Zalo] ${sticker.is_video ? 'Video' : (sticker.is_animated ? 'Animated' : 'Static')} sticker converted to GIF and sent`);
          return;
        } catch (err) {
          if (isDurableTelegramDelivery() && isAmbiguousProviderFailure(err)) {
            recordDurableTelegramFailure(err);
            console.error('[TG→Zalo] sticker outcome is ambiguous; thumbnail fallback suppressed:', err);
            return;
          }
          console.warn('[TG→Zalo] Sticker→GIF failed, falling back to thumbnail:', (err as Error).message);
        } finally {
          if (sourcePath) await cleanTemp(sourcePath);
          if (mp4Path) await cleanTemp(mp4Path);
          if (thumbnailPath) await cleanTemp(thumbnailPath);
          if (rawGifPath && rawGifPath !== gifPath) await cleanTemp(rawGifPath);
          if (gifPath) await cleanTemp(gifPath);
        }

        if (sticker.thumbnail) {
          await sendAttachment(
            sticker.thumbnail.file_id,
            `sticker_${msg.message_id}.jpg`,
            sticker.thumbnail.file_size,
            cap,
            capMentions,
            'sticker',
          );
        } else {
          await notifyError('sendSticker', new Error('Sticker conversion failed and Telegram provided no thumbnail.'));
        }
        return;
      }

      if ('poll' in msg && msg.poll) {
        const tgPoll = msg.poll;
        console.log(`[TG→Zalo] Received TG poll: id=${tgPoll.id} question="${tgPoll.question}" is_anonymous=${tgPoll.is_anonymous}`);

        if (threadType !== 1) {
          recordDurableTelegramFailure(Object.assign(
            new Error('Zalo polls require a group conversation.'),
            { code: 'POLL_REQUIRES_GROUP' },
          ));
          await ctx.reply('❌ Chỉ tạo bình chọn được trong nhóm Zalo.', { message_thread_id: topicId });
          return;
        }

        const { pollStore } = await import('../store/index.js');
        const pendingToken = beginPendingSend('poll', tgPoll.question);
        let createdOnZalo = false;
        try {
          const created = await sendZalo<ZaloCreatePollResult>(
            'createPoll',
            () => api.createPoll(
              {
                question:         tgPoll.question,
                options:          tgPoll.options.map((o: { text: string }) => o.text),
                isAnonymous:      false,
                allowMultiChoices: tgPoll.allows_multiple_answers ?? false,
              },
              zaloId,
            ),
          );
          createdOnZalo = true;
          if (created?.poll_id !== undefined) {
            recordDurableTelegramProviderMessageId(created.poll_id, {
              receiptKind: 'poll',
              ordinal: 0,
              isPrimary: true,
            });
          }
          console.log(`[TG→Zalo] Zalo poll created: pollId=${created?.poll_id}`);
          pendingSendStore.complete(pendingToken);

          const botPollMsg = await tgBot.telegram.sendPoll(
            config.telegram.groupId,
            tgPoll.question,
            tgPoll.options.map((o: { text: string }) => o.text),
            {
              message_thread_id:       topicId,
              is_anonymous:            false,
              allows_multiple_answers: tgPoll.allows_multiple_answers ?? false,
            } as Parameters<typeof tgBot.telegram.sendPoll>[3],
          );
          const tgPollUUID = (botPollMsg as { poll?: { id?: string } }).poll?.id ?? '';
          console.log(`[TG→Zalo] Bot TG poll sent: msgId=${botPollMsg.message_id} uuid=${tgPollUUID}`);

          const zaloPollOptions = created?.options ?? tgPoll.options.map((o: { text: string }, i: number) => ({
            option_id: i, content: o.text, votes: 0,
          }));

          const scoreLines = zaloPollOptions.map((o: { content: string }) =>
            `${o.content}\n  ${'░'.repeat(10)} 0 phiếu (0%)`,
          );
          const scoreText = `📊 <b>Kết quả bình chọn</b>\n<i>(tạo từ Telegram)</i>\n\nTổng: 0 phiếu\n\n${scoreLines.join('\n\n')}`;
          const lockPollId = created?.poll_id ?? 0;
          const tgScoreMsg = await tgBot.telegram.sendMessage(
            config.telegram.groupId,
            scoreText,
            {
              message_thread_id: topicId,
              parse_mode: 'HTML',
              reply_parameters: { message_id: botPollMsg.message_id, allow_sending_without_reply: true },
              reply_markup: {
                inline_keyboard: [[
                  { text: '🔒 Khoá bình chọn', callback_data: `lock_poll:${lockPollId}` },
                ]],
              },
            },
          );

          if (created?.poll_id) {
            pollStore.save({
              pollId:           created.poll_id,
              zaloGroupId:      zaloId,
              tgPollMsgId:      botPollMsg.message_id,
              tgOrigPollMsgId:  msg.message_id,
              tgPollUUID:       tgPollUUID,
              tgScoreMsgId:     tgScoreMsg.message_id,
              tgThreadId:       topicId,
              options: zaloPollOptions.map((o: { option_id?: number; content: string }, i: number) => ({
                option_id: o.option_id ?? i,
                content:   o.content,
              })),
            });
          }
        } catch (err) {
          if (createdOnZalo) {
            console.error('[TG→Zalo] Poll was created on Zalo, but Telegram mirror bookkeeping failed:', err);
          } else {
            pendingSendStore.cancel(pendingToken);
            recordDurableTelegramFailure(err);
            console.error('[TG→Zalo] createPoll failed:', err);
          }
          await tgBot.telegram.sendMessage(
            config.telegram.groupId,
            createdOnZalo
              ? 'Bình chọn đã được tạo trên Zalo nhưng phần hiển thị đồng bộ trên Telegram bị lỗi.'
              : '❌ Không thể tạo bình chọn trên Zalo.',
            { message_thread_id: topicId },
          ).catch(() => undefined);
        }
        return;
      }

      if ('location' in msg && msg.location) {
        const { latitude, longitude } = msg.location;
        const mapsUrl = `https://www.google.com/maps?q=${latitude},${longitude}`;
        const pendingToken = beginPendingSend('location', mapsUrl);
        try {
          const result = await sendZalo<ZaloSendMessageResult & { msgId?: number }>(
            'sendLink',
            () => api.sendLink(
              { msg: '', link: mapsUrl },
              zaloId,
              threadType,
            ),
          );
          const zaloMsgId = result?.msgId ?? result?.message?.msgId;
          if (zaloMsgId !== undefined) saveSentMapping(zaloMsgId);
          pendingSendStore.complete(pendingToken);
          console.log(`[TG→Zalo] Location sent: ${latitude},${longitude}`);
        } catch (err) {
          pendingSendStore.cancel(pendingToken);
          if (isDurableTelegramDelivery() && isAmbiguousProviderFailure(err)) {
            recordDurableTelegramFailure(err);
            console.error('[TG→Zalo] location outcome is ambiguous; text fallback suppressed:', err);
            return;
          }
          const textPendingToken = beginPendingSend('text', `📍 ${mapsUrl}`);
          try {
            const result = await sendZalo(
              'sendLocationText',
              () => api.sendMessage({ msg: `📍 ${mapsUrl}` }, zaloId, threadType),
            ) as ZaloSendMessageResult;
            const zaloMsgId = result?.message?.msgId;
            if (zaloMsgId !== undefined) {
              saveSentMapping(zaloMsgId);
            }
            pendingSendStore.complete(textPendingToken);
          } catch (fallbackErr) {
            pendingSendStore.cancel(textPendingToken);
            throw fallbackErr;
          }
        }
        return;
      }

      if ('venue' in msg && msg.venue) {
        const { latitude, longitude } = msg.venue.location;
        const venueText = [
          `📍 ${msg.venue.title}`,
          msg.venue.address,
          `https://www.google.com/maps?q=${latitude},${longitude}`,
        ].filter(Boolean).join('\n');
        const pendingToken = beginPendingSend('text', venueText);
        try {
          const result = await sendZalo(
            'sendVenue',
            () => api.sendMessage({ msg: venueText }, zaloId, threadType),
          ) as ZaloSendMessageResult;
          const zaloMsgId = result?.message?.msgId;
          if (zaloMsgId !== undefined) {
            saveSentMapping(zaloMsgId);
          }
          pendingSendStore.complete(pendingToken);
        } catch (err) {
          pendingSendStore.cancel(pendingToken);
          await notifyError('sendVenue', err);
        }
        return;
      }

      if ('dice' in msg && msg.dice) {
        const diceText = `${msg.dice.emoji} ${msg.dice.value}`;
        const pendingToken = beginPendingSend('text', diceText);
        try {
          const result = await sendZalo(
            'sendDice',
            () => api.sendMessage({ msg: diceText }, zaloId, threadType),
          ) as ZaloSendMessageResult;
          const zaloMsgId = result?.message?.msgId;
          if (zaloMsgId !== undefined) {
            saveSentMapping(zaloMsgId);
          }
          pendingSendStore.complete(pendingToken);
        } catch (err) {
          pendingSendStore.cancel(pendingToken);
          await notifyError('sendDice', err);
        }
        return;
      }

      if ('contact' in msg && msg.contact) {
        const contact = msg.contact as { phone_number: string; first_name: string; last_name?: string; user_id?: number };
        const fullName = [contact.first_name, contact.last_name].filter(Boolean).join(' ');
        let cardSent = false;
        if (contact.user_id) {
          // TG user_id is not Zalo UID, skip sendCard attempt
        }
        if (!cardSent) {
          const body = `👤 <b>Danh thiếp</b>\nTên: <b>${fullName}</b>\nSĐT: <code>${contact.phone_number}</code>`;
          const contactText = `👤 ${fullName} — ${contact.phone_number}`;
          const pendingToken = beginPendingSend('text', contactText);
          try {
            const result = await sendZalo(
              'sendContact',
              () => api.sendMessage({ msg: contactText }, zaloId, threadType),
            ) as ZaloSendMessageResult;
            const zaloMsgId = result?.message?.msgId;
            if (zaloMsgId !== undefined) {
              saveSentMapping(zaloMsgId);
            }
            pendingSendStore.complete(pendingToken);
          } catch (err) {
            pendingSendStore.cancel(pendingToken);
            await notifyError('sendContact', err);
          }
          void body;
        }
        return;
      }
      if ('forum_topic_edited' in msg) {
        recordDurableTelegramSkipped(
          'SKIPPED_TELEGRAM_SERVICE_EVENT',
          'Telegram forum topic metadata changes are not user messages.',
        );
        return;
      }
      recordDurableTelegramFailure(Object.assign(
        new Error('Telegram message type is not supported by the Zalo relay.'),
        { code: 'UNSUPPORTED_MESSAGE' },
      ));
  } catch (err) {
    recordDurableTelegramFailure(err);
    console.error('[TG→Zalo] Error:', err);
  }
}
