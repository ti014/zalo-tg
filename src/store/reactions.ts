export interface ReactionSummaryEntry {
  summaryTgMsgId: number | null;
  lastSentText: string;
  reactions: Record<string, string[]>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

const _reactionSummaries = new Map<number, ReactionSummaryEntry>();

export const reactionSummaryStore = {
  upsert(tgMsgId: number, emoji: string, actorName: string): ReactionSummaryEntry {
    let entry = _reactionSummaries.get(tgMsgId);
    if (!entry) {
      entry = { summaryTgMsgId: null, lastSentText: '', reactions: {}, debounceTimer: null };
      _reactionSummaries.set(tgMsgId, entry);
    }
    if (!entry.reactions[emoji]) entry.reactions[emoji] = [];
    if (!entry.reactions[emoji]!.includes(actorName)) {
      entry.reactions[emoji]!.push(actorName);
    }
    return entry;
  },

  setSummaryMsgId(tgMsgId: number, summaryMsgId: number): void {
    const entry = _reactionSummaries.get(tgMsgId);
    if (entry) entry.summaryTgMsgId = summaryMsgId;
  },

  buildText(entry: ReactionSummaryEntry): string {
    return Object.entries(entry.reactions)
      .filter(([, names]) => names.length > 0)
      .map(([emoji, names]) => `${emoji} ${names.join(', ')}`)
      .join('  ');
  },

  stats(): { entries: number } {
    return { entries: _reactionSummaries.size };
  },
};

const REACTION_ECHO_TTL_MS = 8_000;
const _pendingReactionEchoes = new Map<string, { count: number; ts: number }>();

function reactionEchoKey(zaloId: string, targetMsgId: string, icon: string): string {
  return `${zaloId}::${targetMsgId}::${icon}`;
}

function prunePendingReactionEchoes(now = Date.now()): void {
  for (const [key, entry] of _pendingReactionEchoes.entries()) {
    if (now - entry.ts > REACTION_ECHO_TTL_MS) _pendingReactionEchoes.delete(key);
  }
}

function decrementPendingReactionEcho(key: string): void {
  const entry = _pendingReactionEchoes.get(key);
  if (!entry) return;
  if (entry.count <= 1) {
    _pendingReactionEchoes.delete(key);
    return;
  }
  _pendingReactionEchoes.set(key, { ...entry, count: entry.count - 1 });
}

export const reactionEchoStore = {
  mark(zaloId: string, targetMsgId: string, icon: string): void {
    const now = Date.now();
    prunePendingReactionEchoes(now);
    const key = reactionEchoKey(zaloId, targetMsgId, icon);
    const existing = _pendingReactionEchoes.get(key);
    _pendingReactionEchoes.set(key, { count: (existing?.count ?? 0) + 1, ts: now });
  },

  consume(zaloId: string, targetMsgId: string, icon: string): boolean {
    const now = Date.now();
    prunePendingReactionEchoes(now);
    const key = reactionEchoKey(zaloId, targetMsgId, icon);
    const entry = _pendingReactionEchoes.get(key);
    if (!entry) return false;
    decrementPendingReactionEcho(key);
    return true;
  },

  cancel(zaloId: string, targetMsgId: string, icon: string): void {
    prunePendingReactionEchoes();
    const key = reactionEchoKey(zaloId, targetMsgId, icon);
    decrementPendingReactionEcho(key);
  },
};

const REACTION_EVENT_DEDUPE_TTL_MS = 15_000;
const REACTION_EVENT_DEDUPE_MAX = 20_000;
const _recentReactionEvents = new Map<string, number>();

function pruneRecentReactionEvents(now = Date.now()): void {
  for (const [key, timestamp] of _recentReactionEvents) {
    if (now - timestamp > REACTION_EVENT_DEDUPE_TTL_MS) _recentReactionEvents.delete(key);
  }
  while (_recentReactionEvents.size > REACTION_EVENT_DEDUPE_MAX) {
    const oldest = _recentReactionEvents.keys().next().value as string | undefined;
    if (!oldest) break;
    _recentReactionEvents.delete(oldest);
  }
}

function markRecentReactionEvent(key: string): boolean {
  const now = Date.now();
  pruneRecentReactionEvents(now);
  const seenAt = _recentReactionEvents.get(key);
  if (seenAt !== undefined && now - seenAt <= REACTION_EVENT_DEDUPE_TTL_MS) return true;
  _recentReactionEvents.set(key, now);
  return false;
}

function normalizeReactionName(input: string): string {
  return input.trim().normalize('NFC').replace(/\s+/g, ' ').toLowerCase();
}

function normalizeReactionMsgIds(ids: string[]): string[] {
  return Array.from(new Set(ids.map(id => id.trim()).filter(Boolean))).sort();
}

export const reactionEventDedupeStore = {
  isDuplicateZaloInbound(input: {
    zaloId: string;
    targetMsgIds: string[];
    icon: string;
    actorUid?: string;
    actorName?: string;
  }): boolean {
    const targetKey = normalizeReactionMsgIds(input.targetMsgIds).join('|');
    if (!targetKey) return false;
    const actorKey = input.actorUid?.trim()
      || (input.actorName ? normalizeReactionName(input.actorName) : '')
      || 'unknown';
    return markRecentReactionEvent(
      `zalo-in::${input.zaloId.trim()}::${targetKey}::${input.icon.trim()}::${actorKey}`,
    );
  },

  isDuplicateTgOutbound(input: {
    chatId: number;
    messageId: number;
    actorId: string;
    emoji: string;
  }): boolean {
    return markRecentReactionEvent(
      `tg-out::${input.chatId}::${input.messageId}::${input.actorId.trim()}::${input.emoji.trim()}`,
    );
  },

  stats(): { entries: number } {
    pruneRecentReactionEvents();
    return { entries: _recentReactionEvents.size };
  },
};

const RECALLED_TTL_MS = 5_000;
const recentlyRecalledMsgIds = new Set<string>();

export function markRecentlyRecalled(...msgIds: Array<string | number | undefined>): void {
  for (const value of msgIds) {
    if (value === undefined) continue;
    const msgId = String(value).trim();
    if (!msgId || msgId === '0') continue;
    recentlyRecalledMsgIds.add(msgId);
    const timer = setTimeout(() => recentlyRecalledMsgIds.delete(msgId), RECALLED_TTL_MS);
    timer.unref?.();
  }
}

export function wasRecentlyRecalled(msgId: string): boolean {
  return recentlyRecalledMsgIds.has(msgId);
}
