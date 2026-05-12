import type { PollOptions } from 'zca-js';
import type { ZaloAPI, ZaloMediaContent, ZaloGroupInfoResponse } from './types.js';
import { isZaloRateLimitError, runZaloRequest } from './rate-limit.js';
import { userCache } from '../store/index.js';
import { tgBot } from '../telegram/bot.js';
import { config } from '../config.js';
import { escapeHtml } from '../utils/format.js';
import { tgQueue } from '../utils/tgQueue.js';

export const tg = new Proxy(tgBot.telegram, {
  get(target, prop: string) {
    const orig = (target as unknown as Record<string, unknown>)[prop];
    if (typeof orig !== 'function') return orig;
    return (...args: unknown[]) =>
      tgQueue(() => (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args));
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

export async function populateGroupMemberCache(api: ZaloAPI, groupId: string): Promise<boolean> {
  try {
    const info = await runZaloRequest(
      { label: `getGroupInfo(${groupId})`, priority: 'low', maxRetries: 0 },
      () => api.getGroupInfo(groupId),
    ) as {
      gridInfoMap?: Record<string, {
        memVerList?: string[];
        totalMember?: number;
      }>;
    };
    const groupData = info?.gridInfoMap?.[groupId];
    if (!groupData) {
      console.warn(`[Zalo] getGroupInfo: no data for group ${groupId}`);
      return false;
    }

    const uids = (groupData.memVerList ?? [])
      .map(s => s.split('_')[0])
      .filter(Boolean);
    if (uids.length === 0) {
      console.warn(`[Zalo] group ${groupId}: empty memVerList (totalMember=${groupData.totalMember})`);
      return true;
    }

    const batchSize = 20;
    let saved = 0;
    for (let i = 0; i < uids.length; i += batchSize) {
      const batch = uids.slice(i, i + batchSize);
      const resp = await runZaloRequest(
        { label: `getUserInfo(${groupId}:${i}-${i + batch.length})`, priority: 'low', maxRetries: 0 },
        () => api.getUserInfo(batch),
      ) as {
        changed_profiles?: Record<string, { displayName?: string; zaloName?: string }>;
        unchanged_profiles?: Record<string, unknown>;
      };
      const profiles = resp?.changed_profiles ?? {};
      const unchanged = resp?.unchanged_profiles ?? {};
      for (const uid of batch) {
        const p = (profiles[uid] ?? unchanged[uid]) as { displayName?: string; zaloName?: string } | undefined;
        const name = p?.displayName?.trim() || p?.zaloName?.trim();
        if (uid && name) { userCache.saveForGroup(uid, name, groupId); saved++; }
      }
    }
    console.log(`[Zalo] Cached ${saved}/${uids.length} members for group ${groupId}`);
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

export async function getCachedGroupInfo(
  api: ZaloAPI,
  zaloId: string,
): Promise<{ name?: string; avt?: string }> {
  const hit = _groupInfoCache.get(zaloId);
  if (hit && Date.now() - hit.ts < GROUP_INFO_TTL) return hit;
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

interface ZaloMuteEntry {
  id: string;
  duration: number;
  startTime: number;
  systemTime?: number;
  currentTime?: number;
}

const MUTED_GROUPS_TTL = 60 * 1000;
let _mutedGroupsCache: { ids: Set<string>; ts: number } | null = null;

function isActiveMute(entry: ZaloMuteEntry): boolean {
  if (entry.duration === -1) return true;
  if (entry.duration <= 0) return false;

  const now = entry.currentTime ?? entry.systemTime ?? Math.floor(Date.now() / 1000);
  const expiresAt = entry.startTime + entry.duration;
  return now < expiresAt;
}

export async function isMutedZaloGroup(api: ZaloAPI, groupId: string): Promise<boolean> {
  if (!config.zalo.skipMutedGroups) return false;

  const cached = _mutedGroupsCache;
  if (cached && Date.now() - cached.ts < MUTED_GROUPS_TTL) {
    return cached.ids.has(groupId);
  }

  try {
    const muteInfo = await runZaloRequest(
      { label: 'getMute()', priority: 'low', maxRetries: 0 },
      () => api.getMute(),
    ) as { groupChatEntries?: ZaloMuteEntry[] };
    const mutedIds = new Set(
      (muteInfo.groupChatEntries ?? [])
        .filter(isActiveMute)
        .map(entry => String(entry.id)),
    );
    _mutedGroupsCache = { ids: mutedIds, ts: Date.now() };
    return mutedIds.has(groupId);
  } catch (err) {
    console.warn('[Zalo→TG] Failed to check muted Zalo groups; forwarding message:', err);
    return false;
  }
}

const USER_LOOKUP_RATE_LIMIT_COOLDOWN_MS = 60_000;
const userLookupBlockedUntil = new Map<string, number>();

export async function resolveUserDisplayName(api: ZaloAPI, uid: string | undefined, fallback = 'ai đó'): Promise<string> {
  const cleanUid = uid?.trim();
  if (!cleanUid) return fallback;

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
    const profile = (resp?.changed_profiles?.[cleanUid] ?? resp?.unchanged_profiles?.[cleanUid]) as
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
