import type { TgHandlerContext } from '../types.js';
import { config } from '../../config.js';
import { buildMenuView } from '../ui/status.js';

export function registerMenuCommand({ bot, getApi }: TgHandlerContext): void {
  bot.command('menu', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const view = buildMenuView(getApi);

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
