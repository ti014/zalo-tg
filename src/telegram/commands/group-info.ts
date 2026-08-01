import type { TgHandlerContext } from '../types.js';
import { config } from '../../config.js';
import { store, userCache } from '../../store/index.js';
import { escapeHtml, truncate } from '../../utils/format.js';
import { populateGroupMemberCache } from '../../zalo/helpers.js';
import { appGetGroupInfo, appGetGroupMembersInfo } from '../../zalo/app-api.js';
import { runZaloRequest } from '../../zalo/rate-limit.js';

interface GroupSnapshot {
  groupId: string;
  name: string;
  totalMember: number;
  memberIds: string[];
  names: Map<string, string>;
  appAvailable: boolean;
}

async function loadGroupSnapshot(api: ReturnType<TgHandlerContext['getApi']>, groupId: string): Promise<GroupSnapshot> {
  if (!api) throw new Error('Zalo chưa kết nối.');

  const appInfo = await appGetGroupInfo(groupId);
  let webInfo: { gridInfoMap?: Record<string, {
    name?: string;
    totalMember?: number;
    memVerList?: string[];
  }> } | undefined;
  if (!appInfo) {
    webInfo = await runZaloRequest(
      { label: `getGroupInfo(${groupId})`, priority: 'low', maxRetries: 0 },
      () => api.getGroupInfo(groupId),
    ) as typeof webInfo;
  }

  const webGroup = webInfo?.gridInfoMap?.[groupId];
  const memberIds = Array.from(new Set(
    (appInfo?.currentMems?.map(member => member.id) ?? appInfo?.memVerList ?? webGroup?.memVerList ?? [])
      .map(value => String(value).split('_')[0])
      .filter(Boolean),
  ));
  const names = new Map<string, string>();
  for (const member of appInfo?.currentMems ?? []) {
    const name = member.dName?.trim() || member.zaloName?.trim();
    if (name) names.set(member.id.split('_')[0]!, name);
  }
  const appNames = await appGetGroupMembersInfo(memberIds);
  for (const [uid, name] of appNames ?? []) names.set(uid, name);

  if (names.size < memberIds.length) {
    await populateGroupMemberCache(api, groupId);
    for (const uid of memberIds) {
      const name = userCache.getName(uid);
      if (name) names.set(uid, name);
    }
  }

  return {
    groupId,
    name: appInfo?.name?.trim() || webGroup?.name?.trim() || `Nhóm ${groupId}`,
    totalMember: appInfo?.totalMember ?? webGroup?.totalMember ?? memberIds.length,
    memberIds,
    names,
    appAvailable: appInfo !== null,
  };
}

export function renderGroupInfo(snapshot: GroupSnapshot, showMembers: boolean): string {
  const lines = [
    `👥 <b>${escapeHtml(snapshot.name)}</b>`,
    `Mã nhóm: <code>${escapeHtml(snapshot.groupId)}</code>`,
    `Số thành viên: <b>${snapshot.totalMember}</b>`,
  ];
  if (showMembers) {
    const visible = snapshot.memberIds.slice(0, 100).map((uid, index) => (
      `${index + 1}. <b>${escapeHtml(snapshot.names.get(uid) ?? uid)}</b> <code>${escapeHtml(uid)}</code>`
    ));
    if (visible.length > 0) lines.push('', '<b>Danh sách thành viên</b>', ...visible);
    const missing = snapshot.totalMember - snapshot.memberIds.length;
    if (missing > 0) {
      lines.push('', `⚠️ API chỉ trả ${snapshot.memberIds.length}/${snapshot.totalMember} thành viên.`);
      lines.push('Dùng <code>/loginapp</code> để lấy danh sách đầy đủ nếu nhóm ẩn member list.');
    }
  }
  if (!snapshot.appAvailable && snapshot.totalMember > snapshot.memberIds.length) {
    lines.push('', 'ℹ️ PC App API chưa khả dụng; kết quả web có thể không đầy đủ.');
  }
  return truncate(lines.join('\n'), 4096);
}

export function registerGroupInfoCommands({ bot, getApi }: TgHandlerContext): void {
  const register = (command: 'group_info' | 'group_infoall', showMembers: boolean) => {
    bot.command(command, async (ctx) => {
      if (ctx.chat.id !== config.telegram.groupId) return;
      const topicId = 'message_thread_id' in ctx.message
        ? (ctx.message.message_thread_id as number | undefined)
        : undefined;
      const replyOpts = topicId ? { message_thread_id: topicId } : {};
      if (!topicId) {
        await ctx.telegram.sendMessage(config.telegram.groupId, 'Hãy dùng lệnh này trong topic của nhóm Zalo.', replyOpts);
        return;
      }
      const entry = store.getEntryByTopic(topicId);
      if (!entry || entry.type !== 1) {
        await ctx.telegram.sendMessage(config.telegram.groupId, 'Topic hiện tại không phải nhóm Zalo.', replyOpts);
        return;
      }
      try {
        const snapshot = await loadGroupSnapshot(getApi(), entry.zaloId);
        await ctx.telegram.sendMessage(
          config.telegram.groupId,
          renderGroupInfo(snapshot, showMembers),
          { ...replyOpts, parse_mode: 'HTML' },
        );
      } catch (error) {
        await ctx.telegram.sendMessage(
          config.telegram.groupId,
          `Không lấy được thông tin nhóm: ${escapeHtml(error instanceof Error ? error.message : String(error))}`,
          { ...replyOpts, parse_mode: 'HTML' },
        );
      }
    });
  };
  register('group_info', false);
  register('group_infoall', true);
}
