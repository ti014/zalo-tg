import assert from 'node:assert/strict';
import test from 'node:test';

import { tgQueue } from '../src/utils/tgQueue.js';

test('Telegram queue retries flood control wrapped in HTTP 400 but not other bad requests', async () => {
  let calls = 0;
  const sent = await tgQueue(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('400: Bad Request: too Many Requests: retry after 0'), {
      response: { error_code: 400, description: 'Bad Request: too Many Requests: retry after 0' },
    });
    return 42;
  });
  assert.equal(sent, 42);
  assert.equal(calls, 2);
  await assert.rejects(tgQueue(async () => {
    throw Object.assign(new Error('caption too long'), {
      response: { error_code: 400, description: 'message caption is too long' },
    });
  }), /caption too long/);
});

test('Telegram queue supports a per-call timeout with an uncertain error code', async () => {
  await assert.rejects(
    tgQueue(
      () => new Promise<never>(() => undefined),
      { timeoutMs: 10 },
    ),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'ETIMEDOUT');
      assert.match((error as Error).message, /timeout after/);
      return true;
    },
  );
  assert.throws(
    () => tgQueue(async () => undefined, { timeoutMs: 0 }),
    /positive safe integer/,
  );
});
