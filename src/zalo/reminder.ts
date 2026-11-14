import { ThreadType } from 'zca-js';

import type { ZaloAPI } from './types.js';
import { runZaloRequest } from './rate-limit.js';

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
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const id = String(value).trim();
  return id && id !== '0' ? id : undefined;
}

/** Find a reminder reference in an e-card params payload. */
export function parseEcardReminderRef(params: string | undefined): EcardReminderRef | undefined {
  const outer = parseJson<{ actions?: Array<{ data?: unknown }> }>(params);
  if (!Array.isArray(outer?.actions)) return undefined;
  for (const action of outer.actions) {
    const detail = parseJson<{ act?: unknown; act_type?: string; data?: unknown }>(action?.data);
    if (typeof detail?.act !== 'string' || !detail.act.startsWith('remind_')) continue;
    const data = parseJson<{ topicId?: unknown; reminderId?: unknown }>(detail.data);
    if (!data) continue;
    if (detail.act_type === 'group') {
      const topicId = nonZeroId(data.topicId);
      if (topicId) return { kind: 'group', topicId };
    } else if (detail.act_type === 'oneone') {
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

/** Optional read-only enrichment: queue time and all pages share one deadline. */
export async function fetchEcardReminderTitle(
  api: ZaloAPI,
  reference: EcardReminderRef,
  threadId: string,
  timeoutMs = 5_000,
): Promise<string | undefined> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeoutMs must be a positive safe integer.');
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<undefined>(resolve => {
    timer = setTimeout(() => { expired = true; resolve(undefined); }, timeoutMs);
  });
  const read = <T>(request: () => Promise<T>): Promise<T | undefined> => Promise.race([
    deadline,
    runZaloRequest({ label: 'ecard reminder lookup', priority: 'low', maxRetries: 0 }, () => {
      if (expired) return Promise.resolve(undefined);
      // ZCA cannot abort this read; release the lane on expiry and stop further pages.
      return Promise.race([request(), deadline]);
    }),
  ]);
  const lookup = async (): Promise<string | undefined> => {
    if (expired) return undefined;
    if (reference.kind === 'group') {
      return titleOf(await read<ReminderLike>(() => api.getReminder(reference.topicId)));
    }
    for (const ownerId of new Set([threadId, String(api.getOwnId?.() ?? '')])) {
      if (expired) return undefined;
      if (!ownerId || ownerId === '0') continue;
      try {
        for (let page = 1; page <= 5 && !expired; page += 1) {
          const reminders = await read<ReminderLike[]>(() => api.getListReminder({ page, count: 20 }, ownerId, ThreadType.User));
          if (expired) return undefined;
          if (!Array.isArray(reminders) || reminders.length === 0) break;
          const found = reminders.find(reminder => String(reminder?.reminderId ?? reminder?.id) === reference.reminderId);
          if (found) return titleOf(found);
          if (reminders.length < 20) break;
        }
      } catch { /* Try own ID for self-chat unless the total budget has expired. */ }
    }
    return undefined;
  };
  try {
    return await Promise.race([lookup(), deadline]);
  } catch {
    return undefined;
  } finally {
    expired = true;
    clearTimeout(timer!);
  }
}
