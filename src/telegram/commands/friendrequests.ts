import type { TgHandlerContext } from '../types.js';
import type { ZaloAPI } from '../../zalo/types.js';
import { config } from '../../config.js';
import { escapeHtml } from '../../utils/format.js';
import {
  appGetReceivedFriendRequests,
  appGetSentFriendRequests,
} from '../../zalo/app-api.js';
import { runZaloRequest } from '../../zalo/rate-limit.js';

const FRIEND_REQUEST_PAGE_SIZE = 10;

interface ReceivedRequestData {
  userId?: string;
  displayName?: string;
  zaloName?: string;
  recommType?: number;
  recommInfo?: { message?: string };
}

interface ReceivedRequestEnvelope extends ReceivedRequestData {
  dataInfo?: ReceivedRequestData;
}

interface SentRequestData {
  userId?: string;
  displayName?: string;
  zaloName?: string;
  fReqInfo?: { message?: string };
}

interface GroupInviteData {
  groupInfo?: { groupId?: string; name?: string; totalMember?: number };
  inviterInfo?: { dName?: string };
  expiredTs?: string | number;
}

export type FriendRequestItem =
  | { kind: 'received'; userId: string; name: string; message?: string }
  | { kind: 'sent'; userId: string; name: string; message?: string }
  | {
    kind: 'group';
    groupId: string;
    name: string;
    totalMember: number;
    inviterName: string;
    expiredTs?: string | number;
  };

export interface FriendRequestPage {
  text: string;
  page: number;
  totalPages: number;
  replyMarkup?: {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function callbackLabel(prefix: string, name: string): string {
  const maxNameLength = Math.max(1, 60 - prefix.length);
  const compactName = name.length > maxNameLength
    ? `${name.slice(0, Math.max(1, maxNameLength - 1))}…`
    : name;
  return `${prefix}${compactName}`;
}

/** Normalize PC-App and Web API payload variants into one stable UI model. */
export function normalizeFriendRequestItems(
  sentRequests: Record<string, SentRequestData> | null | undefined,
  receivedRecommendations: ReceivedRequestEnvelope[] | null | undefined,
  groupInvites: GroupInviteData[] | null | undefined,
): FriendRequestItem[] {
  const received: FriendRequestItem[] = [];
  for (const envelope of receivedRecommendations ?? []) {
    const data = envelope.dataInfo ?? envelope;
    if ((data.recommType ?? envelope.recommType) !== 2) continue;
    const userId = cleanText(data.userId);
    if (!userId) continue;
    received.push({
      kind: 'received',
      userId,
      name: cleanText(data.displayName) || cleanText(data.zaloName) || userId,
      ...(cleanText(data.recommInfo?.message)
        ? { message: cleanText(data.recommInfo?.message) }
        : {}),
    });
  }

  const sent: FriendRequestItem[] = [];
  for (const [key, data] of Object.entries(sentRequests ?? {})) {
    const userId = cleanText(data.userId) || cleanText(key);
    if (!userId) continue;
    sent.push({
      kind: 'sent',
      userId,
      name: cleanText(data.displayName) || cleanText(data.zaloName) || userId,
      ...(cleanText(data.fReqInfo?.message)
        ? { message: cleanText(data.fReqInfo?.message) }
        : {}),
    });
  }

  const groups: FriendRequestItem[] = [];
  for (const invite of groupInvites ?? []) {
    const groupId = cleanText(invite.groupInfo?.groupId);
    if (!groupId) continue;
    groups.push({
      kind: 'group',
      groupId,
      name: cleanText(invite.groupInfo?.name) || `Nhóm ${groupId}`,
      totalMember: Number(invite.groupInfo?.totalMember) || 0,
      inviterName: cleanText(invite.inviterInfo?.dName) || 'Không rõ',
      ...(invite.expiredTs === undefined ? {} : { expiredTs: invite.expiredTs }),
    });
  }

  return [...received, ...sent, ...groups];
}

/** Render one Telegram-safe page with accept, revoke, join and navigation actions. */
export function renderFriendRequestPage(
  items: readonly FriendRequestItem[],
  requestedPage: number,
  pageSize = FRIEND_REQUEST_PAGE_SIZE,
): FriendRequestPage {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error('pageSize must be a positive safe integer.');
  }
  if (items.length === 0) {
    return { text: 'Không có lời mời nào đang chờ.', page: 0, totalPages: 0 };
  }

  const totalPages = Math.ceil(items.length / pageSize);
  const page = Math.max(0, Math.min(
    Number.isSafeInteger(requestedPage) ? requestedPage : 0,
    totalPages - 1,
  ));
  const pageItems = items.slice(page * pageSize, (page + 1) * pageSize);
  const lines = [`<b>Danh sách lời mời</b> — trang ${page + 1}/${totalPages}`];
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];

