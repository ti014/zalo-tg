import assert from 'node:assert/strict';
import test from 'node:test';
import { createUnknownDeliveryCheck } from '../src/application/unknown-delivery-alerts.js';
import type { DeliveryRecord, UnknownDeliveryCursor } from '../src/infrastructure/database/delivery-repository.js';

const rows = Array.from({ length: 55 }, (_, i) => ({
  id: `delivery-${String(i).padStart(3, '0')}`,
  updatedAt: 100,
  destination: 'telegram',
  conversationKey: `0:person-${i}`,
})) as DeliveryRecord[];

function after(cursor: UnknownDeliveryCursor): DeliveryRecord[] {
  return rows.filter(row => row.updatedAt > cursor.updatedAt
    || (row.updatedAt === cursor.updatedAt && row.id > cursor.id)).slice(0, 50);
}

test('UNKNOWN alerts split Telegram-sized messages and include same-timestamp next page', async () => {
  const sent: string[] = [];
  const check = createUnknownDeliveryCheck({ listUnknownAfter: after }, async text => { sent.push(text); }, () => 'Tên dài 👩‍💻'.repeat(60));
  await check();
  await check();
  await check();
  assert.ok(sent.length > 2);
  assert.ok(sent.every(text => text.length <= 4096));
  for (const row of rows) assert.equal(sent.join('\n').split(`/queue detail ${row.id}`).length - 1, 1);
});

test('failed alert send retries only its unsent batch and prevents overlapping checks', async () => {
  const sent: string[] = [];
  let fail = true;
  const check = createUnknownDeliveryCheck({ listUnknownAfter: after }, async text => {
    if (sent.length === 1 && fail) { fail = false; throw new Error('network failed'); }
    sent.push(text);
  }, () => 'long name '.repeat(30));
  await assert.rejects(check(), /network failed/);
  await check();
  await check();
  for (const row of rows) assert.equal(sent.join('\n').split(`/queue detail ${row.id}`).length - 1, 1);

  let finish!: () => void;
  let calls = 0;
  const slow = createUnknownDeliveryCheck({ listUnknownAfter: cursor => after(cursor).slice(0, 1) }, () => {
    calls += 1;
    return new Promise<void>(resolve => { finish = resolve; });
  }, () => 'Person');
  const pending = slow();
  await slow();
  assert.equal(calls, 1);
  finish();
  await pending;
});
