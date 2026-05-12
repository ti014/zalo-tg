import type { TgHandlerContext } from '../types.js';
import { config } from '../../config.js';
import { escapeHtml } from '../../utils/format.js';

export function registerAddfriendCommand({ bot, getApi }: TgHandlerContext): void {
  bot.command('addfriend', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};

    const currentApi = getApi();
    if (!currentApi) {
      await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Zalo chưa kết nối', replyOpts);
      return;
    }

    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const phone = text.split(/\s+/)[1]?.replace(/[^0-9+]/g, '');
    if (!phone) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '⚠️ Dùng: <code>/addfriend &lt;số điện thoại&gt;</code>\nVí dụ: <code>/addfriend 0912345678</code>',
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    try {
      const user = await currentApi.findUser(phone) as {
        uid?: string; display_name?: string; zalo_name?: string; avatar?: string;
        globalId?: string;
      } | undefined;

      if (!user?.uid) {
        await ctx.telegram.sendMessage(
          config.telegram.groupId,
          `❌ Không tìm thấy người dùng với SĐT <code>${phone}</code>`,
          { ...replyOpts, parse_mode: 'HTML' },
        );
        return;
      }

      const name = user.display_name ?? user.zalo_name ?? `UID ${user.uid}`;
      const status = await currentApi.getFriendRequestStatus(user.uid) as {
        is_friend?: number; is_requested?: number; is_requesting?: number;
      } | undefined;

      let statusLine = '';
      if (status?.is_friend) statusLine = '✅ Đã là bạn bè';
      else if (status?.is_requesting) statusLine = '⏳ Đang chờ họ chấp nhận';
      else if (status?.is_requested) statusLine = '📩 Họ đang chờ bạn chấp nhận';

      const keyboard = statusLine ? [] : [[{
        text: `➕ Kết bạn với ${name}`,
        callback_data: `af:${user.uid}`,
      }]];

      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `👤 <b>${escapeHtml(name)}</b>\n📱 ${escapeHtml(phone)}${statusLine ? `\n${statusLine}` : ''}`,
        {
          ...replyOpts,
          parse_mode: 'HTML',
          ...(keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
        },
      );
    } catch (err) {
      console.error('[/addfriend]', err);
      await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Lỗi tìm kiếm người dùng.', replyOpts);
    }
  });
}