  for (const item of pageItems) {
    if (item.kind === 'received') {
      lines.push(
        `\n<b>Nhận được</b>: ${escapeHtml(item.name)}`
        + (item.message ? ` — <i>${escapeHtml(item.message)}</i>` : ''),
      );
      keyboard.push([{
        text: callbackLabel('Chấp nhận ', item.name),
        callback_data: `afr:${item.userId}`,
      }]);
      continue;
    }
    if (item.kind === 'sent') {
      lines.push(
        `\n<b>Đã gửi</b>: ${escapeHtml(item.name)}`
        + (item.message ? ` — <i>${escapeHtml(item.message)}</i>` : ''),
      );
      keyboard.push([{
        text: callbackLabel('Thu hồi ', item.name),
        callback_data: `ufr:${item.userId}`,
      }]);
      continue;
    }

    const expiry = item.expiredTs === undefined
      ? ''
      : ` · hết hạn ${new Date(Number(item.expiredTs) * 1_000).toLocaleDateString('vi-VN')}`;
    lines.push(
      `\n<b>Nhóm</b>: ${escapeHtml(item.name)} (${item.totalMember} thành viên)`
      + `\nMời bởi: ${escapeHtml(item.inviterName)}${expiry}`,
    );
    keyboard.push([{
      text: callbackLabel('Tham gia ', item.name),
      callback_data: `jgi:${item.groupId}`,
    }]);
  }

  const navigation: Array<{ text: string; callback_data: string }> = [];
  if (page > 0) navigation.push({ text: 'Trang trước', callback_data: `frq_pg:${page - 1}` });
  if (page < totalPages - 1) navigation.push({ text: 'Trang sau', callback_data: `frq_pg:${page + 1}` });
  if (navigation.length > 0) keyboard.push(navigation);

  return {
    text: lines.join('\n'),
    page,
    totalPages,
    replyMarkup: { inline_keyboard: keyboard },
  };
}

export async function getFriendRequestPage(api: ZaloAPI, page: number): Promise<FriendRequestPage> {
  let [sentRequests, receivedRecommendations, groupInviteBox] = await Promise.all([
    appGetSentFriendRequests(500),
    appGetReceivedFriendRequests(500),
    runZaloRequest(
      { label: 'getGroupInviteBoxList(friendrequests)', priority: 'low', maxRetries: 0 },
      () => api.getGroupInviteBoxList({ invPerPage: 100 }),
    ) as Promise<{ invitations?: GroupInviteData[] }>,
  ]);

  if (Object.keys(sentRequests ?? {}).length === 0) {
    sentRequests = await runZaloRequest(
      { label: 'getSentFriendRequest()', priority: 'low', maxRetries: 0 },
      () => api.getSentFriendRequest(),
    ) as Record<string, SentRequestData>;
  }
  if ((receivedRecommendations ?? []).length === 0) {
    const webRecommendations = await runZaloRequest(
      { label: 'getFriendRecommendations()', priority: 'low', maxRetries: 0 },
      () => api.getFriendRecommendations(),
    ) as { recommItems?: ReceivedRequestEnvelope[] } | undefined;
    receivedRecommendations = webRecommendations?.recommItems ?? [];
  }

  return renderFriendRequestPage(normalizeFriendRequestItems(
    sentRequests,
    receivedRecommendations,
    groupInviteBox?.invitations,
  ), page);
}

export function registerFriendrequestsCommand({ bot, getApi }: TgHandlerContext): void {
  bot.command('friendrequests', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};
    const api = getApi();
    if (!api) {
      await ctx.telegram.sendMessage(config.telegram.groupId, 'Zalo chưa kết nối.', replyOpts);
      return;
    }

    try {
      const page = await getFriendRequestPage(api, 0);
      await ctx.telegram.sendMessage(config.telegram.groupId, page.text, {
        ...replyOpts,
        parse_mode: 'HTML',
        ...(page.replyMarkup ? { reply_markup: page.replyMarkup } : {}),
      });
    } catch (error) {
      console.error('[/friendrequests]', error);
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        'Không lấy được danh sách lời mời.',
        replyOpts,
      );
    }
  });
}
