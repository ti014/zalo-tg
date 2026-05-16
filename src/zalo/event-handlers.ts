import { FriendEventType } from 'zca-js';
import type { ZaloAPI } from './types.js';
import { store, msgStore, pollStore, sentMsgStore, reactionEchoStore, reactionSummaryStore } from '../store/index.js';
import { config } from '../config.js';
import { escapeHtml } from '../utils/format.js';
import { buildScoreText, resolveUserDisplayName, tg } from './helpers.js';
import { runZaloRequest } from './rate-limit.js';

export function registerZaloEventHandlers(api: ZaloAPI): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('undo', async (undo: any) => {
    try {
      const data = undo?.data;
      const zaloMsgId = String(data?.content?.globalMsgId ?? data?.msgId ?? '');
      if (!zaloMsgId) return;

      const tgMsgId = msgStore.getTgMsgId(zaloMsgId);
      if (tgMsgId === undefined) {
        console.log(`[ZaloHandler] Undo: no TG mapping for zaloMsgId=${zaloMsgId}`);
        return;
      }

      const zaloId = undo?.threadId ?? data?.idTo;
      const type   = (undo?.isGroup ? 1 : 0) as 0 | 1;
      const topicId = store.getTopicByZalo(String(zaloId), type);
      if (topicId === undefined) return;

      await tg.deleteMessage(config.telegram.groupId, tgMsgId);
      console.log(`[ZaloHandler] Undo: deleted TG msg ${tgMsgId} (zaloMsgId=${zaloMsgId})`);

      await tg.sendMessage(
        config.telegram.groupId,
        `<i>🗑 Tin nhắn đã được thu hồi</i>`,
        { message_thread_id: topicId, parse_mode: 'HTML' },
      );
    } catch (err) {
      console.error('[ZaloHandler] Undo error:', err);
    }
  });

  const REACTION_EMOJI: Record<string, string> = {
    '/-heart':   '❤️',
    '/-strong':  '👍',
    ':>':        '😄',
    ':o':        '😮',
    ':-((':      '😢',
    ':-h':       '😡',
    ':-*':       '😘',
    ":')":       '😂',
    '/-shit':    '💩',
    '/-rose':    '🌹',
    '/-break':   '💔',
    '/-weak':    '👎',
    ';xx':       '🥰',
    ';-/':       '😕',
    ';-)':       '😉',
    '/-fade':    '✨',
    '/-ok':      '👌',
    '/-v':       '✌️',
    '/-thanks':  '🙏',
    '/-punch':   '👊',
    '/-no':      '🙅',
    '/-loveu':   '🤟',
    '--b':       '😞',
    ':((':       '😭',
    'x-)':       '😎',
    '_()_':      '🙏',
    '/-bd':      '🎂',
    '/-bome':    '💣',
    '/-beer':    '🍺',
    '/-li':      '☀️',
    '/-share':   '🔁',
    '/-bad':     '😤',
    '':          '❌',
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('reaction', async (reaction: any) => {
    try {
      const data = reaction?.data;
      const rIcon: string = data?.content?.rIcon ?? '';
      const emoji = REACTION_EMOJI[rIcon] ?? rIcon;

      if (!rIcon) return;

      const gMsgIds: Array<{ gMsgID?: string | number }> = data?.content?.rMsg ?? [];
      const zaloMsgId = String(gMsgIds[0]?.gMsgID ?? '');
      if (!zaloMsgId) return;

      const zaloId = String(reaction?.threadId ?? data?.idTo ?? "");
      if (!zaloId) return;

      if (reaction?.isSelf && reactionEchoStore.consume(zaloId, zaloMsgId, rIcon)) {
        console.log("[ZaloHandler] Reaction: skip bridge echo for " + zaloId + "/" + zaloMsgId + "/" + rIcon);
        return;
      }

      const tgMsgId = msgStore.getTgMsgId(zaloMsgId) ?? sentMsgStore.getByZaloMsgId(zaloMsgId);
      if (tgMsgId === undefined) {
        console.log(`[ZaloHandler] Reaction: no TG mapping for zaloMsgId=${zaloMsgId}`);
        return;
      }

      const type = (reaction?.isGroup ? 1 : 0) as 0 | 1;
      const topicId = store.getTopicByZalo(zaloId, type);
      if (topicId === undefined) return;

      const rawName = typeof data?.dName === 'string' ? data.dName.trim() : '';
      const actorUid = typeof data?.uidFrom === 'string' ? data.uidFrom : undefined;
      const actorName = rawName || await resolveUserDisplayName(api, actorUid, 'ai đó');

      const entry = reactionSummaryStore.upsert(tgMsgId, emoji, actorName);

      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      entry.debounceTimer = setTimeout(async () => {
        entry.debounceTimer = null;
        const text = reactionSummaryStore.buildText(entry);
        if (!text) return;
        if (text === entry.lastSentText) return;
        try {
          if (entry.summaryTgMsgId === null) {
            const sent = await tg.sendMessage(
              config.telegram.groupId,
              text,
              {
                message_thread_id: topicId,
                parse_mode: 'HTML',
                reply_parameters: { message_id: tgMsgId, allow_sending_without_reply: true },
              },
            );
            reactionSummaryStore.setSummaryMsgId(tgMsgId, sent.message_id);
            entry.lastSentText = text;
          } else {
            await tg.editMessageText(
              config.telegram.groupId,
              entry.summaryTgMsgId,
              undefined,
              text,
              { parse_mode: 'HTML' },
            );
            entry.lastSentText = text;
          }
        } catch (editErr) {
          const msg = editErr instanceof Error ? editErr.message : String(editErr);
          if (!msg.includes('message is not modified')) {
            console.warn('[ZaloHandler] Reaction summary update failed:', editErr);
          }
        }
      }, 600);
    } catch (err) {
      console.error('[ZaloHandler] Reaction error:', err);
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('group_event', async (event: any) => {
    try {
      const type    = event?.type as string | undefined;
      const data    = event?.data;
      const groupId = String(event?.threadId ?? data?.groupId ?? '');
      if (!groupId) return;

      if (type === 'update_board' || type === 'remove_board') {
        const rawParams = data?.groupTopic?.params ?? data?.topic?.params ?? '';
        let params: { boardType?: number; pollId?: number } = {};
        try { params = JSON.parse(rawParams); } catch { /* ignore */ }
        if (params.boardType === 3 && params.pollId) {
          const pollId = params.pollId;
          console.log(`[ZaloHandler] group_event update_board pollId=${pollId}`);
          const entry = pollStore.getByPollId(pollId);
          if (entry) {
            await new Promise(r => setTimeout(r, 600));
            let detail: Awaited<ReturnType<typeof api.getPollDetail>> | undefined;
            try {
              detail = await runZaloRequest(
                { label: `getPollDetail(${pollId}:group_event)`, priority: 'low', maxRetries: 0 },
                () => api.getPollDetail(pollId),
              );
            } catch { /* ignore */ }
            if (detail?.options) {
              const actorName = data?.updateMembers?.[0]?.dName ?? data?.creatorId ?? '';
              const header = actorName ? `${actorName} vừa bình chọn` : 'Cập nhật bình chọn';
              const scoreText = buildScoreText(header, detail.options, detail.closed ?? false);
              console.log(`[ZaloHandler] Poll ${pollId} update:`, detail.options.map((o: { content: string; votes: number }) => `${o.content}=${o.votes}`).join(', '));
              try {
                await tg.editMessageText(
                  config.telegram.groupId,
                  entry.tgScoreMsgId,
                  undefined,
                  scoreText,
                  {
                    parse_mode: 'HTML',
                    reply_markup: detail.closed
                      ? { inline_keyboard: [] }
                      : { inline_keyboard: [[{ text: '🔒 Khoá bình chọn', callback_data: `lock_poll:${pollId}` }]] },
                  },
                );
              } catch {
                const newScore = await tg.sendMessage(
                  config.telegram.groupId,
                  scoreText,
                  { message_thread_id: entry.tgThreadId, parse_mode: 'HTML',
                    reply_parameters: { message_id: entry.tgPollMsgId, allow_sending_without_reply: true },
                    reply_markup: detail.closed
                      ? { inline_keyboard: [] }
                      : { inline_keyboard: [[{ text: '🔒 Khoá bình chọn', callback_data: `lock_poll:${pollId}` }]] } },
                );
                pollStore.updateScoreMsg(pollId, newScore.message_id);
              }
            }
          } else {
            console.log(`[ZaloHandler] update_board pollId=${pollId} not in pollStore (no TG mapping)`);
          }
        }
        return;
      }

      const NOTIFY_TYPES = new Set(['join', 'leave', 'remove_member', 'block_member']);
      if (!type || !NOTIFY_TYPES.has(type)) return;

      const topicId = store.getTopicByZalo(groupId, 1);
      if (topicId === undefined) return;

      const members: Array<{ dName?: string }> = data?.updateMembers ?? [];
      const names = members.map(m => m.dName ?? '?').join(', ');
      const actor  = data?.creatorId === data?.sourceId ? '' : '';
      void actor;

      let notifText = '';
      if (type === 'join') {
        notifText = `➕ <b>${escapeHtml(names)}</b> đã tham gia nhóm`;
      } else if (type === 'leave') {
        notifText = `➖ <b>${escapeHtml(names)}</b> đã rời nhóm`;
      } else if (type === 'remove_member') {
        notifText = `🚫 <b>${escapeHtml(names)}</b> đã bị xóa khỏi nhóm`;
      } else if (type === 'block_member') {
        notifText = `🔒 <b>${escapeHtml(names)}</b> đã bị chặn khỏi nhóm`;
      }

      if (!notifText) return;

      await tg.sendMessage(
        config.telegram.groupId,
        `<i>${notifText}</i>`,
        { message_thread_id: topicId, parse_mode: 'HTML' },
      );
      console.log(`[ZaloHandler] GroupEvent type=${type} group=${groupId}`);
    } catch (err) {
      console.error('[ZaloHandler] GroupEvent error:', err);
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('friend_event', async (evt: any) => {
    try {
      if (evt.type !== FriendEventType.REQUEST) return;
      if (evt.isSelf) return;

      const data = evt.data as { fromUid?: string; message?: string } | undefined;
      const fromUid = data?.fromUid;
      if (!fromUid) return;

      let displayName = fromUid;
      try {
        const info = await runZaloRequest(
          { label: `getUserInfo(friend:${fromUid})`, priority: 'low', maxRetries: 0 },
          () => api.getUserInfo(fromUid),
        ) as {
          display_name?: string;
          zaloName?: string;
          changed_profiles?: Record<string, { displayName?: string; zaloName?: string }>;
          unchanged_profiles?: Record<string, { displayName?: string; zaloName?: string }>;
        } | undefined;
        const profile = info?.changed_profiles?.[fromUid] ?? info?.unchanged_profiles?.[fromUid];
        displayName = info?.display_name ?? profile?.displayName ?? info?.zaloName ?? profile?.zaloName ?? fromUid;
      } catch {
        // Keep UID fallback when profile lookup fails.
      }

      const requestMessage = data?.message?.trim();
      await tg.sendMessage(
        config.telegram.groupId,
        `<b>${escapeHtml(displayName)}</b> muốn kết bạn với bạn qua Zalo.${requestMessage ? `\n<i>${escapeHtml(requestMessage)}</i>` : ''}`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[
              { text: 'Chấp nhận', callback_data: `fr:accept:${fromUid}` },
              { text: 'Từ chối', callback_data: `fr:reject:${fromUid}` },
            ]],
          },
        },
      );
      console.log(`[ZaloHandler] FriendEvent REQUEST from ${fromUid} (${displayName})`);
    } catch (err) {
      console.error('[ZaloHandler] FriendEvent error:', err);
    }
  });
}
