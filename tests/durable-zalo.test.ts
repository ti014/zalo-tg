import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DurableZaloRelay,
  isDurableZaloDelivery,
  markDurableZaloHandled,
  recordDurableZaloFailure,
  recordDurableZaloProviderMessageId,
  recordDurableZaloSkipped,
} from '../src/application/durable-zalo.js';
import {
  closeBridgeDatabase,
  openBridgeDatabase,
  type BridgeDatabase,
} from '../src/infrastructure/database/database.js';
import {
  DeliveryRepository,
  type DeliveryRecord,
  type DeliveryStatus,
} from '../src/infrastructure/database/delivery-repository.js';
import type { ZaloAPI, ZaloMessage } from '../src/zalo/types.js';

const api = {} as ZaloAPI;

function zaloMessage(
  msgId: string,
  conversation = 'conversation-a',
  overrides: Partial<ZaloMessage['data']> = {},
): ZaloMessage {
  return {
    type: 0 as ZaloMessage['type'],
    threadId: conversation,
    isSelf: false,
    data: {
      content: `message ${msgId}`,
      msgId,
      uidFrom: 'sender-a',
      idTo: conversation,
      ts: '1000',
      msgType: 'webchat',
      ...overrides,
    },
  };
}

async function withRepository<T>(
  run: (repository: DeliveryRepository, db: BridgeDatabase) => Promise<T> | T,
): Promise<T> {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-durable-relay-'));
  const db = openBridgeDatabase(path.join(directory, 'bridge.db'));
  try {
    return await run(new DeliveryRepository(db), db);
  } finally {
    closeBridgeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  }
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}.`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function sourceEventKey(message: ZaloMessage): string {
  const primaryId = [
    message.data.msgId,
    message.data.realMsgId,
    message.data.cliMsgId,
  ].find(value => value && value.trim() && value.trim() !== '0');
  return `${message.type}:${message.threadId}:${primaryId ?? ''}`;
}

function findDelivery(
  repository: DeliveryRepository,
  db: BridgeDatabase,
  message: ZaloMessage,
): DeliveryRecord {
  const row = db.prepare(`
    SELECT d.id
    FROM deliveries d
    JOIN inbox_events i ON i.id = d.inbox_event_id
    WHERE i.source = 'zalo' AND i.source_event_key = ?
  `).get(sourceEventKey(message)) as { id: string } | undefined;
  assert.ok(row, `delivery not found for ${sourceEventKey(message)}`);
  const delivery = repository.getById(row.id);
  assert.ok(delivery);
  return delivery;
}

test('enqueue persists a Zalo event before delivery and deduplicates an exact replay', async () => {
  await withRepository(async (repository, db) => {
    const fatalErrors: Error[] = [];
    const relay = new DurableZaloRelay({
      repository,
      processMessage: async () => assert.fail('delivery must remain offline in this test'),
      onFatal: error => fatalErrors.push(error),
    });
    const message = zaloMessage('msg-1', 'conversation-a', {
      realMsgId: 'real-1',
      cliMsgId: 'cli-1',
    });

    relay.enqueue(message);
    relay.enqueue(message);

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM inbox_events').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 1);
    assert.equal(findDelivery(repository, db, message).status, 'READY');
    assert.deepEqual(findDelivery(repository, db, message).payload, message);
    assert.deepEqual(fatalErrors, []);
    await relay.stop();
  });
});

test('enqueue deduplicates a replay enriched with additional provider aliases', async () => {
  await withRepository(async (repository, db) => {
    const relay = new DurableZaloRelay({
      repository,
      processMessage: async () => assert.fail('delivery must remain offline in this test'),
      onFatal: error => assert.fail(error),
    });
    const original = zaloMessage('msg-stable');
    const enriched = zaloMessage('msg-stable', 'conversation-a', {
      realMsgId: 'real-late',
      cliMsgId: 'cli-late',
    });

    relay.enqueue(original);
    relay.enqueue(enriched);

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM inbox_events').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 1);
    assert.equal(findDelivery(repository, db, original).status, 'READY');
    await relay.stop();
  });
});

test('queued Zalo events replay in FIFO order within a conversation', async () => {
  await withRepository(async (repository, db) => {
    const processed: string[] = [];
    const fatalErrors: Error[] = [];
    const relay = new DurableZaloRelay({
      repository,
      processMessage: async (_activeApi, message) => {
        assert.equal(isDurableZaloDelivery(), true);
        processed.push(message.data.msgId);
        markDurableZaloHandled();
      },
      onFatal: error => fatalErrors.push(error),
      pollIntervalMs: 60_000,
    });
    const first = zaloMessage('msg-1');
    const second = zaloMessage('msg-2');
    const third = zaloMessage('msg-3');

    relay.enqueue(first);
    relay.enqueue(second);
    relay.enqueue(third);
    relay.start();
    relay.setApi(api);

    await waitFor(
      () => [first, second, third].every(message => findDelivery(repository, db, message).status === 'SENT'),
      'all FIFO deliveries to become SENT',
    );
    assert.deepEqual(processed, ['msg-1', 'msg-2', 'msg-3']);
    assert.equal(isDurableZaloDelivery(), false);
    assert.deepEqual(fatalErrors, []);
    await relay.stop();
  });
});

test('successful delivery persists provider receipt and policy-skip audit details', async () => {
  await withRepository(async (repository, db) => {
    const receiptMessage = zaloMessage('receipt-1');
    const skippedMessage = zaloMessage('skip-1');
    const relay = new DurableZaloRelay({
      repository,
      processMessage: async (_activeApi, message) => {
        markDurableZaloHandled();
        if (message.data.msgId === 'receipt-1') {
          recordDurableZaloProviderMessageId(987654);
        } else {
          recordDurableZaloSkipped(
            'SKIPPED_MUTED_GROUP',
            'Skipped by configured muted-group policy.',
          );
        }
      },
      onFatal: error => assert.fail(error),
      pollIntervalMs: 60_000,
    });
    relay.enqueue(receiptMessage);
    relay.enqueue(skippedMessage);
    relay.start();
    relay.setApi(api);

    await waitFor(
      () => findDelivery(repository, db, receiptMessage).status === 'SENT'
        && findDelivery(repository, db, skippedMessage).status === 'SKIPPED',
      'receipt and policy-skip deliveries to become terminal',
    );
    const receipt = findDelivery(repository, db, receiptMessage);
    const skipped = findDelivery(repository, db, skippedMessage);
    assert.equal(receipt.providerMessageId, '987654');
    assert.equal(receipt.lastErrorCode, null);
    assert.equal(skipped.providerMessageId, null);
    assert.equal(skipped.status, 'SKIPPED');
    assert.equal(skipped.lastErrorCode, null);
    assert.equal(
      repository.getSkipAudit(skipped.id)?.reasonCode,
      'SKIPPED_MUTED_GROUP',
    );
    await relay.stop();
  });
});

test('delivery execution does not recursively create or process another delivery', async () => {
  await withRepository(async (repository, db) => {
    let processed = 0;
    const fatalErrors: Error[] = [];
    let relay!: DurableZaloRelay;
    relay = new DurableZaloRelay({
      repository,
      processMessage: async (_activeApi, replayedMessage) => {
        processed += 1;
        assert.equal(isDurableZaloDelivery(), true);
        relay.enqueue(replayedMessage);
        markDurableZaloHandled();
      },
      onFatal: error => fatalErrors.push(error),
      pollIntervalMs: 60_000,
    });
    const message = zaloMessage('recursive-1');

    relay.enqueue(message);
    relay.start();
    relay.setApi(api);

    await waitFor(
      () => findDelivery(repository, db, message).status === 'SENT',
      'recursive-capture delivery to become SENT',
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(processed, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM inbox_events').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 1);
    assert.equal(isDurableZaloDelivery(), false);
    assert.deepEqual(fatalErrors, []);
    await relay.stop();
  });
});

async function observeFailureStatus(options: {
  handled: boolean;
  failure?: unknown;
  throwFailure?: boolean;
  maxAttempts?: number;
}): Promise<DeliveryRecord> {
  return withRepository(async (repository, db) => {
    const fatalErrors: Error[] = [];
    const message = zaloMessage('failure-1');
    const relay = new DurableZaloRelay({
      repository,
      processMessage: async () => {
        if (options.handled) markDurableZaloHandled();
        if (options.failure !== undefined) {
          if (options.throwFailure) throw options.failure;
          recordDurableZaloFailure(options.failure);
        }
      },
      onFatal: error => fatalErrors.push(error),
      pollIntervalMs: 60_000,
      maxAttempts: options.maxAttempts,
    });
    relay.enqueue(message);
    relay.start();
    relay.setApi(api);

    const terminalOrRetry: ReadonlySet<DeliveryStatus> = new Set([
      'RETRY',
      'UNKNOWN',
      'PERMANENT_FAILED',
      'DLQ',
    ]);
    await waitFor(
      () => terminalOrRetry.has(findDelivery(repository, db, message).status),
      'delivery failure transition',
    );
    const delivery = findDelivery(repository, db, message);
    await relay.stop();
    assert.deepEqual(fatalErrors, []);
    return delivery;
  });
}

test('delivery failures transition to retry, unknown, permanent failure, or DLQ', async () => {
  const retry = await observeFailureStatus({
    handled: true,
    failure: Object.assign(new Error('temporary provider failure'), { code: 'EAGAIN' }),
    throwFailure: true,
  });
  assert.equal(retry.status, 'RETRY');
  assert.equal(retry.lastErrorCode, 'EAGAIN');

  const unknown = await observeFailureStatus({
    handled: true,
    failure: Object.assign(new Error('socket timed out'), { code: 'ETIMEDOUT' }),
  });
  assert.equal(unknown.status, 'UNKNOWN');
  assert.equal(unknown.lastErrorCode, 'ETIMEDOUT');

  const permanent = await observeFailureStatus({
    handled: true,
    failure: Object.assign(new Error('payload too large'), { code: 413 }),
  });
  assert.equal(permanent.status, 'PERMANENT_FAILED');
  assert.equal(permanent.lastErrorCode, '413');

  const missingTopicPermission = await observeFailureStatus({
    handled: true,
    failure: Object.assign(
      new Error('Telegram bot lacks the Manage Topics permission.'),
      { code: 'TELEGRAM_MANAGE_TOPICS_REQUIRED' },
    ),
  });
  assert.equal(missingTopicPermission.status, 'PERMANENT_FAILED');
  assert.equal(
    missingTopicPermission.lastErrorCode,
    'TELEGRAM_MANAGE_TOPICS_REQUIRED',
  );
  assert.equal(missingTopicPermission.attempts, 1);

  const unhandled = await observeFailureStatus({
    handled: false,
  });
  assert.equal(unhandled.status, 'PERMANENT_FAILED');
  assert.equal(unhandled.lastErrorCode, 'DELIVERY_FAILED');

  const dlq = await observeFailureStatus({
    handled: true,
    failure: Object.assign(new Error('retry budget exhausted'), { code: 'EAGAIN' }),
    maxAttempts: 1,
  });
  assert.equal(dlq.status, 'DLQ');
  assert.equal(dlq.lastErrorCode, 'MAX_ATTEMPTS');
});

test('stop waits for an in-flight delivery and leaves later FIFO work replayable', async () => {
  await withRepository(async (repository, db) => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>(resolve => { firstStarted = resolve; });
    const processed: string[] = [];
    const relay = new DurableZaloRelay({
      repository,
      processMessage: async (_activeApi, message) => {
        processed.push(message.data.msgId);
        markDurableZaloHandled();
        if (message.data.msgId === 'stop-1') {
          firstStarted();
          await firstGate;
        }
      },
      onFatal: error => assert.fail(error),
      pollIntervalMs: 5,
    });
    const first = zaloMessage('stop-1');
    const second = zaloMessage('stop-2');
    relay.enqueue(first);
    relay.enqueue(second);
    relay.start();
    relay.setApi(api);
    await started;

    let stopped = false;
    const stopping = relay.stop().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(stopped, false);

    releaseFirst();
    await stopping;
    assert.deepEqual(processed, ['stop-1']);
    assert.equal(findDelivery(repository, db, first).status, 'SENT');
    assert.equal(findDelivery(repository, db, second).status, 'READY');
  });
});

test('stop rejects after its deadline instead of hanging forever', async () => {
  await withRepository(async (repository, db) => {
    let releaseDelivery!: () => void;
    const deliveryGate = new Promise<void>(resolve => { releaseDelivery = resolve; });
    let deliveryStarted!: () => void;
    const started = new Promise<void>(resolve => { deliveryStarted = resolve; });
    const message = zaloMessage('stop-timeout-1');
    const relay = new DurableZaloRelay({
      repository,
      processMessage: async () => {
        deliveryStarted();
        await deliveryGate;
        markDurableZaloHandled();
      },
      onFatal: error => assert.fail(error),
      pollIntervalMs: 5,
      stopTimeoutMs: 20,
    });
    relay.enqueue(message);
    relay.start();
    relay.setApi(api);
    await started;

    await assert.rejects(
      relay.stop(),
      error => (error as { code?: string }).code === 'WORKER_STOP_TIMEOUT',
    );
    releaseDelivery();
    await waitFor(
      () => findDelivery(repository, db, message).status === 'SENT',
      'delivery completion after stop timeout',
    );
  });
});
