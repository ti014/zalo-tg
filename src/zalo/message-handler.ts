import { ThreadType } from 'zca-js';
import { createReadStream } from 'fs';
import path from 'path';
import QRCode from 'qrcode';

import type { ZaloAPI, ZaloMessage } from './types.js';
import { ZALO_MSG_TYPES } from './types.js';
import { store, msgStore, userCache, pollStore, sentMsgStore, zaloAlbumStore, aliasCache, type ZaloQuoteData } from '../store/index.js';
import { config } from '../config.js';
import { downloadToTemp, cleanTemp } from '../utils/media.js';
import { applyMentionsHtml, formatGroupMsgHtml, groupCaption, truncate, escapeHtml } from '../utils/format.js';
import {
  buildScoreText,
  getCachedGroupInfo,
  isMutedZaloGroup,
  parseBankCardHtml,
  parseContent,
  resolveUserDisplayName,
  tg,
} from './helpers.js';
import { getOrCreateTopic, isTopicDeletedError } from './topic.js';

const inFlightMsgIds = new Set<string>();

export function registerZaloMessageHandler(api: ZaloAPI): void {
  api.listener.on('message', async (msg: ZaloMessage) => {
    try {
      if (msg.isSelf) {
        const validId = (id: unknown): id is string | number => id !== undefined && id !== null && String(id) !== '' && String(id) !== '0';
        const selfMsgIds = [msg.data.msgId, msg.data.realMsgId, msg.data.cliMsgId]
          .filter(validId)
          .map(String);
        const tgSentMsgId = selfMsgIds
          .map(id => sentMsgStore.getByZaloMsgId(id))
          .find((id): id is number => id !== undefined);
        const pendingTgMsgId = tgSentMsgId ?? sentMsgStore.consumePendingTelegramMessage(msg.threadId);
        const isEcho = pendingTgMsgId !== undefined || sentMsgStore.isSendingTo(msg.threadId);
        if (pendingTgMsgId !== undefined) {
          const existing = sentMsgStore.get(pendingTgMsgId);
          const nextMsgId = validId(msg.data.realMsgId)
            ? msg.data.realMsgId
            : (validId(msg.data.msgId) ? msg.data.msgId : existing?.msgId);
          const nextCliMsgId = validId(msg.data.cliMsgId) ? msg.data.cliMsgId : existing?.cliMsgId;
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
          console.log(`[Zalo→TG] Skip bot echo (${selfMsgIds.join(', ')})`);
          return;
        }
      }

      const primaryMsgId = msg.data.msgId;
      if (primaryMsgId) {
        if (msgStore.getTgMsgId(primaryMsgId) !== undefined || inFlightMsgIds.has(primaryMsgId)) {
          console.log(`[Zalo→TG] Skip duplicate/reaction re-emit msgId=${primaryMsgId}`);
          return;
        }
        inFlightMsgIds.add(primaryMsgId);
        setTimeout(() => inFlightMsgIds.delete(primaryMsgId), 10_000);
      }

      const zaloId     = msg.threadId;
      const type       = msg.type as 0 | 1;
      const senderName = msg.data.dName ?? msg.data.uidFrom;
      const msgType    = msg.data.msgType ?? ZALO_MSG_TYPES.TEXT;

      if (type === ThreadType.Group && await isMutedZaloGroup(api, zaloId)) {
        console.log(`[Zalo→TG] Skip muted group ${zaloId}`);
        return;
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
        if (msgType === ZALO_MSG_TYPES.PHOTO) {
          let u = media.href;
          try { const p = JSON.parse(media.params ?? '{}') as { hd?: string }; if (p.hd) u = p.hd; } catch {}
          return u;
        }
        return undefined;
      })();
      const extGuess = eagerMediaUrl
        ? (path.extname(eagerMediaUrl.split('?')[0] ?? '').toLowerCase() || '.bin')
        : '.bin';
      const earlyDlPromise = eagerMediaUrl
        ? downloadToTemp(eagerMediaUrl, `dl_${Date.now()}${extGuess}`)
        : null;

      let displayName = senderName;
      let groupAvatarUrl: string | undefined;
      if (type === ThreadType.Group) {
        const info = await getCachedGroupInfo(api, zaloId);
        displayName = info.name || senderName;
        groupAvatarUrl = info.avt;
      } else {
        const aliasName = aliasCache.get(zaloId);
        const realName = aliasName ?? await resolveUserDisplayName(api, zaloId, senderName);
        displayName = aliasName ?? aliasCache.label(zaloId, realName);
      }

      const topicId = await getOrCreateTopic(zaloId, type, displayName, groupAvatarUrl);

      let tgReplyMsgId: number | undefined;
      if (msg.data.quote) {
        const globalId = String(msg.data.quote.globalMsgId);
        tgReplyMsgId = msgStore.getTgMsgId(globalId) ?? sentMsgStore.getByZaloMsgId(globalId);
      }

      const tgBase: {
        message_thread_id: number;
        reply_parameters?: { message_id: number; allow_sending_without_reply: boolean };
      } = { message_thread_id: topicId };
      if (tgReplyMsgId !== undefined) {
        tgBase.reply_parameters = { message_id: tgReplyMsgId, allow_sending_without_reply: true };
      }

      const caption = type === ThreadType.Group ? groupCaption(senderName) : undefined;
      const tgOpts  = { ...tgBase, parse_mode: 'HTML' as const, caption };

      const zaloMsgIds = msg.data.realMsgId && msg.data.realMsgId !== msg.data.msgId
        ? [msg.data.msgId, msg.data.realMsgId]
        : [msg.data.msgId];
      const zaloQuoteData: ZaloQuoteData = {
        msgId:    msg.data.msgId,
        cliMsgId: msg.data.cliMsgId ?? '',
        uidFrom:  msg.data.uidFrom,
        ts:       msg.data.ts,
        msgType:  msgType,
        content:  msg.data.content as string | Record<string, unknown>,
        ttl:      msg.data.ttl ?? 0,
        zaloId,
        threadType: type,
      };
      const saveTgMapping = (sent: { message_id: number }) => {
        msgStore.save(sent.message_id, zaloMsgIds, zaloQuoteData);
      };

      if (msgType === ZALO_MSG_TYPES.TEXT || (text !== null)) {
        const body = text ?? (typeof msg.data.content === 'string' ? msg.data.content : '');
        if (!body.trim()) return;
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
        if (!url) { console.warn('[ZaloHandler] Photo: no URL found in content:', media); return; }

        const photoCaption = media.description?.trim() || undefined;
        const albumKey = `${zaloId}:${msg.data.uidFrom}`;

        zaloAlbumStore.add(
          albumKey,
          url,
          zaloMsgIds[0],
          { senderName, topicId, tgBase, zaloQuote: zaloQuoteData },
          async (buf) => {
            if (buf.urls.length === 1) {
              const singleUrl = buf.urls[0]!;
              const localPath = await (earlyDlPromise ?? downloadToTemp(singleUrl, `photo_${Date.now()}.jpg`));
              const stream = createReadStream(localPath);
              try {
                const sent = await tg.sendPhoto(
                  config.telegram.groupId,
                  { source: stream },
                  {
                    ...buf.tgBase,
                    parse_mode: 'HTML' as const,
                    caption: type === ThreadType.Group
                      ? photoCaption
                        ? `${groupCaption(buf.senderName)}\n${escapeHtml(photoCaption)}`
                        : groupCaption(buf.senderName)
                      : photoCaption ? escapeHtml(photoCaption) : undefined,
                  },
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
                let firstSaved = false;
                for (let i = 0; i < localPaths.length; i += BATCH) {
                  const batch = localPaths.slice(i, i + BATCH);
                  const firstItemCaption = i === 0 ? captionText : undefined;
                  const sentMsgs = batch.length === 1
                    ? [await tg.sendPhoto(
                        config.telegram.groupId,
                        { source: createReadStream(batch[0]!) },
                        {
                          message_thread_id: buf.topicId,
                          ...(firstItemCaption ? { caption: firstItemCaption, parse_mode: 'HTML' as const } : {}),
                        },
                      )]
                    : await tg.sendMediaGroup(
                        config.telegram.groupId,
                        batch.map((lp, j) => ({
                          type: 'photo' as const,
                          media: { source: createReadStream(lp) },
                          ...(j === 0 && firstItemCaption ? { caption: firstItemCaption, parse_mode: 'HTML' as const } : {}),
                        })),
                        { message_thread_id: buf.topicId } as Parameters<typeof tg.sendMediaGroup>[2],
                      );
                  if (!firstSaved && sentMsgs.length > 0) {
                    firstSaved = true;
                    msgStore.save(sentMsgs[0]!.message_id, buf.zaloMsgIds, {
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
                  }
                }
              } finally {
                for (const lp of localPaths) await cleanTemp(lp);
              }
            }
          },
        );

        return;
      }

      if (msgType === ZALO_MSG_TYPES.DOODLE) {
        const url = media.href || media.thumb;
        if (!url) { console.warn('[ZaloHandler] Doodle: no URL'); return; }
        const localPath = await downloadToTemp(url, `doodle_${Date.now()}.jpg`);
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
          return;
        }
        const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.mp4';
        const localPath = await (earlyDlPromise ?? downloadToTemp(url, `gif_${Date.now()}${ext}`));
        const stream = createReadStream(localPath);
        try {
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
          return;
        }
        const localPath = await (earlyDlPromise ?? downloadToTemp(url, fileName));
        const stream = createReadStream(localPath);
        try {
          const sent = await tg.sendDocument(
            config.telegram.groupId,
            { source: stream, filename: fileName },
            tgOpts,
          );
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      if (msgType === ZALO_MSG_TYPES.VIDEO) {
        const url = media.href;
        if (!url) { console.warn('[ZaloHandler] Video: no URL found in content:', media); return; }
        const localPath = await (earlyDlPromise ?? downloadToTemp(url, `video_${Date.now()}.mp4`));
        const stream = createReadStream(localPath);
        try {
          const sent = await tg.sendVideo(config.telegram.groupId, { source: stream }, tgOpts);
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      if (msgType === ZALO_MSG_TYPES.VOICE) {
        const url = media.href;
        if (!url) { console.warn('[ZaloHandler] Voice: no URL found in content:', media); return; }
        const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.m4a';
        const localPath = await (earlyDlPromise ?? downloadToTemp(url, `voice_${Date.now()}${ext}`));
        const stream = createReadStream(localPath);
        try {
          const sent = await tg.sendVoice(config.telegram.groupId, { source: stream }, tgOpts);
          saveTgMapping(sent);
        } finally { await cleanTemp(localPath); }
        return;
      }

      if (msgType === ZALO_MSG_TYPES.STICKER) {
        const stickerId = media.id;
        if (!stickerId) {
          console.warn('[ZaloHandler] Sticker: no id in content:', media);
          return;
        }
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const details: any[] = await api.getStickersDetail([stickerId]);
          const detail = details?.[0];
          const url: string | undefined =
            detail?.stickerWebpUrl ?? detail?.stickerUrl ?? detail?.stickerSpriteUrl;
          if (!url) {
            console.warn('[ZaloHandler] Sticker: no URL in detail:', detail);
            return;
          }
          const ext = path.extname(url.split('?')[0] ?? '').toLowerCase() || '.webp';
          const localPath = await downloadToTemp(url, `sticker_${Date.now()}${ext}`);
          try {
            let sent: { message_id: number };
            try {
              const stream = createReadStream(localPath);
              sent = await tg.sendSticker(
                config.telegram.groupId,
                { source: stream },
                tgBase as Parameters<typeof tg.sendSticker>[2],
              );
            } catch {
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
          } else {
            console.error('[ZaloHandler] Sticker fetch error:', stickerErr);
          }
        }
        return;
      }

      if (msgType === ZALO_MSG_TYPES.LINK) {
        const href  = media.href;
        const title = media.title ?? href;
        if (!href) return;
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
            await tg.sendMessage(
              config.telegram.groupId,
              `${groupCaption(senderName)}📍 Vị trí`,
              { ...tgBase, parse_mode: 'HTML' },
            );
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

        if (!pollId) return;

        let pollDetail: Awaited<ReturnType<typeof api.getPollDetail>> | undefined;
        try {
          pollDetail = await api.getPollDetail(pollId);
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

          const scoreText = buildScoreText(header, pollDetail?.options ?? [], pollDetail?.closed ?? false);
          const tgScoreMsg = await tg.sendMessage(
            config.telegram.groupId,
            scoreText,
            { message_thread_id: topicId, parse_mode: 'HTML' },
          );

          pollStore.save({
            pollId,
            zaloGroupId:  zaloId,
            tgPollMsgId:  tgPollMsg.message_id,
            tgPollUUID:   (tgPollMsg as { poll?: { id?: string } }).poll?.id ?? '',
            tgScoreMsgId: tgScoreMsg.message_id,
            tgThreadId:   topicId,
            options: options.map(o => ({ option_id: o.option_id, content: o.content })),
          });
          saveTgMapping(tgPollMsg);
        } else {
          await new Promise(r => setTimeout(r, 800));
          let updatedDetail = pollDetail;
          try { updatedDetail = await api.getPollDetail(pollId); } catch { /* use existing */ }
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
              console.log(`[ZaloHandler] Poll ${pollId} score message edited OK`);
            } catch (editErr) {
              console.warn(`[ZaloHandler] Poll ${pollId} edit failed, sending new:`, editErr);
              const newScore = await tg.sendMessage(
                config.telegram.groupId,
                scoreText,
                { message_thread_id: existingEntry.tgThreadId, parse_mode: 'HTML',
                  reply_parameters: { message_id: existingEntry.tgPollMsgId, allow_sending_without_reply: true } },
              );
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
              const resp = await api.getUserInfo(uid) as {
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
              const localPath = await downloadToTemp(qrUrl, `qr_${Date.now()}.jpg`);
              const stream = createReadStream(localPath);
              const sent = await tg.sendPhoto(
                config.telegram.groupId,
                { source: stream },
                { ...tgBase, caption: fullText, parse_mode: 'HTML' },
              );
              saveTgMapping(sent);
              await cleanTemp(localPath);
            } catch {
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
      } else {
        console.error('[ZaloHandler] Error:', err);
      }
    }
  });
}
