import type { TgHandlerContext } from '../types.js';
import { store } from '../../store/index.js';
import { config } from '../../config.js';
import { escapeHtml } from '../../utils/format.js';

export function registerLeavegroupCommand({ bot, getApi }: TgHandlerContext): void {
  bot.command('leavegroup', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};

    if (!threadId) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '⚠️ Hãy gửi lệnh này <b>trong topic của nhóm</b> muốn rời.',
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    const entry = store.getEntryByTopic(threadId);
    if (!entry || entry.type !== 1) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '❌ Topic này không phải nhóm Zalo.',
        replyOpts,
      );
      return;
    }

    const currentApi = getApi();
    if (!currentApi) {
      await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Zalo chưa kết nối', replyOpts);
      return;
    }

    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      `⚠️ Bạn chắc muốn rời nhóm <b>${escapeHtml(entry.name)}</b>?\nBot sẽ rời nhóm Zalo và xoá topic này.`,
      {
        ...replyOpts,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Rời nhóm', callback_data: `lg:${threadId}` },
            { text: '❌ Huỷ',      callback_data: 'lg:cancel'       },
          ]],
        },
      },
    );
  });
}
