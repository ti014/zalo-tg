import type { TgHandlerContext } from '../types.js';
import { config } from '../../config.js';
import { buildStatusView } from '../ui/status.js';

export function registerStatusCommand({ bot, getApi }: TgHandlerContext): void {
  bot.command('status', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;

    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const view = await buildStatusView(getApi, { forceRefresh: true });

    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      view.text,
      {
        ...(threadId ? { message_thread_id: threadId } : {}),
        parse_mode: 'HTML',
        reply_markup: view.replyMarkup,
      },
    );
  });
}
