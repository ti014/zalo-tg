import type { TgHandlerContext } from '../types.js';
import { config, isOwner } from '../../config.js';
import { store, userCache } from '../../store/index.js';
import { escapeHtml } from '../../utils/format.js';
import { populateGroupMemberCache } from '../../zalo/helpers.js';
import { runZaloRequest } from '../../zalo/rate-limit.js';

const MAX_RENDER_MEMBERS = 30;

interface MemberInfo {
  uid: string;
  name: string;
}

function uniqueByUid(profiles: MemberInfo[]): MemberInfo[] {
  const seen = new Set<string>();
  const result: MemberInfo[] = [];
  for (const profile of profiles) {
    if (!profile.uid || seen.has(profile.uid)) continue;
    seen.add(profile.uid);
    result.push(profile);
  }
  return result;
}

async function loadGroupMembers(
  api: ReturnType<TgHandlerContext['getApi']>,
  groupId: string,
): Promise<MemberInfo[]> {
  if (!api) return [];

  const info = await runZaloRequest(
    { label: `getGroupInfo(members:${groupId})`, priority: 'low', maxRetries: 0 },
    () => api.getGroupInfo(groupId),
  ) as {
    gridInfoMap?: Record<string, { memVerList?: string[] }>;
  };
  const memVerList = info?.gridInfoMap?.[groupId]?.memVerList ?? [];
  const uids = memVerList.map((entry: string) => entry.split('_')[0]).filter(Boolean);
  if (uids.length === 0) return [];

  await populateGroupMemberCache(api, groupId);

  return uniqueByUid(uids.map(uid => ({
    uid,
    name: userCache.getName(uid)?.trim() || uid,
  })));
}

function isGroupTopic(zaloEntry: ReturnType<typeof store.getEntryByTopic>): boolean {
  return zaloEntry?.type === 1;
}

export function registerMembersCommand({ bot, getApi }: TgHandlerContext): void {
  bot.command('members', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};

    if (!threadId) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        'Dùng lệnh này trong topic Zalo group cần xem.',
        replyOpts,
      );
      return;
    }

    const entry = store.getEntryByTopic(threadId);
    if (!entry || !isGroupTopic(entry)) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        'Topic này không phải nhóm Zalo nên không có danh sách thành viên.',
        replyOpts,
      );
      return;
    }

    const api = getApi();
    if (!api) {
      await ctx.telegram.sendMessage(config.telegram.groupId, 'Zalo chưa kết nối.', replyOpts);
      return;
    }

    try {
      const members = await loadGroupMembers(api, entry.zaloId);
      if (members.length === 0) {
        await ctx.telegram.sendMessage(config.telegram.groupId, 'Không lấy được thành viên nhóm Zalo này.', replyOpts);
        return;
      }

      const visible = members.slice(0, MAX_RENDER_MEMBERS);
      const lines = visible.map((m, idx) =>
        `${idx + 1}. <b>${escapeHtml(m.name)}</b> <code>${escapeHtml(m.uid)}</code>`,
      );
      const remaining = members.length - visible.length;
      const tail = remaining > 0 ? `\n\n…còn ${remaining} thành viên khác.` : '';

      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `<b>Thành viên nhóm Zalo</b> (${members.length})\n\n${lines.join('\n')}${tail}\n\nKick: <code>/kick &lt;uid&gt;</code>`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
    } catch (err) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `Lấy thành viên thất bại: ${err instanceof Error ? err.message : String(err)}`,
        replyOpts,
      );
    }
  });
}

export function registerKickCommand({ bot, getApi }: TgHandlerContext): void {
  bot.command('kick', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};

    if (!isOwner(ctx.from?.id)) {
      await ctx.telegram.sendMessage(config.telegram.groupId, 'Chỉ owner mới được kick.', replyOpts);
      return;
    }

    if (!threadId) {
      await ctx.telegram.sendMessage(config.telegram.groupId, 'Dùng /kick trong topic Zalo group.', replyOpts);
      return;
    }

    const entry = store.getEntryByTopic(threadId);
    if (!entry || !isGroupTopic(entry)) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        'Topic này không phải nhóm Zalo nên không thể kick.',
        replyOpts,
      );
      return;
    }

    const api = getApi();
    if (!api) {
      await ctx.telegram.sendMessage(config.telegram.groupId, 'Zalo chưa kết nối.', replyOpts);
      return;
    }

    const args = (ctx.message.text ?? '').trim().split(/\s+/).slice(1);
    if (args.length === 0) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        'Cách dùng: <code>/kick &lt;uid hoặc tên&gt; [uid2 ...]</code>\nDùng /members để xem uid.',
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    const resolveUid = (token: string): string | undefined => {
      if (/^\d{6,}$/.test(token)) return token;
      const byGroup = userCache.resolveByNameInGroup(token, entry.zaloId);
      if (byGroup) return byGroup;
      return userCache.resolveByName(token);
    };

    const memberIds: string[] = [];
    const unresolved: string[] = [];

    for (const token of args) {
      const uid = resolveUid(token);
      if (uid) memberIds.push(uid);
      else unresolved.push(token);
    }

    if (memberIds.length === 0) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `Không tìm thấy thành viên: ${unresolved.join(', ')}. Hãy dùng uid hiển thị trong /members.`,
        replyOpts,
      );
      return;
    }

    try {
      const response = await runZaloRequest(
        { label: `removeUserFromGroup(${entry.zaloId})`, priority: 'high' },
        () => api.removeUserFromGroup(memberIds, entry.zaloId),
      ) as {
        errorMembers?: string[];
      };
      const errorMembers = response?.errorMembers ?? [];
      const removed = memberIds.filter(uid => !errorMembers.includes(uid));

      const lines: string[] = [];
      if (removed.length > 0) {
        const labels = removed.map(uid => `<b>${escapeHtml(userCache.getName(uid)?.trim() || uid)}</b>`);
        lines.push(`Đã kick: ${labels.join(', ')}`);
      }
      if (errorMembers.length > 0) {
        lines.push(`Không kick được: ${errorMembers.map(uid => `<code>${escapeHtml(uid)}</code>`).join(', ')}`);
      }
      if (unresolved.length > 0) {
        lines.push(`Bỏ qua (không tìm thấy): ${unresolved.map(escapeHtml).join(', ')}`);
      }

      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        lines.join('\n') || 'Không có thay đổi.',
        { ...replyOpts, parse_mode: 'HTML' },
      );
    } catch (err) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `Kick thất bại: ${err instanceof Error ? err.message : String(err)}`,
        replyOpts,
      );
    }
  });
}
