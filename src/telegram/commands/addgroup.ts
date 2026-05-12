import type { TgHandlerContext } from '../types.js';
import { store, groupsCache } from '../../store/index.js';
import { config } from '../../config.js';

export function registerAddgroupCommand({ bot, getApi }: TgHandlerContext): void {
  bot.command('addgroup', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};

    const currentApi = getApi();
    if (!currentApi) { await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Zalo chưa kết nối', replyOpts); return; }

    if (!groupsCache.isFresh()) {
      await ctx.telegram.sendMessage(config.telegram.groupId, '⏳ Đang tải danh sách nhóm...', replyOpts);
      try {
        const rawGroups = await currentApi.getAllGroups() as { gridVerMap?: Record<string, string> } | undefined;
        const groupIds = Object.keys(rawGroups?.gridVerMap ?? {});
        const BATCH = 50;
        const allGroupInfo: Array<{ groupId: string; name: string; totalMember: number }> = [];
        for (let i = 0; i < groupIds.length; i += BATCH) {
          const batch = groupIds.slice(i, i + BATCH);
          try {
            const info = await currentApi.getGroupInfo(batch) as {
              gridInfoMap?: Record<string, { name: string; totalMember: number }>;
            } | undefined;
            for (const [gid, g] of Object.entries(info?.gridInfoMap ?? {})) {
              allGroupInfo.push({ groupId: gid, name: g.name, totalMember: g.totalMember });
            }
          } catch { /* skip */ }
        }
        groupsCache.set(allGroupInfo);
      } catch (err) {
        console.error('[/addgroup] failed:', err);
        await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Không lấy được danh sách nhóm.', replyOpts);
        return;
      }
    }

    const unmapped = groupsCache.search('', 50)
      .filter(g => store.getTopicByZalo(g.groupId, 1) === undefined)
      .sort((a, b) => a.name.localeCompare(b.name, 'vi'));

    if (unmapped.length === 0) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '✅ Tất cả nhóm Zalo đã có topic rồi!',
        replyOpts,
      );
      return;
    }

    const buttons = unmapped.slice(0, 30).map(g => ([{
      text: `👥 ${g.name} (${g.totalMember} TV)`,
      callback_data: `sg:${g.groupId}`,
    }]));

    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      `📋 <b>Nhóm chưa có topic</b> (${unmapped.length}):\nNhấn để tạo topic:`,
      { ...replyOpts, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } },
    );
  });
}
