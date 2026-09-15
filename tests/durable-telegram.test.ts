import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Context, MiddlewareFn, Telegraf } from 'telegraf';

import {
  abortTelegramPollingForCapture,
  DurableTelegramCaptureError,
  DurableTelegramRelay,
  markDurableTelegramHandled,
  recordDurableTelegramFailure,
  recordDurableTelegramProviderMessageId,
  recordDurableTelegramSkipped,
} from '../src/application/durable-telegram.js';
import {
  closeBridgeDatabase,
  openBridgeDatabase,
  type BridgeDatabase,
} from '../src/infrastructure/database/database.js';
import { DeliveryRepository } from '../src/infrastructure/database/delivery-repository.js';
import type { TopicEntry } from '../src/store/topics.js';
import type { ZaloAPI } from '../src/zalo/types.js';

const TELEGRAM_CHAT_ID = -100123;
const TOPIC: TopicEntry = {
  topicId: 42,
  zaloId: 'zalo-conversation-1',
  type: 0,
  name: 'Conversation 1',
};

function telegramUpdate(updateId: number, text = `message-${updateId}`) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      message_thread_id: TOPIC.topicId,
      text,
      chat: { id: TELEGRAM_CHAT_ID, type: 'supergroup' as const },
      from: { id: 100, is_bot: false, first_name: 'User' },
    },
  };
}

function contextFor(update: ReturnType<typeof telegramUpdate>): Context {
  return {
    update,
    message: update.message,
    chat: update.message.chat,
    from: update.message.from,
  } as unknown as Context;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function withDatabase(
  run: (db: BridgeDatabase, repository: DeliveryRepository) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-durable-telegram-'));
  const db = openBridgeDatabase(path.join(directory, 'bridge.db'));
  try {
    await run(db, new DeliveryRepository(db));
  } finally {
    closeBridgeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  }
}

function deliveryStatus(db: BridgeDatabase, updateId: number): string | undefined {
  return (db.prepare(`
    SELECT d.status
    FROM deliveries d
    JOIN inbox_events i ON i.id = d.inbox_event_id
    WHERE i.source = 'telegram' AND i.source_event_key = ?
  `).get(`update:${updateId}`) as { status: string } | undefined)?.status;
}

test('middleware persists a mapped message and does not execute relay handlers inline', async () => {
  await withDatabase(async (db, repository) => {
    let nextCalls = 0;
    const relay = new DurableTelegramRelay({
      repository,
      bot: { handleUpdate: async () => undefined } as unknown as Telegraf,
      telegramChatId: TELEGRAM_CHAT_ID,
      getApi: () => null,
      getTopic: topicId => topicId === TOPIC.topicId ? TOPIC : undefined,
      onFatal: error => { throw error; },
    });

    const update = telegramUpdate(1);
    await relay.middleware()(contextFor(update), async () => { nextCalls += 1; });

    assert.equal(nextCalls, 0);
    assert.equal(deliveryStatus(db, update.update_id), 'READY');
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM inbox_events').get() as { count: number }).count,
      1,
    );
    await relay.stop();
  });
});

test('middleware captures an anonymous administrator message instead of treating it as a bot echo', async () => {
  await withDatabase(async (db, repository) => {
    let nextCalls = 0;
    const relay = new DurableTelegramRelay({
      repository,
      bot: { handleUpdate: async () => undefined } as unknown as Telegraf,
      telegramChatId: TELEGRAM_CHAT_ID,
      getApi: () => null,
      getTopic: topicId => topicId === TOPIC.topicId ? TOPIC : undefined,
      onFatal: error => { throw error; },
    });
    const update = telegramUpdate(3) as ReturnType<typeof telegramUpdate> & {
      message: ReturnType<typeof telegramUpdate>['message'] & {
        sender_chat: { id: number; type: 'supergroup' };
      };
    };
    update.message.from = {
      id: 1087968824,
      is_bot: true,
      first_name: 'GroupAnonymousBot',
    };
    update.message.sender_chat = { id: TELEGRAM_CHAT_ID, type: 'supergroup' };

    await relay.middleware()(contextFor(update), async () => { nextCalls += 1; });

    assert.equal(nextCalls, 0);
    assert.equal(deliveryStatus(db, update.update_id), 'READY');
    await relay.stop();
  });
});

