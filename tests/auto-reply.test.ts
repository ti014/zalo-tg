import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

process.env.TG_TOKEN ??= 'test-token';
process.env.TG_GROUP_ID ??= '-1001234567890';
process.env.TG_OWNER_IDS ??= '123456789';
process.env.DATA_DIR ??= path.join(os.tmpdir(), `zalo-tg-autoreply-${process.pid}`);

const {
  getAutoReplyState,
  reloadAutoReplyStateForTests,
  resetAutoReplyRuntimeForTests,
  setAutoReplyEnabled,
  maybeAutoReply,
} = await import('../src/zalo/auto-reply.js');

test('auto-reply state is opt-in and persists the configured message in memory', () => {
  setAutoReplyEnabled(false, '');
  assert.deepEqual(getAutoReplyState(), { enabled: false, message: '' });
  setAutoReplyEnabled(true, 'Tôi đang bận');
  assert.deepEqual(getAutoReplyState(), { enabled: true, message: 'Tôi đang bận' });
  setAutoReplyEnabled(false);
  resetAutoReplyRuntimeForTests();
});

test('auto-reply persists its reservation before sending and restores cooldown after reload', async () => {
  resetAutoReplyRuntimeForTests();
  setAutoReplyEnabled(true, 'Tôi đang bận');
  let calls = 0;
  const api = {
    sendMessage: async () => {
      calls += 1;
      return { message: { msgId: 'auto-1', cliMsgId: 'client-auto-1' } };
    },
  };
  const now = Date.now();
  assert.equal(await maybeAutoReply(api as never, 'peer-1', 0, { now, delayMs: 0 }), true);
  const persisted = JSON.parse(readFileSync(
    path.join(process.env.DATA_DIR!, 'autoreply.json'),
    'utf8',
  )) as {
    lastRepliedAt?: Record<string, number>;
    recentReplyTimestamps?: number[];
  };
  assert.equal(persisted.lastRepliedAt?.['peer-1'], now);
  assert.deepEqual(persisted.recentReplyTimestamps, [now]);

  reloadAutoReplyStateForTests();
  assert.equal(
    await maybeAutoReply(api as never, 'peer-1', 0, { now: now + 1_000, delayMs: 0 }),
    false,
  );
  assert.equal(calls, 1);
  resetAutoReplyRuntimeForTests();
  setAutoReplyEnabled(false, '');
});

test('auto-reply never answers group threads or disabled state', async () => {
  setAutoReplyEnabled(false, 'busy');
  resetAutoReplyRuntimeForTests();
  let calls = 0;
  const api = { sendMessage: async () => { calls += 1; return {}; } };
  assert.equal(await maybeAutoReply(api as never, 'group', 1), false);
  assert.equal(await maybeAutoReply(api as never, 'dm', 0), false);
  assert.equal(calls, 0);
});
