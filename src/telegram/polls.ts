import type { TgHandlerContext } from './types.js';
import { pollStore } from '../store/index.js';
import { tgBot } from './bot.js';
import { config } from '../config.js';
import { doLockPoll } from './callbacks.js';
import { runZaloRequest } from '../zalo/rate-limit.js';

export function registerPollHandlers({ bot, getApi }: TgHandlerContext): void {
  bot.on('poll', async (ctx) => {
    try {
      const poll = ctx.poll;
      if (!poll.is_closed) return;
      const entry = pollStore.getByTgPollUUID(poll.id);
      const currentApi = getApi();
      if (!entry || !currentApi) return;
      await doLockPoll(entry, currentApi);
    } catch (err) {
      console.error('[TG→Zalo] lockPoll error:', err);
    }
  });

  bot.on('poll_answer', async (ctx) => {
    try {
      const answer = ctx.pollAnswer;

      const tgPollUUID = answer.poll_id;
      console.log(`[TG→Zalo] poll_answer: poll_id=${tgPollUUID} option_ids=[${answer.option_ids}]`);
      const entry = pollStore.getByTgPollUUID(tgPollUUID);
      if (!entry) {
        console.log('[TG→Zalo] poll_answer: unknown poll UUID', tgPollUUID);
        return;
      }

      const currentApi = getApi();
      if (!currentApi) return;
      const api = currentApi;

      const optionIds = answer.option_ids
        .map(idx => entry.options[idx]?.option_id)
        .filter((id): id is number => id !== undefined);

      const refreshScore = async () => {
        try {
          const detail = await runZaloRequest(
            { label: `getPollDetail(${entry.pollId})`, priority: 'low', maxRetries: 0 },
            () => api.getPollDetail(entry.pollId),
          ) as { options?: Array<{ content: string; votes: number }>; closed?: boolean } | undefined;
          if (!detail?.options) return;
          const total = detail.options.reduce((s: number, o: { votes: number }) => s + (o.votes ?? 0), 0);
          const lines = (detail.options as Array<{ content: string; votes: number }>).map(o => {
            const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
            const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
            return `${o.content}\n  ${bar} ${o.votes} phiếu (${pct}%)`;
          });
          const status = detail.closed ? ' <i>[Đã đóng]</i>' : '';
          const scoreText = `📊 <b>Kết quả bình chọn${status}</b>\n\nTổng: ${total} phiếu\n\n${lines.join('\n\n')}`;
          const replyMarkup = detail.closed
            ? { inline_keyboard: [] as { text: string; callback_data: string }[][] }
            : { inline_keyboard: [[{ text: '🔒 Khoá bình chọn', callback_data: `lock_poll:${entry.pollId}` }]] };
          try {
            await tgBot.telegram.editMessageText(
              config.telegram.groupId,
              entry.tgScoreMsgId,
              undefined,
              scoreText,
              { parse_mode: 'HTML', reply_markup: replyMarkup },
            );
          } catch {
            const newMsg = await tgBot.telegram.sendMessage(
              config.telegram.groupId,
              scoreText,
              { message_thread_id: entry.tgThreadId, parse_mode: 'HTML',
                reply_parameters: { message_id: entry.tgPollMsgId, allow_sending_without_reply: true },
                reply_markup: replyMarkup },
            );
            pollStore.updateScoreMsg(entry.pollId, newMsg.message_id);
          }
        } catch (e) {
          console.warn('[TG→Zalo] poll score refresh failed:', e);
        }
      };

      if (optionIds.length === 0) {
        try {
          await runZaloRequest(
            { label: `votePoll(${entry.pollId})`, priority: 'high' },
            () => api.votePoll(entry.pollId, []),
          );
          console.log(`[TG→Zalo] Unvoted poll ${entry.pollId}`);
        } catch (e) {
          console.warn('[TG→Zalo] unvote failed:', e);
        }
        await refreshScore();
        return;
      }

      await runZaloRequest(
        { label: `votePoll(${entry.pollId})`, priority: 'high' },
        () => api.votePoll(entry.pollId, optionIds.length === 1 ? optionIds[0] : optionIds),
      );
      console.log(`[TG→Zalo] Voted poll ${entry.pollId} options [${optionIds}]`);

      await refreshScore();
    } catch (err) {
      console.error('[TG→Zalo] poll_answer error:', err);
    }
  });
}
