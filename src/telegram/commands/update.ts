import type { TgHandlerContext } from '../types.js';
import { config } from '../../config.js';
import { triggerUpdateCheck } from '../../updater.js';

export function registerUpdateCommand({ bot }: TgHandlerContext): void {
  bot.command('update', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};
    try {
      const found = await triggerUpdateCheck(ctx.telegram);
      if (!found) {
        await ctx.reply('Bridge đã bao phủ mốc upstream mới nhất đã cấu hình.', {
          ...replyOpts,
          parse_mode: 'HTML',
        });
      }
    } catch (error) {
      console.error('[/update]', error);
      await ctx.reply('Không kiểm tra được bản cập nhật lúc này.', replyOpts);
    }
  });
}
