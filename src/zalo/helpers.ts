import type { PollOptions } from 'zca-js';
import type { ZaloAPI, ZaloMediaContent, ZaloGroupInfoResponse } from './types.js';
import { isZaloRateLimitError, runZaloRequest } from './rate-limit.js';
import { aliasCache, friendsCache, userCache } from '../store/index.js';
import { tgBot } from '../telegram/bot.js';
import { escapeHtml } from '../utils/format.js';
import { tgQueue } from '../utils/tgQueue.js';
import { config } from '../config.js';
import { appGetGroupInfo, appGetGroupMembersInfo, type AppGroupData } from './app-api.js';

const TELEGRAM_UPLOAD_METHODS = new Set([
  'sendAnimation',
  'sendAudio',
  'sendDocument',
  'sendMediaGroup',
  'sendPhoto',
  'sendSticker',
  'sendVideo',
  'sendVoice',
]);

export const tg = new Proxy(tgBot.telegram, {
  get(target, prop: string) {
    const orig = (target as unknown as Record<string, unknown>)[prop];
    if (typeof orig !== 'function') return orig;
    return (...args: unknown[]) =>
      tgQueue(
        () => (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args),
        {
          ...(TELEGRAM_UPLOAD_METHODS.has(prop)
            ? { timeoutMs: config.telegram.uploadTimeoutMs }
            : {}),
        },
      );
  },
}) as typeof tgBot.telegram;

export interface BankCardInfo {
  bankName: string;
  accountNumber: string;
  holderName?: string;
  vietqr: string;
}

