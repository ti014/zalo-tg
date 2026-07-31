import assert from 'node:assert/strict';
import test from 'node:test';

import { tgQueue } from '../src/utils/tgQueue.js';

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
