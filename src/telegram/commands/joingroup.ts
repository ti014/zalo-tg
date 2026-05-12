import type { TgHandlerContext } from '../types.js';
import { groupsCache } from '../../store/index.js';
import { config } from '../../config.js';
import { escapeHtml } from '../../utils/format.js';

export function registerJoingroupCommand({ bot, getApi }: TgHandlerContext): void {
  bot.command('joingroup', async (ctx) => {
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
    const link = text.split(/\s+/)[1]?.trim();
    if (!link) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '⚠️ Dùng: <code>/joingroup &lt;link nhóm Zalo&gt;</code>',
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    try {
      const linkInfo = await currentApi.getGroupLinkInfo(link) as {
        groupInfo?: { name?: string; totalMember?: number };
      } | undefined;

      const groupName = linkInfo?.groupInfo?.name;
      const totalMember = linkInfo?.groupInfo?.totalMember;

      await currentApi.joinGroupLink(link);

      const memberText = totalMember ? ` (${totalMember} TV)` : '';
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        groupName
          ? `✅ Đã tham gia nhóm <b>${escapeHtml(groupName)}</b>${memberText}!`
          : '✅ Đã gửi yêu cầu tham gia nhóm thành công!',
        { ...replyOpts, parse_mode: 'HTML' },
      );
      groupsCache.set([]);
    } catch (err) {
      console.error('[/joingroup]', err);
      await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Không thể tham gia nhóm. Link có thể đã hết hạn hoặc không hợp lệ.', replyOpts);
    }
  });
}
