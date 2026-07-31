import assert from 'node:assert/strict';
import test from 'node:test';

import { sendWithOneTopicRetry } from '../src/domain/topic-retry.js';

test('current payload is retried once on the recovered topic', async () => {
  const attempts: number[] = [];
  let recovered: number | undefined;
  const result = await sendWithOneTopicRetry({
    topicId: 10,
    send: async topicId => {
      attempts.push(topicId);
      if (topicId === 10) throw new Error('topic closed');
      return 'sent';
    },
    isUnavailable: error => (error as Error).message === 'topic closed',
    recover: async stale => {
      assert.equal(stale, 10);
      return 20;
    },
    onRecovered: topicId => { recovered = topicId; },
  });

  assert.equal(result, 'sent');
  assert.equal(recovered, 20);
  assert.deepEqual(attempts, [10, 20]);
});

test('unrelated errors are not recovered or retried', async () => {
  let recoveryCalls = 0;
  await assert.rejects(sendWithOneTopicRetry({
    topicId: 10,
    send: async () => { throw new Error('rate limited'); },
    isUnavailable: () => false,
    recover: async () => { recoveryCalls += 1; return 20; },
  }), /rate limited/);
  assert.equal(recoveryCalls, 0);
});