test('capture failure aborts polling without committing the Telegram offset', async () => {
  const persistenceFailure = new Error('disk full');
  const repository = {
    ingestAndEnqueue: () => { throw persistenceFailure; },
  } as unknown as DeliveryRepository;
  let reportedFatal: Error | undefined;
  const relay = new DurableTelegramRelay({
    repository,
    bot: { handleUpdate: async () => undefined } as unknown as Telegraf,
    telegramChatId: TELEGRAM_CHAT_ID,
    getApi: () => null,
    getTopic: () => TOPIC,
    onFatal: error => { reportedFatal = error; },
  });

  const update = telegramUpdate(2);
  let captureError: DurableTelegramCaptureError | undefined;
  await assert.rejects(
    relay.middleware()(contextFor(update), async () => assert.fail('captured inline')),
    error => {
      assert.ok(error instanceof DurableTelegramCaptureError);
      captureError = error;
      assert.equal(error.updateId, update.update_id);
      assert.equal(error.cause, persistenceFailure);
      return true;
    },
  );
  assert.equal(reportedFatal, captureError);

  const polling = { skipOffsetSync: false };
  const bot = { polling } as unknown as Telegraf;
  assert.throws(
    () => abortTelegramPollingForCapture(bot, captureError!),
    error => error === captureError,
  );
  assert.equal(polling.skipOffsetSync, true);
  await relay.stop();
});

test('replay bypasses capture recursion and preserves FIFO within a conversation', async () => {
  await withDatabase(async (db, repository) => {
    const replayed: number[] = [];
    let middleware!: MiddlewareFn<Context>;
    const bot = {
      handleUpdate: async (rawUpdate: ReturnType<typeof telegramUpdate>) => {
        await middleware(contextFor(rawUpdate), async () => {
          replayed.push(rawUpdate.update_id);
          markDurableTelegramHandled();
          recordDurableTelegramProviderMessageId(`zalo:${rawUpdate.update_id}`);
        });
      },
    } as unknown as Telegraf;
    const relay = new DurableTelegramRelay({
      repository,
      bot,
      telegramChatId: TELEGRAM_CHAT_ID,
      getApi: () => ({}) as ZaloAPI,
      getTopic: () => TOPIC,
      onFatal: error => { throw error; },
      pollIntervalMs: 10,
    });
    middleware = relay.middleware();

    await middleware(contextFor(telegramUpdate(10)), async () => assert.fail('captured inline'));
    await middleware(contextFor(telegramUpdate(11)), async () => assert.fail('captured inline'));
    relay.start();

    await waitFor(() => deliveryStatus(db, 10) === 'SENT' && deliveryStatus(db, 11) === 'SENT');
    assert.deepEqual(replayed, [10, 11]);
    const receipts = db.prepare(`
      SELECT provider_message_id
      FROM deliveries
      ORDER BY sequence_no
    `).all() as Array<{ provider_message_id: string | null }>;
    assert.deepEqual(receipts.map(row => row.provider_message_id), ['zalo:10', 'zalo:11']);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM inbox_events').get() as { count: number }).count,
      2,
    );
    await relay.stop();
  });
});

test('replay uses the captured conversation target after the topic mapping changes', async () => {
  await withDatabase(async (db, repository) => {
    let currentTopic: TopicEntry = TOPIC;
    let replayedTarget: { type: 0 | 1; zaloId: string } | undefined;
    const relay = new DurableTelegramRelay({
      repository,
      bot: { handleUpdate: async () => undefined } as unknown as Telegraf,
      telegramChatId: TELEGRAM_CHAT_ID,
      getApi: () => ({}) as ZaloAPI,
      getTopic: () => currentTopic,
      onFatal: error => { throw error; },
      replayUpdate: async (_update, target) => {
        replayedTarget = target;
        markDurableTelegramHandled();
      },
      pollIntervalMs: 10,
    });

    const update = telegramUpdate(12);
    await relay.middleware()(contextFor(update), async () => assert.fail('captured inline'));
    currentTopic = { ...TOPIC, zaloId: 'different-zalo-conversation' };
    relay.start();

    await waitFor(() => deliveryStatus(db, update.update_id) === 'SENT');
    assert.deepEqual(replayedTarget, { type: TOPIC.type, zaloId: TOPIC.zaloId });
    await relay.stop();
  });
});

