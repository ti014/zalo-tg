import { ThreadType } from 'zca-js';

import type { ZaloAPI } from './types.js';

export type EcardReminderRef =
  | { kind: 'group'; topicId: string }
  | { kind: 'oneone'; reminderId: string };

interface ReminderLike {
  reminderId?: unknown;
  id?: unknown;
  params?: { title?: unknown } | null;
}

function parseJson<T>(raw: unknown): T | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

function nonZeroId(value: unknown): string | undefined {
  const id = String(value ?? '').trim();
  return id && id !== '0' ? id : undefined;
}

/** Find a reminder reference in an e-card params payload. */
export function parseEcardReminderRef(params: string | undefined): EcardReminderRef | undefined {
  const outer = parseJson<{ actions?: Array<{ data?: unknown }> }>(params);
  for (const action of outer?.actions ?? []) {
    const detail = parseJson<{ act?: string; act_type?: string; data?: unknown }>(action.data);
    if (!detail?.act?.startsWith('remind_')) continue;
    const data = parseJson<{ topicId?: unknown; reminderId?: unknown }>(detail.data);
    if (!data) continue;
    if (detail.act_type === 'group') {
      const topicId = nonZeroId(data.topicId);
      if (topicId) return { kind: 'group', topicId };
    } else {
      const reminderId = nonZeroId(data.reminderId);
      if (reminderId) return { kind: 'oneone', reminderId };
    }
  }
  return undefined;
}

function titleOf(reminder: ReminderLike | undefined): string | undefined {
  const title = reminder?.params?.title;
  return typeof title === 'string' && title.trim() ? title.trim() : undefined;
}

async function findDirectReminder(api: ZaloAPI, ownerId: string, reminderId: string): Promise<string | undefined> {
  for (let page = 1; page <= 5; page += 1) {
    const reminders = await api.getListReminder({ page, count: 20 }, ownerId, ThreadType.User) as ReminderLike[];
    if (!Array.isArray(reminders) || reminders.length === 0) return undefined;
    const found = reminders.find(reminder => String(reminder.reminderId ?? reminder.id) === reminderId);
    if (found) return titleOf(found);
    if (reminders.length < 20) return undefined;
  }
  return undefined;
}

/** Return full reminder text, or undefined so callers can retain e-card fallback text. */
export async function fetchEcardReminderTitle(
  api: ZaloAPI,
  reference: EcardReminderRef,
  threadId: string,
): Promise<string | undefined> {
  if (reference.kind === 'group') {
    return titleOf(await api.getReminder(reference.topicId) as ReminderLike);
  }
  for (const ownerId of new Set([threadId, String(api.getOwnId?.() ?? '')])) {
    if (!ownerId || ownerId === '0') continue;
    try {
      const title = await findDirectReminder(api, ownerId, reference.reminderId);
      if (title) return title;
    } catch { /* Retry using own ID for self-chat and unavailable peer lists. */ }
  }
  return undefined;
}
