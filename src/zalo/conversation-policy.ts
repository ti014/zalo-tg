import { config } from '../config.js';
import { friendsCache } from '../store/index.js';
import { runZaloRequest } from './rate-limit.js';
import type { ZaloAPI } from './types.js';

interface ZaloMuteEntry {
  id: string;
  duration: number;
  startTime: number;
  systemTime?: number;
  currentTime?: number;
}

export interface ZaloConversationPolicyInput {
  type: 0 | 1;
  muteState: boolean | undefined;
  strangerState: boolean | undefined;
  skipMutedGroups: boolean;
  skipStrangerMessages: boolean;
}

export interface ZaloConversationPolicyDecision {
  forward: boolean;
  silent: boolean;
  reason?: 'muted_group' | 'stranger_dm';
  strangerStateUnknown: boolean;
}

export function decideZaloConversationPolicy(
  input: ZaloConversationPolicyInput,
): ZaloConversationPolicyDecision {
  const silent = input.muteState === true;
  if (input.type === 1 && input.skipMutedGroups && silent) {
    return { forward: false, silent: true, reason: 'muted_group', strangerStateUnknown: false };
  }
  if (input.type === 0 && input.skipStrangerMessages && input.strangerState === true) {
    return { forward: false, silent, reason: 'stranger_dm', strangerStateUnknown: false };
  }
  return {
    forward: true,
    silent,
    strangerStateUnknown: input.type === 0
      && input.skipStrangerMessages
      && input.strangerState === undefined,
  };
}

const MUTE_STATE_TTL = 60 * 1_000;
let muteStateCache: {
  groupIds: Set<string>;
  userIds: Set<string>;
  ts: number;
} | null = null;

function isActiveMute(entry: ZaloMuteEntry): boolean {
  if (entry.duration === -1) return true;
  if (entry.duration <= 0) return false;
  const now = entry.currentTime ?? entry.systemTime ?? Math.floor(Date.now() / 1_000);
  return now < entry.startTime + entry.duration;
}

/**
 * Resolve both muted group and muted direct conversations.
 *
 * An API failure returns undefined so the caller can fail open and preserve
 * the message instead of treating an unknown policy state as muted.
 */
export async function isMutedZaloConversation(
  api: ZaloAPI,
  conversationId: string,
  type: 0 | 1,
): Promise<boolean | undefined> {
  const cached = muteStateCache;
  if (cached && Date.now() - cached.ts < MUTE_STATE_TTL) {
    return (type === 1 ? cached.groupIds : cached.userIds).has(conversationId);
  }

  try {
    const muteInfo = await runZaloRequest(
      { label: 'getMute()', priority: 'low', maxRetries: 0 },
      () => api.getMute(),
    ) as {
      groupChatEntries?: ZaloMuteEntry[];
      chatEntries?: ZaloMuteEntry[];
    };
    const groupIds = new Set(
      (muteInfo.groupChatEntries ?? []).filter(isActiveMute).map(entry => String(entry.id)),
    );
    const userIds = new Set(
      (muteInfo.chatEntries ?? []).filter(isActiveMute).map(entry => String(entry.id)),
    );
    muteStateCache = { groupIds, userIds, ts: Date.now() };
    return (type === 1 ? groupIds : userIds).has(conversationId);
  } catch (error) {
    console.warn(
      '[Zalo→TG] Failed to check Zalo mute state; forwarding with normal notification:',
      error,
    );
    return undefined;
  }
}

/**
 * Returns true only when the friend list was loaded successfully and the user
 * is absent. An API failure returns undefined so callers can fail open.
 */
export async function isStrangerZaloUser(
  api: ZaloAPI,
  userId: string,
): Promise<boolean | undefined> {
  if (!config.zalo.skipStrangerMessages) return false;
  if (!friendsCache.isFresh()) {
    try {
      const raw = await runZaloRequest(
        { label: 'getAllFriends(stranger-policy)', priority: 'low', maxRetries: 0 },
        () => api.getAllFriends(),
      ) as Array<{ userId: string; displayName: string }> | undefined;
      if (!raw) return undefined;
      friendsCache.set(raw.map(friend => ({
        userId: friend.userId,
        displayName: friend.displayName,
      })));
    } catch (error) {
      console.warn('[Zalo] Could not refresh friend list for stranger policy:', error);
      return undefined;
    }
  }
  return !friendsCache.has(userId);
}

export function clearZaloPolicyCaches(): void {
  muteStateCache = null;
  friendsCache.clear();
}
