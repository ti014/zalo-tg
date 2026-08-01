import { config } from '../../config.js';
import type { TgHandlerContext } from '../types.js';

export function registerRestartCommand({ bot, requestRestart }: TgHandlerContext): void {
  bot.command('restart', async ctx => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOptions = threadId ? { message_thread_id: threadId } : {};
    if (!requestRestart) {
      await ctx.reply(
        'Runtime hiện tại không khai báo process supervisor; /restart bị khóa để tránh tắt bridge vĩnh viễn.',
        replyOptions,
      );
      return;
    }
    await ctx.reply(
      'Khởi động lại bridge? Worker sẽ dừng có kiểm soát và supervisor sẽ tạo process mới.',
      {
        ...replyOptions,
        reply_markup: {
          inline_keyboard: [[
            { text: 'Khởi động lại', callback_data: `restart:confirm:${ctx.from.id}` },
            { text: 'Hủy', callback_data: `restart:cancel:${ctx.from.id}` },
          ]],
        },
      },
    );
  });
}
