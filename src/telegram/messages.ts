import { ThreadType } from 'zca-js';

import type { TgHandlerContext } from './types.js';
import { store, msgStore, sentMsgStore, mediaGroupStore } from '../store/index.js';
import type { MediaGroupItem } from '../store/index.js';
import { tgBot } from './bot.js';
import { config } from '../config.js';
import { downloadToTemp, cleanTemp, convertToM4a, extractVideoThumbnail } from '../utils/media.js';
import { resolveTgMentions, type TgEntity } from './helpers.js';

export function registerMessageHandler({ bot, getApi }: TgHandlerContext): void {
  bot.on('message', async (ctx) => {
    try {
      const msg = ctx.message;
      if (ctx.from?.is_bot) return;
      if (ctx.chat.id !== config.telegram.groupId) return;

      const topicId =
        'message_thread_id' in msg ? (msg.message_thread_id as number | undefined) : undefined;
      if (!topicId) return;

      const currentApi = getApi();
      if (!currentApi) {
        console.warn('[TG→Zalo] currentApi is null – Zalo not connected. Ignoring message.');
        return;
      }

      const api = currentApi;

      const entry = store.getEntryByTopic(topicId);
      if (!entry) {
        console.warn(`[TG→Zalo] No Zalo mapping for topicId=${topicId}`);
        return;
      }

      const { zaloId } = entry;
      const threadType: ThreadType = entry.type === 1 ? ThreadType.Group : ThreadType.User;

      const notifyError = async (action: string, err: unknown) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: number }).code;
        console.error(`[TG→Zalo] ${action} failed (zaloId=${zaloId}, type=${threadType}):`, err);

        let hint = '';
        if (code === 114) {
          hint = threadType === ThreadType.User
            ? '\n💡 <i>Zalo từ chối: chưa kết bạn hoặc người dùng đã bật giới hạn tin nhắn từ người lạ.</i>'
            : '\n💡 <i>Zalo từ chối tham số (code 114).</i>';
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

      if ('text' in msg && msg.text) {
        if (msg.text.startsWith('/')) return;
        console.log(`[TG→Zalo] sendMessage → zaloId=${zaloId} type=${threadType} text="${msg.text.slice(0, 80)}"`);
        const replyToMsgId = msg.reply_to_message?.message_id;
        const zaloQuote = replyToMsgId !== undefined ? msgStore.getQuote(replyToMsgId) : undefined;

        const zaloMentions = resolveTgMentions(
          msg.text,
          ('entities' in msg ? msg.entities : undefined) as ReadonlyArray<TgEntity> | undefined,
          threadType === ThreadType.Group,
          zaloId,
        );

        sentMsgStore.markSending(zaloId, msg.message_id);
        try {
          let sendResult = await api.sendMessage(
            {
              msg: msg.text,
              ...(zaloQuote ? { quote: zaloQuote } : {}),
              ...(zaloMentions.length ? { mentions: zaloMentions } : {}),
            },
            zaloId,
            threadType,
          ).catch(async (err: unknown) => {
            if ((err as { code?: number }).code === 114 && zaloQuote) {
              console.warn('[TG→Zalo] code 114 with quote, retrying without quote');
              return api.sendMessage(
                {
                  msg: msg.text,
                  ...(zaloMentions.length ? { mentions: zaloMentions } : {}),
                },
                zaloId,
                threadType,
              );
            }
            throw err;
          });
          const zaloMsgId = sendResult?.message?.msgId;
          if (zaloMsgId !== undefined) {
            sentMsgStore.save(msg.message_id, { msgId: zaloMsgId, zaloId, threadType });
          }
        } catch (err) {
          await notifyError('sendMessage', err);
        } finally {
          sentMsgStore.unmarkSending(zaloId);
        }
        return;
      }

      const TG_FILE_LIMIT = 20 * 1024 * 1024;
      const notifyTooBig = async (filename: string, sizeBytes?: number) => {
        const sizeMb = sizeBytes ? ` (${(sizeBytes / 1024 / 1024).toFixed(1)} MB)` : '';
        await notifyError(
          `sendAttachment(${filename})`,
          new Error(`File${sizeMb} vượt giới hạn 20 MB của Telegram Bot API — không thể tải xuống`),
        );
      };

      const sendAttachment = async (
        fileId: string,
        filename: string,
        fileSize?: number,
        caption?: string,
        captionMentions?: Array<{ pos: number; uid: string; len: number }>,
      ) => {
        if (fileSize !== undefined && fileSize > TG_FILE_LIMIT) {
          await notifyTooBig(filename, fileSize);
          return;
        }
        const replyToMsgId = 'reply_to_message' in msg
          ? (msg as { reply_to_message?: { message_id: number } }).reply_to_message?.message_id
          : undefined;
        const zaloQuote = replyToMsgId !== undefined ? msgStore.getQuote(replyToMsgId) : undefined;
        let fileLink: URL;
        try {
          fileLink = await ctx.telegram.getFileLink(fileId);
        } catch (err: unknown) {
          const isTooBig = err instanceof Error && err.message.includes('file is too big');
          if (isTooBig) { await notifyTooBig(filename, fileSize); return; }
          throw err;
        }
        const localPath = await downloadToTemp(fileLink.toString(), filename);
        sentMsgStore.markSending(zaloId, msg.message_id);
        try {
          console.log(`[TG→Zalo] Sending ${filename} → zaloId=${zaloId} type=${threadType}`);
          const withTimeout = <T>(p: Promise<T>) => Promise.race([
            p,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Send timeout (30s)')), 30_000),
            ),
          ]);

          const effectiveCaption = caption ?? '';

          const sendResult = await withTimeout(api.sendMessage(
            {
              msg: effectiveCaption,
              attachments: [localPath],
              ...(effectiveCaption.length && zaloQuote ? { quote: zaloQuote } : {}),
              ...(captionMentions?.length ? { mentions: captionMentions } : {}),
            },
            zaloId,
            threadType,
          )).catch(async (err: unknown) => {
            if ((err as { code?: number }).code === 114) {
              console.warn('[TG→Zalo] code 114 on attachment+quote, retrying without quote');
              return withTimeout(api.sendMessage(
                {
                  msg: effectiveCaption,
                  attachments: [localPath],
                  ...(captionMentions?.length ? { mentions: captionMentions } : {}),
                },
                zaloId,
                threadType,
              ));
            }
            throw err;
          }) as { message?: { msgId?: number } | null; attachment?: Array<{ msgId?: number }> };

          const zaloMsgId = sendResult?.message?.msgId ?? sendResult?.attachment?.[0]?.msgId;
          if (zaloMsgId !== undefined) {
            sentMsgStore.save(msg.message_id, { msgId: zaloMsgId, zaloId, threadType });
          }
          console.log(`[TG→Zalo] Send OK: ${filename}`);
        } catch (err) {
          await notifyError(`sendAttachment(${filename})`, err);
        } finally {
          sentMsgStore.unmarkSending(zaloId);
          await cleanTemp(localPath);
        }
      };

      const getCaptionMentions = () => {
        const cap = ('caption' in msg ? (msg as { caption?: string }).caption : undefined);
        const capEntities = ('caption_entities' in msg
          ? (msg as { caption_entities?: ReadonlyArray<TgEntity> }).caption_entities
          : undefined);
        const capMentions = cap
          ? resolveTgMentions(cap, capEntities, threadType === ThreadType.Group, zaloId)
          : undefined;
        return { cap, capMentions };
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
        try {
          for (const item of items) {
            if ((item.fileSize ?? 0) > 20 * 1024 * 1024) continue;
            let fileLink: URL;
            try { fileLink = await tgBot.telegram.getFileLink(item.fileId); }
            catch { continue; }
            localPaths.push(await downloadToTemp(fileLink.toString(), item.fname));
          }
          if (localPaths.length === 0) return;
          const sendResult = await api.sendMessage(
            {
              msg: caption,
              attachments: localPaths,
              ...(zaloQuote ? { quote: zaloQuote } : {}),
              ...(capMentions?.length ? { mentions: capMentions } : {}),
            },
            meta.zaloId,
            meta.threadType === 1 ? ThreadType.Group : ThreadType.User,
          );
          const zaloMsgId = sendResult?.message?.msgId ?? sendResult?.attachment?.[0]?.msgId;
          if (zaloMsgId !== undefined) {
            console.log(`[TG→Zalo] Media group sent: ${localPaths.length} files, zaloMsgId=${zaloMsgId}`);
          }
        } catch (err) {
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
        if (mediaGroupId) {
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
        await sendAttachment(photo.file_id, 'photo.jpg', photo.file_size, cap, capMentions);
        return;
      }

      if ('animation' in msg && msg.animation) {
        const fname = msg.animation.file_name ?? 'animation.gif';
        const { cap, capMentions } = getCaptionMentions();
        await sendAttachment(msg.animation.file_id, fname, msg.animation.file_size, cap, capMentions);
        return;
      }

      if ('document' in msg && msg.document) {
        const doc   = msg.document;
        const fname = doc.file_name ?? `file_${Date.now()}.bin`;
        const { cap, capMentions } = getCaptionMentions();
        await sendAttachment(doc.file_id, fname, doc.file_size, cap, capMentions);
        return;
      }

      if ('video' in msg && msg.video) {
        const vid   = msg.video;
        const fname = vid.file_name?.endsWith('.mp4') ? vid.file_name : `video_${Date.now()}.mp4`;
        const { cap, capMentions } = getCaptionMentions();
        const mediaGroupId = ('media_group_id' in msg ? (msg as { media_group_id?: string }).media_group_id : undefined);
        if (mediaGroupId) {
          const replyToMsgId = msg.reply_to_message?.message_id;
          mediaGroupStore.add(
            mediaGroupId,
            { fileId: vid.file_id, fname, fileSize: vid.file_size, caption: cap, captionMentions: capMentions },
            { topicId, zaloId, threadType: entry.type, replyToMsgId },
            (items, meta) => { void flushMediaGroup(items, meta); },
          );
          return;
        }

        if ((vid.file_size ?? 0) > TG_FILE_LIMIT) {
          await notifyTooBig(fname, vid.file_size);
          return;
        }
        let fileLink: URL;
        try { fileLink = await ctx.telegram.getFileLink(vid.file_id); }
        catch (err: unknown) {
          const isTooBig = err instanceof Error && err.message.includes('file is too big');
          if (isTooBig) { await notifyTooBig(fname, vid.file_size); return; }
          throw err;
        }
        const localVideoPath = await downloadToTemp(fileLink.toString(), fname);
        let localThumbPath: string | undefined;
        try {
          try { localThumbPath = await extractVideoThumbnail(localVideoPath); } catch { /* no thumb */ }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const videoUploads: any[] = await api.uploadAttachment([localVideoPath], zaloId, threadType);
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
              const thumbUploads: any[] = await api.uploadAttachment([localThumbPath], zaloId, threadType);
              const tu = thumbUploads?.[0] as { normalUrl?: string } | undefined;
              if (tu?.normalUrl) thumbUrl = tu.normalUrl;
            } catch { /* keep fallback thumbUrl */ }
          }

          sentMsgStore.markSending(zaloId, msg.message_id);
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = await (api.sendVideo as (...a: any[]) => Promise<{ msgId?: number }>)(
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
            );
            if (result?.msgId !== undefined) {
              sentMsgStore.save(msg.message_id, { msgId: result.msgId, zaloId, threadType });
            }
          } finally {
            sentMsgStore.unmarkSending(zaloId);
          }
        } catch (err) {
          console.error('[TG→Zalo] sendVideo failed, fallback to attachment:', err);
          try { await sendAttachment(vid.file_id, fname, vid.file_size, cap, capMentions); } catch { /* ignore */ }
        } finally {
          await cleanTemp(localVideoPath);
          if (localThumbPath) await cleanTemp(localThumbPath);
        }
        return;
      }

      if ('voice' in msg && msg.voice) {
        if ((msg.voice.file_size ?? 0) > TG_FILE_LIMIT) {
          await notifyTooBig(`voice_${Date.now()}.ogg`, msg.voice.file_size);
          return;
        }
        let fileLink: URL;
        try { fileLink = await ctx.telegram.getFileLink(msg.voice.file_id); }
        catch (err: unknown) {
          const isTooBig = err instanceof Error && err.message.includes('file is too big');
          if (isTooBig) { await notifyTooBig(`voice_${Date.now()}.ogg`, msg.voice.file_size); return; }
          throw err;
        }
        const oggPath  = await downloadToTemp(fileLink.toString(), `voice_${Date.now()}.ogg`);
        let m4aPath: string | undefined;
        try {
          m4aPath = await convertToM4a(oggPath);
          const uploaded = await api.uploadAttachment(m4aPath, zaloId, threadType) as Array<{ fileUrl?: string }>;
          const voiceUrl = uploaded[0]?.fileUrl;
          if (!voiceUrl) throw new Error('No fileUrl from uploadAttachment');
          console.log(`[TG→Zalo] Sending voice → ${voiceUrl}`);
          await api.sendVoice({ voiceUrl }, zaloId, threadType);
          console.log(`[TG→Zalo] Voice sent OK`);
        } catch (err) {
          console.error('[TG→Zalo] Voice convert/send failed, falling back to file:', err);
          await sendAttachment(msg.voice.file_id, `voice_${Date.now()}.ogg`);
        } finally {
          await cleanTemp(oggPath);
          if (m4aPath) await cleanTemp(m4aPath);
        }
        return;
      }

      if ('sticker' in msg && msg.sticker) {
        const sticker = msg.sticker;
        const useThumb = (sticker.is_animated || sticker.is_video) && sticker.thumbnail;
        const fileId   = useThumb ? sticker.thumbnail!.file_id : sticker.file_id;
        const ext      = useThumb ? '.jpg' : '.webp';
        await sendAttachment(fileId, `sticker_${Date.now()}${ext}`);
        return;
      }

      if ('poll' in msg && msg.poll) {
        const tgPoll = msg.poll;
        console.log(`[TG→Zalo] Received TG poll: id=${tgPoll.id} question="${tgPoll.question}" is_anonymous=${tgPoll.is_anonymous}`);

        if (threadType !== 1) {
          await ctx.reply('❌ Chỉ tạo bình chọn được trong nhóm Zalo.', { message_thread_id: topicId });
          return;
        }

        const { pollStore } = await import('../store/index.js');
        try {
          const created = await api.createPoll(
            {
              question:         tgPoll.question,
              options:          tgPoll.options.map((o: { text: string }) => o.text),
              isAnonymous:      false,
              allowMultiChoices: tgPoll.allows_multiple_answers ?? false,
            },
            zaloId,
          );
          console.log(`[TG→Zalo] Zalo poll created: pollId=${created?.poll_id}`);

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
          console.error('[TG→Zalo] createPoll failed:', err);
          await tgBot.telegram.sendMessage(
            config.telegram.groupId,
            '❌ Không thể tạo bình chọn trên Zalo.',
            { message_thread_id: topicId },
          );
        }
        return;
      }

      if ('location' in msg && msg.location) {
        const { latitude, longitude } = msg.location;
        const mapsUrl = `https://www.google.com/maps?q=${latitude},${longitude}`;
        try {
          await api.sendLink(
            { msg: '', link: mapsUrl },
            zaloId,
            threadType,
          );
          console.log(`[TG→Zalo] Location sent: ${latitude},${longitude}`);
        } catch (err) {
          await api.sendMessage({ msg: `📍 ${mapsUrl}` }, zaloId, threadType);
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
          try {
            await api.sendMessage({ msg: `👤 ${fullName} — ${contact.phone_number}` }, zaloId, threadType);
          } catch (err) {
            await notifyError('sendContact', err);
          }
          void body;
        }
        return;
      }
    } catch (err) {
      console.error('[TG→Zalo] Error:', err);
    }
  });
}
