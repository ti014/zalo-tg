import type { TgHandlerContext } from '../types.js';
import { store, friendsCache, groupsCache, aliasCache } from '../../store/index.js';
import { config } from '../../config.js';
import { escapeHtml } from '../../utils/format.js';
import { normalizePhoneSearchQuery } from '../helpers.js';

export function registerSearchCommand({ bot, getApi }: TgHandlerContext): void {
  bot.command('search', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};

    const query = (ctx.message.text ?? '').replace(/^\/search(?:@[A-Za-z0-9_]+)?\s*/i, '').trim();
    if (!query) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '🔍 Cú pháp: <code>/search Tên hoặc số điện thoại</code>\nHỗ trợ cả <code>/search ...</code> lẫn <code>/search@zalo_tele_bridge_bot ...</code>.\nVí dụ số: <code>094.495.3545</code> hoặc <code>094 593 5345</code>.',
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    const currentApi = getApi();
    if (!currentApi) { await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Zalo chưa kết nối', replyOpts); return; }

    const phoneQuery = normalizePhoneSearchQuery(query);
    if (phoneQuery) {
      try {
        const user = await currentApi.findUser(phoneQuery) as {
          uid?: string;
          display_name?: string;
          zalo_name?: string;
        } | undefined;

        if (!user?.uid) {
          await ctx.telegram.sendMessage(
            config.telegram.groupId,
            `🔍 Không tìm thấy tài khoản Zalo cho số <b>${escapeHtml(phoneQuery)}</b>.`,
            { ...replyOpts, parse_mode: 'HTML' },
          );
          return;
        }

        const displayName = user.display_name || user.zalo_name || `Zalo ${user.uid}`;
        const existingTopicId = store.getTopicByZalo(user.uid, 0);
        const button: { text: string; callback_data: string } = existingTopicId !== undefined
          ? { text: `👤 ${displayName} ✅`, callback_data: `sc:${user.uid}` }
          : { text: `👤 ${displayName}`, callback_data: `sc:${user.uid}` };

        await ctx.telegram.sendMessage(
          config.telegram.groupId,
          `📱 Tìm thấy theo số <b>${escapeHtml(phoneQuery)}</b>:

✅ = đã có topic • Nhấn để mở nếu đã map, hoặc tạo nếu chưa có`,
          {
            ...replyOpts,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[button]],
            },
          },
        );
        return;
      } catch (err) {
        console.error('[/search] findUser failed:', err);
        await ctx.telegram.sendMessage(
          config.telegram.groupId,
          `❌ Lỗi tìm số điện thoại <b>${escapeHtml(phoneQuery)}</b>: ${escapeHtml(err instanceof Error ? err.message : String(err))}`,
          { ...replyOpts, parse_mode: 'HTML' },
        );
        return;
      }
    }

    if (!friendsCache.isFresh()) {
      try {
        const raw = await currentApi.getAllFriends() as Array<{ userId: string; displayName: string }> | undefined;
        if (raw) {
          friendsCache.set(raw.map(f => ({
            userId:      f.userId,
            displayName: f.displayName,
            alias:       aliasCache.get(f.userId),
          })));
        }
      } catch (err) { console.error('[/search] getAllFriends failed:', err); }
    }

    if (!groupsCache.isFresh()) {
      try {
        const rawGroups = await currentApi.getAllGroups() as { gridVerMap?: Record<string, string> } | undefined;
        const groupIds = Object.keys(rawGroups?.gridVerMap ?? {});
        if (groupIds.length > 0) {
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
            } catch { /* skip batch on error */ }
          }
          groupsCache.set(allGroupInfo);
        }
      } catch (err) { console.error('[/search] getAllGroups failed:', err); }
    }

    const friendResults = friendsCache.search(query, 8);
    const groupResults  = groupsCache.search(query, 8);

    if (friendResults.length === 0 && groupResults.length === 0) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `🔍 Không tìm thấy bạn bè hay nhóm nào có tên chứa "<b>${escapeHtml(query)}</b>".`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    const buttons: Array<Array<{ text: string; callback_data: string } | { text: string; url: string }>> = [];
    for (const f of friendResults) {
      const existingTopicId = store.getTopicByZalo(f.userId, 0);
      const label = aliasCache.label(f.userId, f.displayName);
      buttons.push([existingTopicId !== undefined
        ? { text: `👤 ${label} ✅`, callback_data: `sc:${f.userId}` }
        : { text: `👤 ${label}`, callback_data: `sc:${f.userId}` }]);
    }
    for (const g of groupResults) {
      const existingTopicId = store.getTopicByZalo(g.groupId, 1);
      buttons.push([existingTopicId !== undefined
        ? { text: `👥 ${g.name} (${g.totalMember} TV) ✅`, callback_data: `sg:${g.groupId}` }
        : { text: `👥 ${g.name} (${g.totalMember} TV)`, callback_data: `sg:${g.groupId}` }]);
    }

    const parts: string[] = [`🔍 Kết quả "<b>${query}</b>":`, ''];
    if (friendResults.length > 0) parts.push(`👤 <b>Bạn bè</b> (${friendResults.length}):`);
    if (groupResults.length > 0)  parts.push(`👥 <b>Nhóm</b> (${groupResults.length}):`);
    parts.push('', '✅ = đã có topic • Nhấn để mở nếu đã map, hoặc tạo nếu chưa có');

    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      parts.join('\n'),
      { ...replyOpts, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } },
    );
  });
}
