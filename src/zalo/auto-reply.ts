import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ThreadType } from 'zca-js';
import { config } from '../config.js';
import { sentMsgStore } from '../store/index.js';
import { writeJsonAtomicSync } from '../infrastructure/files/atomic-file.js';
import type { ZaloAPI } from './types.js';

export interface AutoReplyState {
  enabled: boolean;
  message: string;
}

const STATE_FILE = path.join(config.dataDir, 'autoreply.json');
const PEER_COOLDOWN_MS = 30 * 60 * 1_000;
const GLOBAL_WINDOW_MS = 60 * 60 * 1_000;
const MIN_DELAY_MS = 3_000;
const MAX_DELAY_MS = 8_000;

export const AUTO_REPLY_COOLDOWN_MIN = PEER_COOLDOWN_MS / 60_000;
export const AUTO_REPLY_MAX_PER_HOUR = 12;

const lastRepliedAt = new Map<string, number>();
let recentReplies: Array<{ id: number; timestamp: number }> = [];
let reservationSequence = 0;

let state: AutoReplyState = { enabled: false, message: '' };

interface PersistedAutoReplyState extends Partial<AutoReplyState> {
  lastRepliedAt?: Record<string, number>;
  recentReplyTimestamps?: number[];
}

function loadState(): void {
  if (!existsSync(STATE_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as PersistedAutoReplyState;
    state = { enabled: Boolean(raw.enabled), message: String(raw.message ?? '') };
    const now = Date.now();
    lastRepliedAt.clear();
    for (const [threadId, timestamp] of Object.entries(raw.lastRepliedAt ?? {})) {
      if (
        threadId.trim()
        && Number.isSafeInteger(timestamp)
        && timestamp <= now + 60_000
        && now - timestamp < PEER_COOLDOWN_MS
      ) {
        lastRepliedAt.set(threadId, timestamp);
      }
    }
    recentReplies = (raw.recentReplyTimestamps ?? [])
      .filter(timestamp => (
        Number.isSafeInteger(timestamp)
        && timestamp <= now + 60_000
        && now - timestamp < GLOBAL_WINDOW_MS
      ))
      .map(timestamp => ({ id: ++reservationSequence, timestamp }));
  } catch (error) {
    console.warn('[AutoReply] Failed to load state:', error);
  }
}

function saveState(): boolean {
  try {
    writeJsonAtomicSync(STATE_FILE, {
      ...state,
      lastRepliedAt: Object.fromEntries(lastRepliedAt),
      recentReplyTimestamps: recentReplies.map(entry => entry.timestamp),
    } satisfies PersistedAutoReplyState, 2);
    return true;
  } catch (error) {
    console.warn('[AutoReply] Failed to save state:', error);
    return false;
  }
}

loadState();

export function getAutoReplyState(): AutoReplyState {
  return { ...state };
}

export function setAutoReplyEnabled(enabled: boolean, message?: string): AutoReplyState {
  state = {
    enabled,
    message: message === undefined ? state.message : message.trim(),
  };
  saveState();
  return getAutoReplyState();
}

/** Send at most one delayed reply per peer and a bounded number per hour. */
export async function maybeAutoReply(
  api: ZaloAPI,
  threadId: string,
  threadType: number,
  options: { now?: number; delayMs?: number } = {},
): Promise<boolean> {
  if (!state.enabled || !state.message.trim() || threadType !== ThreadType.User) return false;

  const now = options.now ?? Date.now();
  if (now - (lastRepliedAt.get(threadId) ?? 0) < PEER_COOLDOWN_MS) return false;
  recentReplies = recentReplies.filter(entry => now - entry.timestamp < GLOBAL_WINDOW_MS);
  if (recentReplies.length >= AUTO_REPLY_MAX_PER_HOUR) return false;
  const delay = options.delayMs
    ?? MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
  if (!Number.isSafeInteger(delay) || delay < 0) {
    throw new Error('delayMs must be a non-negative safe integer.');
  }

  lastRepliedAt.set(threadId, now);
  const reservation = { id: ++reservationSequence, timestamp: now };
  recentReplies.push(reservation);
  // Persist before the provider call. A crash may suppress one auto-reply, but
  // it cannot resend the same automatic response after restart.
  if (!saveState()) {
    recentReplies = recentReplies.filter(entry => entry.id !== reservation.id);
    if (lastRepliedAt.get(threadId) === now) lastRepliedAt.delete(threadId);
    return false;
  }
  await new Promise(resolve => setTimeout(resolve, delay));

  let providerAccepted = false;
  try {
    const result = await api.sendMessage(
      { msg: state.message },
      threadId,
      ThreadType.User,
    ) as { message?: { msgId?: string | number; cliMsgId?: string | number } };
    providerAccepted = true;
    const msgId = result?.message?.msgId;
    if (msgId !== undefined) {
      const syntheticTelegramId = -((Date.now() * 1_000) + (reservation.id % 1_000));
      sentMsgStore.save(syntheticTelegramId, {
        msgId,
        cliMsgId: result.message?.cliMsgId,
        zaloId: threadId,
        threadType: 0,
      });
    }
    return true;
  } catch (error) {
    if (!providerAccepted) {
      recentReplies = recentReplies.filter(entry => entry.id !== reservation.id);
      if (lastRepliedAt.get(threadId) === now) lastRepliedAt.delete(threadId);
      saveState();
    }
    console.warn('[AutoReply] Failed to send:', error);
    return providerAccepted;
  }
}

export function resetAutoReplyRuntimeForTests(): void {
  lastRepliedAt.clear();
  recentReplies = [];
}

export function reloadAutoReplyStateForTests(): void {
  lastRepliedAt.clear();
  recentReplies = [];
  loadState();
}
