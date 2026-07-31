import { config } from '../../config.js';
import { store } from '../../store/index.js';
import type { TgHandlerContext } from '../types.js';

export function registerClearCommand({ bot, prepareMappingClear }: TgHandlerContext): void {
  bot.command('clear', async ctx => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};
    const confirm = ctx.message.text.trim().split(/\s+/)[1]?.toLowerCase() === 'confirm';

    if (!confirm) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `<b>Xóa mapping bridge</b>\n\n`
        + `Hiện có <b>${store.all().length}</b> topic mapping. Thao tác này cũng xóa message mapping của Telegram group hiện tại để tránh dùng ID cũ.\n\n`
        + `Không xóa chat Zalo và không xóa vật lý các Telegram topic đã tồn tại. Tin Zalo mới sẽ tạo mapping/topic mới.\n\n`
        + `Bridge chỉ thực hiện khi durable queue đã kết thúc toàn bộ delivery, sau đó sẽ tự restart.\n\n`
        + `Xác nhận bằng: <code>/clear confirm</code>`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    if (!prepareMappingClear) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        'Không thể chạy clear an toàn vì bridge chưa khởi tạo maintenance coordinator.',
        replyOpts,
      );
      return;
    }

    const preparation = prepareMappingClear();
    if (!preparation.accepted) {
      const message = preparation.reason === 'active_deliveries'
        ? `Chưa thể clear: còn <b>${preparation.activeDeliveries}</b> delivery chưa ở trạng thái kết thúc. `
          + `Dùng <code>/queue</code> để kiểm tra rồi thử lại.`
        : 'Một lần clear hoặc shutdown khác đang được thực hiện.';
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        message,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    try {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        'Đã nhận yêu cầu clear. Bridge sẽ dừng relay, xóa mapping trong một transaction rồi tự khởi động lại. '
        + 'Tin nhắn xác nhận cuối cùng sẽ được gửi trước khi restart.',
        { ...replyOpts, parse_mode: 'HTML' },
      );
      preparation.start?.();
    } catch (error) {
      preparation.cancel?.();
      console.error('[/clear] Failed to schedule mapping clear:', error);
      throw error;
    }
  });
}
