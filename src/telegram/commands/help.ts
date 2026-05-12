import type { TgHandlerContext } from '../types.js';
import { config } from '../../config.js';
import { renderHelp } from '../ui/renderers.js';
import { helpKeyboard } from '../ui/keyboards.js';

export function registerHelpCommand({ bot }: TgHandlerContext): void {
  bot.command('help', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;

    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      renderHelp(),
      {
        ...(threadId ? { message_thread_id: threadId } : {}),
        parse_mode: 'HTML',
        reply_markup: helpKeyboard(),
      },
    );
  });
}
