import type { Context, Telegraf } from 'telegraf';

import { config, isOwner } from '../config.js';
import {
  commandNameFromUpdate,
  isAnonymousAdminUpdate,
  requiresOwner,
  updateChatId,
} from './authorization-policy.js';

function isPrivateLogin(update: unknown, ctx: Context): boolean {
  return commandNameFromUpdate(update) === 'login' && ctx.chat?.type === 'private';
}

async function deny(ctx: Context, anonymousAdmin: boolean): Promise<void> {
  const message = anonymousAdmin
    ? 'Telegram đang gửi lệnh dưới danh tính anonymous admin nên bot không nhận được user ID owner. '
      + 'Hãy tắt Remain Anonymous hoặc chọn gửi bằng tài khoản cá nhân rồi thử lại.'
    : 'Bạn không có quyền thực hiện thao tác này.';
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(message).catch(() => undefined);
    return;
  }
  if (ctx.chat?.id === config.telegram.groupId || ctx.chat?.type === 'private') {
    await ctx.reply(message).catch(() => undefined);
  }
}

/** Register before commands/events so every privileged update has one gate. */
export function registerOwnerAuthorization(bot: Telegraf): void {
  bot.use(async (ctx, next) => {
    if (!requiresOwner(ctx.update)) return next();

    const chatId = updateChatId(ctx.update);
    const allowedLocation = chatId === undefined
      || chatId === config.telegram.groupId
      || isPrivateLogin(ctx.update, ctx);
    if (!allowedLocation || !isOwner(ctx.from?.id)) {
      await deny(ctx, isAnonymousAdminUpdate(ctx.update));
      return;
    }
    return next();
  });
}
