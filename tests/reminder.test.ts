import assert from 'node:assert/strict';
import test from 'node:test';
import { ThreadType } from 'zca-js';

import { fetchEcardReminderTitle, parseEcardReminderRef } from '../src/zalo/reminder.js';
import type { ZaloAPI } from '../src/zalo/types.js';
import { runZaloRequest } from '../src/zalo/rate-limit.js';

function params(action: Record<string, unknown>): string {
  return JSON.stringify({ actions: [{ data: JSON.stringify(action) }] });
}

test('parses group and direct reminder references from e-card params', () => {
  assert.deepEqual(parseEcardReminderRef(params({
    act: 'remind_topic', act_type: 'group', data: JSON.stringify({ topicId: 'group-reminder' }),
  })), { kind: 'group', topicId: 'group-reminder' });
  assert.deepEqual(parseEcardReminderRef(params({
    act: 'remind_reminder11', act_type: 'oneone', data: JSON.stringify({ reminderId: 'dm-reminder' }),
  })), { kind: 'oneone', reminderId: 'dm-reminder' });
  assert.equal(parseEcardReminderRef('not JSON'), undefined);
  for (const malformed of ['null', '{"actions":{}}', '{"actions":[null]}', params({ act: 42 })]) {
    assert.equal(parseEcardReminderRef(malformed), undefined);
  }
});

test('looks up full group text and retries direct self-chat through own ID', async () => {
  const calls: string[] = [];
  const api = {
    getReminder: async (id: string) => ({ id, params: { title: `Group reminder ${id}` } }),
    getOwnId: () => 'me',
    getListReminder: async (_options: unknown, owner: string, type: ThreadType) => {
      calls.push(`${owner}:${type}`);
      if (owner === 'peer') throw new Error('not available');
      return [{ reminderId: 'dm-reminder', params: { title: 'Full direct reminder' } }];
    },
  } as unknown as ZaloAPI;
  assert.equal(await fetchEcardReminderTitle(api, { kind: 'group', topicId: 'g1' }, 'ignored'), 'Group reminder g1');
  assert.equal(await fetchEcardReminderTitle(api, { kind: 'oneone', reminderId: 'dm-reminder' }, 'peer', 10_000), 'Full direct reminder');
  assert.deepEqual(calls, [`peer:${ThreadType.User}`, `me:${ThreadType.User}`]);
});

test('reminder deadline returns fallback, stops pagination and skips expired queued lookups', async () => {
  // Clear the lane cooldown so this test exercises an in-flight read, not just queue expiry.
  await new Promise(resolve => setTimeout(resolve, 2600));
  let finish!: (rows: unknown[]) => void;
  let calls = 0;
  const api = {
    getOwnId: () => 'me',
    getListReminder: () => {
      calls += 1;
      return new Promise<unknown[]>(resolve => { finish = resolve; });
    },
  } as unknown as ZaloAPI;
  assert.equal(await fetchEcardReminderTitle(api, { kind: 'oneone', reminderId: 'missing' }, 'peer', 100), undefined);
  assert.equal(calls, 1);
  finish(Array.from({ length: 20 }, () => ({ id: 'other' })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);

  let unblock!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const blocker = runZaloRequest({ label: 'test blocked lane', priority: 'low', minIntervalMs: 0 }, () => {
    started();
    return new Promise<void>(resolve => { unblock = resolve; });
  });
  await ready;
  let queuedCalls = 0;
  const queuedApi = { getReminder: async () => { queuedCalls += 1; return {}; } } as ZaloAPI;
  assert.equal(await fetchEcardReminderTitle(queuedApi, { kind: 'group', topicId: 'late' }, 'g', 10), undefined);
  unblock();
  await blocker;
  await runZaloRequest({ label: 'test lane barrier', priority: 'low', minIntervalMs: 0 }, async () => undefined);
  assert.equal(queuedCalls, 0);
});
