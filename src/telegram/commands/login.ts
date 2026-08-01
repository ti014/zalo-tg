import type { TgHandlerContext } from '../types.js';
import { handleAppLoginCommand, handleLoginCommand } from '../helpers.js';
import { config } from '../../config.js';

export function registerLoginCommand({ bot, setApi, onZaloLogin }: TgHandlerContext): void {
  const registerWebLogin = (command: 'login' | 'loginweb') => bot.command(command, async (ctx) => {
    const isPrivate   = ctx.chat.type === 'private';
    const isFromGroup = ctx.chat.id === config.telegram.groupId;
    if (!isPrivate && !isFromGroup) {
      console.log(`[/login] Bỏ qua từ chat ${ctx.chat.id} (không phải group ${config.telegram.groupId} hoặc DM)`);
      return;
    }
    const threadId = isFromGroup ? ctx.message.message_thread_id : undefined;
    await handleLoginCommand(ctx.chat.id, threadId, (newApi) => {
      setApi(newApi);
      void onZaloLogin(newApi).catch((e: unknown) => console.error('[/login] onZaloLogin error:', e));
    });
  });

  registerWebLogin('login');
  registerWebLogin('loginweb');

  bot.command('loginapp', async (ctx) => {
    const isPrivate = ctx.chat.type === 'private';
    const isFromGroup = ctx.chat.id === config.telegram.groupId;
    if (!isPrivate && !isFromGroup) return;
    const threadId = isFromGroup ? ctx.message.message_thread_id : undefined;
    await handleAppLoginCommand(ctx.chat.id, threadId, (newApi) => {
      setApi(newApi);
      void onZaloLogin(newApi).catch((error: unknown) => {
        console.error('[/loginapp] onZaloLogin error:', error);
      });
    });
  });
}
