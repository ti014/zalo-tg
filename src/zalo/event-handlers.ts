import { FriendEventType, ThreadType } from 'zca-js';
import type { ZaloAPI } from './types.js';
import {
  store,
  msgStore,
  pollStore,
  sentMsgStore,
  reactionEchoStore,
  reactionSummaryStore,
  reactionEventDedupeStore,
  wasRecentlyRecalled,
} from '../store/index.js';
import { config } from '../config.js';
import { escapeHtml, topicName } from '../utils/format.js';
import {
  buildScoreText,
  invalidateCachedGroupInfo,
  resolveUserDisplayName,
  tg,
} from './helpers.js';
import { runZaloRequest } from './rate-limit.js';
import {
  extractReactionTargetMsgIds,
  ZALO_TO_TELEGRAM_REACTION,
} from './reaction.js';
import { extractUndoTargetId, parseGroupRename } from './system-events.js';

interface GroupEventMember {
  id?: unknown;
  uid?: unknown;
  userId?: unknown;
  dName?: unknown;
}

function groupEventMemberUid(member: GroupEventMember): string {
  return String(member.id ?? member.uid ?? member.userId ?? '').split('_')[0]?.trim() ?? '';
}

async function resolveGroupEventMemberNames(
  api: ZaloAPI,
  members: GroupEventMember[],
  groupId: string,
): Promise<string> {
  const names = await Promise.all(members.map(member => {
    const uid = groupEventMemberUid(member);
    const fallback = typeof member.dName === 'string' && member.dName.trim()
      ? member.dName.trim()
      : uid || '?';
    return resolveUserDisplayName(api, uid || undefined, fallback, groupId);
  }));
  return names.join(', ');
}

