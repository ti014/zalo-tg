import type { TgHandlerContext } from '../types.js';
import { config } from '../../config.js';
import { escapeHtml } from '../../utils/format.js';

export function registerFriendrequestsCommand({ bot, getApi }: TgHandlerContext): void {
  bot.command('friendrequests', async (ctx) => {
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

    try {
      const [sentReqs, groupInvites] = await Promise.all([
        currentApi.getSentFriendRequest() as Promise<Record<string, {
          zaloName: string; displayName: string; fReqInfo: { message: string; time: number };
        }>>,
        currentApi.getGroupInviteBoxList({ invPerPage: 20 }) as Promise<{
          invitations: Array<{
            groupInfo: { groupId: string; name: string; totalMember: number };
            inviterInfo: { dName: string };
            expiredTs: string;
          }>;
          total: number;
        }>,
      ]);

      const parts: string[] = [];

      const sentList = Object.values(sentReqs ?? {});
      if (sentList.length > 0) {
        parts.push(`📤 <b>Lời mời kết bạn đã gửi (${sentList.length})</b>`);
        for (const u of sentList.slice(0, 15)) {
          const name = u.displayName || u.zaloName;
          const msg  = u.fReqInfo?.message ? ` — "${escapeHtml(u.fReqInfo.message)}"` : '';
          parts.push(`• ${escapeHtml(name)}${msg}`);
        }
      }

      const invites = groupInvites?.invitations ?? [];
      if (invites.length > 0) {
        parts.push(`\n📬 <b>Lời mời tham gia nhóm (${invites.length})</b>`);
        const groupButtons: Array<[{ text: string; callback_data: string }]> = [];
        for (const inv of invites.slice(0, 15)) {
          const g   = inv.groupInfo;
          const exp = new Date(Number(inv.expiredTs) * 1000).toLocaleDateString('vi-VN');
          parts.push(`• 👥 <b>${escapeHtml(g.name)}</b> (${g.totalMember} TV)\n  Mời bởi: ${escapeHtml(inv.inviterInfo.dName)} · HH: ${exp}`);
          groupButtons.push([{
            text: `✅ Tham gia ${g.name}`,
            callback_data: `jgi:${g.groupId}`,
          }]);
        }

        if (parts.length === 0) parts.push('✅ Không có lời mời nào đang chờ.');

        await ctx.telegram.sendMessage(
          config.telegram.groupId,
          parts.join('\n'),
          { ...replyOpts, parse_mode: 'HTML', reply_markup: { inline_keyboard: groupButtons } },
        );
        return;
      }

      if (parts.length === 0) parts.push('✅ Không có lời mời nào đang chờ.');
      await ctx.telegram.sendMessage(config.telegram.groupId, parts.join('\n'), { ...replyOpts, parse_mode: 'HTML' });
    } catch (err) {
      console.error('[/friendrequests]', err);
      await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Lỗi lấy danh sách lời mời.', replyOpts);
    }
  });
}
