import type { TgHandlerContext } from '../types.js';
import { config } from '../../config.js';
import { store } from '../../store/index.js';
import { escapeHtml } from '../../utils/format.js';
import { ZALO_MSG_TYPES, type ZaloMessage } from '../../zalo/types.js';
import { requestGroupHistory, replayHistoryMessages } from '../../zalo/history.js';

export function registerHistoryCommand({ bot, getApi }: TgHandlerContext): void {
  bot.command('history', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const topicId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = topicId ? { message_thread_id: topicId } : {};
    if (!topicId) {
      await ctx.telegram.sendMessage(config.telegram.groupId, 'Hãy dùng <code>/history</code> trong topic nhóm Zalo.', {
        ...replyOpts, parse_mode: 'HTML',
      });
      return;
    }
    const entry = store.getEntryByTopic(topicId);
    if (!entry || entry.type !== 1) {
      await ctx.telegram.sendMessage(config.telegram.groupId, 'Lịch sử chỉ hỗ trợ topic của nhóm Zalo.', replyOpts);
      return;
    }
    const api = getApi();
    if (!api) {
      await ctx.telegram.sendMessage(config.telegram.groupId, 'Zalo chưa kết nối.', replyOpts);
      return;
    }
    const requested = Number.parseInt((ctx.message.text ?? '').split(/\s+/)[1] ?? '', 10);
    const count = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 50) : 30;
    try {
      await ctx.telegram.sendMessage(config.telegram.groupId, `⏳ Đang lấy ${count} tin nhắn gần nhất...`, replyOpts);
      const messages = await requestGroupHistory(api, entry.zaloId, count);
      const sorted = messages
        .filter(message => message.data.msgType !== ZALO_MSG_TYPES.POLL)
        .sort((a: ZaloMessage, b: ZaloMessage) => Number(a.data.ts ?? 0) - Number(b.data.ts ?? 0));
      const replayed = await replayHistoryMessages(sorted);
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `✅ Đã nạp ${replayed} tin nhắn lịch sử; tin trùng sẽ tự bỏ qua.`,
        replyOpts,
      );
    } catch (error) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `❌ Lỗi lấy lịch sử: ${escapeHtml(error instanceof Error ? error.message : String(error))}`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
    }
  });
}
