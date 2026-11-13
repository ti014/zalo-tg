import assert from 'node:assert/strict';
import test from 'node:test';
import { ThreadType } from 'zca-js';

import { fetchEcardReminderTitle, parseEcardReminderRef } from '../src/zalo/reminder.js';
import type { ZaloAPI } from '../src/zalo/types.js';

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
  assert.equal(await fetchEcardReminderTitle(api, { kind: 'oneone', reminderId: 'dm-reminder' }, 'peer'), 'Full direct reminder');
  assert.deepEqual(calls, [`peer:${ThreadType.User}`, `me:${ThreadType.User}`]);
});