export function parseBankCardHtml(html: string): BankCardInfo | null {
  const ptags = [...html.matchAll(/<p[^>]*>([^<]+)<\/p>/g)]
    .map(m => m[1].trim()).filter(t => t.length > 0);

  const normalised = html.replace(/&amp;/g, '&');
  const contentMatch = normalised.match(/content=([^&"< ]+)/);
  if (!contentMatch) return null;
  const vietqr = decodeURIComponent(contentMatch[1]);

  const numericTags = ptags.filter(t => /^\d+$/.test(t));
  const textTags    = ptags.filter(t => !/^\d+$/.test(t));

  const accountNumber = numericTags.find(t => t.length !== 6) ?? numericTags[1] ?? numericTags[0] ?? '';
  const bankName      = textTags[0] ?? '';
  const holderName    = textTags[1]?.trim() || undefined;

  if (!vietqr) return null;
  return { bankName, accountNumber, holderName, vietqr };
}

export interface GroupMemberListSummary {
  memberIds: string[];
  totalMember: number;
  incomplete: boolean;
}

export function summarizeGroupMemberList(
  groupData: Pick<AppGroupData, 'memVerList' | 'currentMems' | 'totalMember' | 'hasMoreMember'>,
): GroupMemberListSummary {
  const memberIds = Array.from(new Set([
    ...(groupData.memVerList ?? []).map(value => String(value).split('_')[0]),
    ...(groupData.currentMems ?? []).map(member => String(member.id).split('_')[0]),
  ].filter((uid): uid is string => Boolean(uid))));
  const totalMember = Number(groupData.totalMember) || memberIds.length;
  return {
    memberIds,
    totalMember,
    incomplete: Number(groupData.hasMoreMember) > 0 || memberIds.length < totalMember,
  };
}

export async function populateGroupMemberCache(api: ZaloAPI, groupId: string): Promise<boolean> {
  try {
    let groupData = await appGetGroupInfo(groupId);
    let source: 'app' | 'web' = 'app';
    if (!groupData) {
      source = 'web';
      const info = await runZaloRequest(
        { label: 'getGroupInfo(' + groupId + ')', priority: 'low', maxRetries: 0 },
        () => api.getGroupInfo(groupId),
      ) as { gridInfoMap?: Record<string, AppGroupData> };
      groupData = info?.gridInfoMap?.[groupId] ?? null;
    }
    if (!groupData) {
      console.warn('[Zalo] getGroupInfo: no data for group ' + groupId);
      return false;
    }

    const summary = summarizeGroupMemberList(groupData);
    const knownNames = new Map<string, string>();
    for (const member of groupData.currentMems ?? []) {
      const uid = String(member.id).split('_')[0] ?? '';
      const name = member.dName?.trim() || member.zaloName?.trim();
      if (uid && name) knownNames.set(uid, name);
    }

    if (summary.memberIds.length === 0) {
      console.warn(
        '[Zalo] group ' + groupId + ': empty member list (totalMember='
        + summary.totalMember + ')',
      );
      if (summary.incomplete) {
        console.warn(
          '[Zalo] group ' + groupId + ': member list is hidden/incomplete; '
          + 'run /loginapp to refresh through PC App API.',
        );
      }
      return true;
    }

    if (source === 'app') {
      const appNames = await appGetGroupMembersInfo(summary.memberIds);
      for (const [uid, name] of appNames ?? []) knownNames.set(uid, name);
    }
    for (const [uid, name] of knownNames) userCache.saveForGroup(uid, name, groupId);

    const unresolved = summary.memberIds.filter(uid => !knownNames.has(uid));
    const batchSize = 20;
    let saved = knownNames.size;
    for (let i = 0; i < unresolved.length; i += batchSize) {
      const batch = unresolved.slice(i, i + batchSize);
      const resp = await runZaloRequest(
        {
          label: 'getUserInfo(' + groupId + ':' + i + '-' + (i + batch.length) + ')',
          priority: 'low',
          maxRetries: 0,
        },
        () => api.getUserInfo(batch),
      ) as {
        changed_profiles?: Record<string, { displayName?: string; zaloName?: string }>;
        unchanged_profiles?: Record<string, unknown>;
      };
      const profiles = resp?.changed_profiles ?? {};
      const unchanged = resp?.unchanged_profiles ?? {};
      for (const uid of batch) {
        const versionedUid = uid.includes('_') ? uid : uid + '_0';
        const p = (
          profiles[uid]
          ?? profiles[versionedUid]
          ?? unchanged[uid]
          ?? unchanged[versionedUid]
        ) as { displayName?: string; zaloName?: string } | undefined;
        const name = p?.displayName?.trim() || p?.zaloName?.trim();
        if (uid && name) { userCache.saveForGroup(uid, name, groupId); saved++; }
      }
    }
    if (summary.incomplete) {
      console.warn(
        '[Zalo] group ' + groupId + ': ' + source + ' API returned only '
        + summary.memberIds.length + '/' + summary.totalMember + ' member IDs.',
      );
    }
    console.log(
      '[Zalo] Cached ' + saved + '/' + summary.memberIds.length
      + ' visible members for group ' + groupId + ' via ' + source + ' API',
    );
    memberCacheLoaded.add(groupId);
    clearMemberCacheRetry(groupId);
    return true;
  } catch (err) {
    if (isZaloRateLimitError(err)) {
      console.warn(`[Zalo] Tạm dừng cache thành viên nhóm ${groupId} do quá giới hạn request.`);
    } else {
      console.warn(`[Zalo] populateGroupMemberCache failed for ${groupId}:`, err);
    }
    deferMemberCacheRetry(groupId);
    return false;
  }
}

interface GroupInfoEntry { name: string; avt?: string; ts: number }
const _groupInfoCache = new Map<string, GroupInfoEntry>();
const GROUP_INFO_TTL = 5 * 60 * 1000;

export function getCachedGroupInfo(zaloId: string): { name?: string; avt?: string } | undefined {
  const hit = _groupInfoCache.get(zaloId);
  if (!hit || Date.now() - hit.ts >= GROUP_INFO_TTL) return undefined;
  return hit;
}

export function invalidateCachedGroupInfo(zaloId: string): void {
  _groupInfoCache.delete(zaloId);
}

export async function refreshCachedGroupInfo(
  api: ZaloAPI,
  zaloId: string,
): Promise<{ name?: string; avt?: string }> {
  try {
    const info = await runZaloRequest(
      { label: `getCachedGroupInfo(${zaloId})`, priority: 'low', maxRetries: 0 },
      () => api.getGroupInfo(zaloId),
    ) as ZaloGroupInfoResponse;
    const entry: GroupInfoEntry = {
      name: info?.gridInfoMap?.[zaloId]?.name ?? '',
      avt:  info?.gridInfoMap?.[zaloId]?.avt,
      ts:   Date.now(),
    };
    _groupInfoCache.set(zaloId, entry);
    return entry;
  } catch { return {}; }
}

const USER_LOOKUP_RATE_LIMIT_COOLDOWN_MS = 60_000;
const userLookupBlockedUntil = new Map<string, number>();

export function getCachedUserDisplayName(uid: string | undefined, fallback = 'ai đó'): string {
  const cleanUid = uid?.trim();
  if (!cleanUid) return fallback;
  return userCache.getName(cleanUid)?.trim() || fallback.trim() || cleanUid;
}

export async function resolveUserDisplayName(
  api: ZaloAPI,
  uid: string | undefined,
  fallback = 'ai đó',
  groupId?: string,
): Promise<string> {
  const cleanUid = uid?.trim();
  if (!cleanUid) return fallback;

  const friend = friendsCache.get(cleanUid);
  const contactName = friend?.alias?.trim()
    || aliasCache.get(cleanUid)?.trim()
    || friend?.displayName?.trim();
  if (contactName) return contactName;

  if (groupId) {
    const groupName = userCache.getNameInGroup(cleanUid, groupId)?.trim();
    if (groupName) return groupName;
  }

  const cached = userCache.getName(cleanUid);
  if (cached?.trim()) return cached;

  const fallbackName = fallback.trim() || cleanUid;
  if (fallbackName !== cleanUid && fallbackName !== 'ai đó') userCache.save(cleanUid, fallbackName);

  const blockedUntil = userLookupBlockedUntil.get(cleanUid);
  if (blockedUntil !== undefined && Date.now() < blockedUntil) return fallbackName;

  try {
    const resp = await runZaloRequest(
      { label: `resolveUserDisplayName(${cleanUid})`, priority: 'low', maxRetries: 0 },
      () => api.getUserInfo(cleanUid),
    ) as {
      changed_profiles?: Record<string, { displayName?: string; zaloName?: string }>;
      unchanged_profiles?: Record<string, unknown>;
    };
    const versionedUid = cleanUid.includes('_') ? cleanUid : cleanUid + '_0';
    const profile = (
      resp?.changed_profiles?.[versionedUid]
      ?? resp?.changed_profiles?.[cleanUid]
      ?? resp?.unchanged_profiles?.[versionedUid]
      ?? resp?.unchanged_profiles?.[cleanUid]
    ) as
      | { displayName?: string; zaloName?: string }
      | undefined;
    const name = profile?.displayName?.trim() || profile?.zaloName?.trim();
    if (name) {
      userCache.save(cleanUid, name);
      userLookupBlockedUntil.delete(cleanUid);
      return name;
    }
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 221) {
      userLookupBlockedUntil.set(cleanUid, Date.now() + USER_LOOKUP_RATE_LIMIT_COOLDOWN_MS);
      console.warn(`[Zalo] Tạm ngưng tra tên ${cleanUid} trong 60s do quá giới hạn request.`);
    } else {
      console.warn(`[Zalo] resolveUserDisplayName failed for ${cleanUid}:`, err);
    }
  }

  return fallbackName;
}

export function parseContent(raw: string | ZaloMediaContent | Record<string, unknown>): {
  text: string | null;
  media: ZaloMediaContent;
} {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as ZaloMediaContent;
      return { text: null, media: parsed };
    } catch {
      return { text: raw, media: {} };
    }
  }
  return { text: null, media: raw as ZaloMediaContent };
}