test('worker classifies uncertain outcome and an unhandled replay explicitly', async t => {
  await t.test('handled timeout becomes UNKNOWN', async () => {
    await withDatabase(async (db, repository) => {
      const bot = {
        handleUpdate: async () => {
          markDurableTelegramHandled();
          recordDurableTelegramFailure(Object.assign(new Error('send timed out'), { code: 'ETIMEDOUT' }));
        },
      } as unknown as Telegraf;
      const relay = new DurableTelegramRelay({
        repository,
        bot,
        telegramChatId: TELEGRAM_CHAT_ID,
        getApi: () => ({}) as ZaloAPI,
        getTopic: () => TOPIC,
        onFatal: error => { throw error; },
        pollIntervalMs: 10,
      });

      await relay.middleware()(contextFor(telegramUpdate(20)), async () => assert.fail('captured inline'));
      relay.start();
      await waitFor(() => deliveryStatus(db, 20) === 'UNKNOWN');
      await relay.stop();
    });
  });

  await t.test('replay that reaches no relay handler becomes PERMANENT_FAILED', async () => {
    await withDatabase(async (db, repository) => {
      const relay = new DurableTelegramRelay({
        repository,
        bot: { handleUpdate: async () => undefined } as unknown as Telegraf,
        telegramChatId: TELEGRAM_CHAT_ID,
        getApi: () => ({}) as ZaloAPI,
        getTopic: () => TOPIC,
        onFatal: error => { throw error; },
        pollIntervalMs: 10,
      });

      await relay.middleware()(contextFor(telegramUpdate(21)), async () => assert.fail('captured inline'));
      relay.start();
      await waitFor(() => deliveryStatus(db, 21) === 'PERMANENT_FAILED');
      await relay.stop();
    });
  });
});

test('worker records Telegram service events as audited skips', async () => {
  await withDatabase(async (db, repository) => {
    const relay = new DurableTelegramRelay({
      repository,
      bot: { handleUpdate: async () => undefined } as unknown as Telegraf,
      telegramChatId: TELEGRAM_CHAT_ID,
      getApi: () => ({}) as ZaloAPI,
      getTopic: () => TOPIC,
      onFatal: error => { throw error; },
      replayUpdate: async () => {
        markDurableTelegramHandled();
        recordDurableTelegramSkipped(
          'SKIPPED_TELEGRAM_SERVICE_EVENT',
          'Not a user message.',
        );
      },
      pollIntervalMs: 10,
    });

    const update = telegramUpdate(22);
    await relay.middleware()(contextFor(update), async () => assert.fail('captured inline'));
    relay.start();
    await waitFor(() => deliveryStatus(db, 22) === 'SKIPPED');
    const audit = db.prepare(`
      SELECT reason_code, reason FROM delivery_skip_audits
    `).get() as { reason_code: string; reason: string };
    assert.deepEqual(audit, {
      reason_code: 'SKIPPED_TELEGRAM_SERVICE_EVENT',
      reason: 'Not a user message.',
    });
    await relay.stop();
  });
});

test('stop waits for the active delivery before resolving', async () => {
  await withDatabase(async (db, repository) => {
    let releaseDelivery!: () => void;
    const deliveryGate = new Promise<void>(resolve => { releaseDelivery = resolve; });
    const bot = {
      handleUpdate: async () => {
        await deliveryGate;
        markDurableTelegramHandled();
      },
    } as unknown as Telegraf;
    const relay = new DurableTelegramRelay({
      repository,
      bot,
      telegramChatId: TELEGRAM_CHAT_ID,
      getApi: () => ({}) as ZaloAPI,
      getTopic: () => TOPIC,
      onFatal: error => { throw error; },
      pollIntervalMs: 10,
    });

    await relay.middleware()(contextFor(telegramUpdate(30)), async () => assert.fail('captured inline'));
    relay.start();
    await waitFor(() => deliveryStatus(db, 30) === 'SENDING');

    let stopped = false;
    const stopping = relay.stop().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(stopped, false);

    releaseDelivery();
    await stopping;
    assert.equal(deliveryStatus(db, 30), 'SENT');
  });
});

test('stop rejects after its deadline instead of waiting forever', async () => {
  await withDatabase(async (db, repository) => {
    let releaseDelivery!: () => void;
    const deliveryGate = new Promise<void>(resolve => { releaseDelivery = resolve; });
    const relay = new DurableTelegramRelay({
      repository,
      bot: {
        handleUpdate: async () => {
          await deliveryGate;
          markDurableTelegramHandled();
        },
      } as unknown as Telegraf,
      telegramChatId: TELEGRAM_CHAT_ID,
      getApi: () => ({}) as ZaloAPI,
      getTopic: () => TOPIC,
      onFatal: error => { throw error; },
      pollIntervalMs: 10,
      stopTimeoutMs: 20,
    });

    await relay.middleware()(contextFor(telegramUpdate(31)), async () => assert.fail('captured inline'));
    relay.start();
    await waitFor(() => deliveryStatus(db, 31) === 'SENDING');

    await assert.rejects(
      relay.stop(),
      error => (error as { code?: string }).code === 'WORKER_STOP_TIMEOUT',
    );
    releaseDelivery();
    await waitFor(() => deliveryStatus(db, 31) === 'SENT');
  });
});
