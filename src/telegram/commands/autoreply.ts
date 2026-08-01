import type { TgHandlerContext } from '../types.js';
import { config } from '../../config.js';
import { escapeHtml } from '../../utils/format.js';
import {
  AUTO_REPLY_COOLDOWN_MIN,
  AUTO_REPLY_MAX_PER_HOUR,
  getAutoReplyState,
  setAutoReplyEnabled,
} from '../../zalo/auto-reply.js';

export function registerAutoReplyCommand({ bot }: TgHandlerContext): void {
  bot.command('autoreply', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};
    const rest = (ctx.message.text ?? '').replace(/^\/autoreply(?:@\S+)?\s*/i, '').trim();
    const [subcommand, ...parts] = rest.split(/\s+/);
    const sub = (subcommand ?? '').toLowerCase();

    if (!sub || sub === 'status') {
      const current = getAutoReplyState();
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `🤖 <b>Auto-reply</b>: ${current.enabled ? '🟢 BẬT' : '🔴 TẮT'}\n`
          + (current.message ? `Nội dung: <i>${escapeHtml(current.message)}</i>` : 'Chưa đặt nội dung.')
          + `\n\nDùng: <code>/autoreply on &lt;nội dung&gt;</code> | <code>/autoreply off</code>`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    if (sub === 'off') {
      setAutoReplyEnabled(false);
      await ctx.telegram.sendMessage(config.telegram.groupId, '🔴 Đã tắt auto-reply.', replyOpts);
      return;
    }

    if (sub === 'on') {
      const message = parts.join(' ').trim() || getAutoReplyState().message;
      if (!message) {
        await ctx.telegram.sendMessage(
          config.telegram.groupId,
          '⚠️ Ví dụ: <code>/autoreply on Tôi đang bận, sẽ trả lời sau nhé!</code>',
          { ...replyOpts, parse_mode: 'HTML' },
        );
        return;
      }
      setAutoReplyEnabled(true, message);
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `🟢 Đã bật auto-reply.\nNội dung: <i>${escapeHtml(message)}</i>\n\n`
          + `<i>Chỉ trả lời DM, mỗi người tối đa 1 lần/${AUTO_REPLY_COOLDOWN_MIN} phút `
          + `(toàn hệ thống tối đa ${AUTO_REPLY_MAX_PER_HOUR} tin/giờ).</i>`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      '❓ Dùng: <code>/autoreply on &lt;nội dung&gt;</code> | <code>/autoreply off</code> | <code>/autoreply status</code>',
      { ...replyOpts, parse_mode: 'HTML' },
    );
  });
}