export function registerZaloEventHandlers(api: ZaloAPI): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('undo', async (undo: any) => {
    try {
      const data = undo?.data;
      const zaloMsgId = extractUndoTargetId(undo);
      if (!zaloMsgId) return;

      if (wasRecentlyRecalled(zaloMsgId)) {
        console.log(`[ZaloHandler] Undo: skip bridge-initiated recall msgId=${zaloMsgId}`);
        return;
      }

      const tgMsgId = msgStore.getTgMsgId(zaloMsgId);
      if (tgMsgId === undefined) {
        console.log(`[ZaloHandler] Undo: no TG mapping for zaloMsgId=${zaloMsgId}`);
        return;
      }

      const zaloId = undo?.threadId ?? data?.idTo;
      const type   = (undo?.isGroup ? 1 : 0) as 0 | 1;
      const topicId = store.getTopicByZalo(String(zaloId), type);
      if (topicId === undefined) return;

      await tg.sendMessage(
        config.telegram.groupId,
        '<i>🗑 Tin nhắn này đã bị thu hồi trên Zalo</i>',
        {
          message_thread_id: topicId,
          parse_mode: 'HTML',
          reply_parameters: { message_id: tgMsgId, allow_sending_without_reply: true },
        },
      );
      console.log(`[ZaloHandler] Undo: notified TG msg ${tgMsgId} (zaloMsgId=${zaloMsgId})`);
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

      const targetMsgIds = extractReactionTargetMsgIds(data);
      if (targetMsgIds.length === 0) return;

      const zaloId = String(reaction?.threadId ?? data?.idTo ?? "");
      if (!zaloId) return;

      const rawName = typeof data?.dName === 'string' ? data.dName.trim() : '';
      const actorUid = typeof data?.uidFrom === 'string' ? data.uidFrom.trim() : '';
      if (reactionEventDedupeStore.isDuplicateZaloInbound({
        zaloId,
        targetMsgIds,
        icon: rIcon,
        ...(actorUid ? { actorUid } : {}),
        ...(rawName ? { actorName: rawName } : {}),
      })) {
        console.log(`[ZaloHandler] Reaction: skip duplicate ${zaloId}/${targetMsgIds.join('|')}/${rIcon}`);
        return;
      }

      if (reaction?.isSelf && targetMsgIds.some(id => reactionEchoStore.consume(zaloId, id, rIcon))) {
        console.log(`[ZaloHandler] Reaction: skip bridge echo for ${zaloId}/${targetMsgIds.join('|')}/${rIcon}`);
        return;
      }

      let tgMsgId: number | undefined;
      for (const targetMsgId of targetMsgIds) {
        tgMsgId = msgStore.getTgMsgId(targetMsgId)
          ?? sentMsgStore.getByZaloMsgId(targetMsgId);
        if (tgMsgId !== undefined) break;
      }
      if (tgMsgId === undefined) {
        console.log(`[ZaloHandler] Reaction: no TG mapping for targets=${targetMsgIds.join('|')}`);
        return;
      }

      const type = (reaction?.isGroup ? 1 : 0) as 0 | 1;
      const topicId = store.getTopicByZalo(zaloId, type);
      if (topicId === undefined) return;

      const nativeReaction = ZALO_TO_TELEGRAM_REACTION[rIcon];
      if (type === 0 && nativeReaction) {
        try {
          await tg.setMessageReaction(
            config.telegram.groupId,
            tgMsgId,
            [{ type: 'emoji', emoji: nativeReaction }] as Parameters<typeof tg.setMessageReaction>[2],
          );
          return;
        } catch (error) {
          console.warn(`[ZaloHandler] Native reaction ${nativeReaction} rejected; using summary:`, error);
        }
      }

      const actorName = await resolveUserDisplayName(
        api,
        actorUid || undefined,
        rawName || 'ai đó',
        type === 1 ? zaloId : undefined,
      );

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

  api.listener.on('old_reactions', (reactions: unknown[], isGroup: boolean) => {
    if (!Array.isArray(reactions) || reactions.length === 0) return;
    for (const item of reactions) {
      if (!item || typeof item !== 'object') continue;
      const reaction = item as Record<string, unknown>;
      if (reaction.isGroup === undefined) reaction.isGroup = isGroup;
      api.listener.emit('reaction', reaction);
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api.listener.on('group_event', async (event: any) => {
    try {
      const type    = event?.type as string | undefined;
      const data    = event?.data;
      const groupId = String(event?.threadId ?? data?.groupId ?? '');
      if (!groupId) return;

      if (type === 'join_request') {
        const uids = Array.isArray(data?.uids) ? data.uids.map((uid: unknown) => String(uid)).filter(Boolean) : [];
        if (uids.length === 0) return;
        let adminIds: string[] = [];
        let creatorId = '';
        try {
          const info = await runZaloRequest(
            { label: `getGroupInfo(join_request:${groupId})`, priority: 'low', maxRetries: 0 },
            () => api.getGroupInfo(groupId),
          ) as { gridInfoMap?: Record<string, { adminIds?: string[]; creatorId?: string }> };
          adminIds = info?.gridInfoMap?.[groupId]?.adminIds ?? [];
          creatorId = info?.gridInfoMap?.[groupId]?.creatorId ?? '';
        } catch { /* fall through and do not expose a possibly unauthorized action */ }
        const ownId = String(api.getOwnId?.() ?? '');
        if (!ownId || (!adminIds.includes(ownId) && creatorId !== ownId)) return;
        const topicId = store.getTopicByZalo(groupId, 1);
        if (topicId === undefined) return;
        for (const uid of uids) {
          const name = await resolveUserDisplayName(api, uid, uid);
          await tg.sendMessage(
            config.telegram.groupId,
            `🔔 <b>${escapeHtml(name)}</b> (<code>${escapeHtml(uid)}</code>) muốn tham gia nhóm.`,
            {
              message_thread_id: topicId,
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [[
                  { text: 'Duyệt', callback_data: `gm:approve:${groupId}:${uid}` },
                  { text: 'Từ chối', callback_data: `gm:reject:${groupId}:${uid}` },
                ]],
              },
            },
          );
        }
        return;
      }

      const renamedTo = parseGroupRename(type, data);
      if (renamedTo) {
        const topicId = store.getTopicByZalo(groupId, 1);
        if (topicId !== undefined) {
          await tg.editForumTopic(
            config.telegram.groupId,
            topicId,
            { name: topicName(renamedTo, 1) },
          );
          const existing = store.getEntryByTopic(topicId);
          if (existing) store.set({ ...existing, name: renamedTo });
          invalidateCachedGroupInfo(groupId);
        }
        return;
      }

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
              const actorMember = data?.updateMembers?.[0] as GroupEventMember | undefined;
              const actorUid = actorMember
                ? groupEventMemberUid(actorMember)
                : String(data?.creatorId ?? '');
              const actorFallback = typeof actorMember?.dName === 'string'
                ? actorMember.dName
                : actorUid;
              const actorName = await resolveUserDisplayName(
                api,
                actorUid || undefined,
                actorFallback,
                groupId,
              );
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

      const members: GroupEventMember[] = data?.updateMembers ?? [];
      const names = await resolveGroupEventMemberNames(api, members, groupId);
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

      const displayName = await resolveUserDisplayName(api, fromUid, fromUid);

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

  const typingForwardedAt = new Map<string, number>();
  const typingThrottleMs = 4_000;

  api.listener.on('typing', async (typing: any) => {
    try {
      const zaloId = String(
        typing?.threadId ?? typing?.data?.gid ?? typing?.data?.uid ?? '',
      );
      if (!zaloId) return;
      const type = typing?.type === ThreadType.Group || typing?.data?.gid ? 1 : 0;
      const topicId = store.getTopicByZalo(zaloId, type as 0 | 1);
      if (topicId === undefined) return;
      const now = Date.now();
      if (now - (typingForwardedAt.get(zaloId) ?? 0) < typingThrottleMs) return;
      typingForwardedAt.set(zaloId, now);
      await tg.sendChatAction(
        config.telegram.groupId,
        'typing',
        { message_thread_id: topicId },
      );
    } catch (error) {
      console.warn('[ZaloHandler] Typing error:', error);
    }
  });

  const seenTelegramMessageIds = new Set<number>();
  const seenDedupeMax = 2_000;

  api.listener.on('seen_messages', async (messages: any[]) => {
    if (!Array.isArray(messages)) return;
    for (const message of messages) {
      try {
        const data = message?.data ?? {};
        const candidates = [data.msgId, data.realMsgId, data.cliMsgId]
          .map((id: unknown) => id === undefined || id === null ? '' : String(id).trim())
          .filter((id: string) => id && id !== '0');
        let telegramMessageId: number | undefined;
        for (const candidate of candidates) {
          telegramMessageId = sentMsgStore.getByZaloMsgId(candidate)
            ?? msgStore.getTgMsgId(candidate);
          if (telegramMessageId !== undefined) break;
        }
        if (
          telegramMessageId === undefined
          || seenTelegramMessageIds.has(telegramMessageId)
        ) continue;
        if (seenTelegramMessageIds.size >= seenDedupeMax) seenTelegramMessageIds.clear();
        seenTelegramMessageIds.add(telegramMessageId);
        await tg.setMessageReaction(
          config.telegram.groupId,
          telegramMessageId,
          [{ type: 'emoji', emoji: '👀' }] as Parameters<typeof tg.setMessageReaction>[2],
        );
      } catch (error) {
        console.warn('[ZaloHandler] Seen error:', error);
      }
    }
  });
}