export function buildScoreText(header: string, options: Pick<PollOptions, 'content' | 'votes'>[], closed: boolean): string {
  const total = options.reduce((s, o) => s + (o.votes ?? 0), 0);
  const lines = options.map(o => {
    const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    return `${escapeHtml(o.content)}\n  ${bar} ${o.votes} phiếu (${pct}%)`;
  });
  const status = closed ? ' <i>[Đã đóng]</i>' : '';
  return `📊 <b>${escapeHtml(header)}</b>${status}\n\nTổng: ${total} phiếu\n\n${lines.join('\n\n')}`;
}

export const memberCacheLoaded = new Set<string>();

export function resetMemberCacheLoaded(): void {
  memberCacheLoaded.clear();
}

export async function ensureGroupMemberCache(api: ZaloAPI, groupId: string): Promise<boolean> {
  if (memberCacheLoaded.has(groupId)) return true;
  memberCacheLoaded.add(groupId);
  const loaded = await populateGroupMemberCache(api, groupId);
  if (!loaded) memberCacheLoaded.delete(groupId);
  return loaded;
}

export async function refreshGroupMemberCache(api: ZaloAPI, groupId: string): Promise<boolean> {
  memberCacheLoaded.delete(groupId);
  return ensureGroupMemberCache(api, groupId);
}

const MEMBER_CACHE_RETRY_COOLDOWN_MS = 10 * 60 * 1000;
const memberCacheRetryAfter = new Map<string, number>();

export function canRetryMemberCache(groupId: string, now = Date.now()): boolean {
  const retryAt = memberCacheRetryAfter.get(groupId);
  return retryAt === undefined || now >= retryAt;
}

export function deferMemberCacheRetry(groupId: string, now = Date.now()): void {
  memberCacheRetryAfter.set(groupId, now + MEMBER_CACHE_RETRY_COOLDOWN_MS);
}

export function clearMemberCacheRetry(groupId: string): void {
  memberCacheRetryAfter.delete(groupId);
}
