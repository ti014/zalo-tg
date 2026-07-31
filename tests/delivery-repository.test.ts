import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeBridgeDatabase,
  openBridgeDatabase,
  type BridgeDatabase,
} from '../src/infrastructure/database/database.js';
import {
  computeRetryDelayMs,
  DeliveryRepository,
  type DeliveryDestination,
} from '../src/infrastructure/database/delivery-repository.js';

function withRepository(
  run: (
    repository: DeliveryRepository,
    databasePath: string,
    db: BridgeDatabase,
  ) => void,
): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-delivery-'));
  const databasePath = path.join(directory, 'bridge.db');
  const db = openBridgeDatabase(databasePath);
  try {
    run(new DeliveryRepository(db), databasePath, db);
  } finally {
    closeBridgeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  }
}

function enqueue(
  repository: DeliveryRepository,
  sourceEventKey: string,
  conversationKey: string,
  receivedAt = 100,
  destination: DeliveryDestination = 'zalo',
) {
  return repository.ingestAndEnqueue({
    source: destination === 'zalo' ? 'telegram' : 'zalo',
    sourceEventKey,
    conversationKey,
    eventType: 'message',
    payload: { text: sourceEventKey },
    destination,
    receivedAt,
  });
}

test('ingest and enqueue is transactional and idempotent', () => {
  withRepository(repository => {
    const first = enqueue(repository, 'update:1', 'friend:1');
    const duplicate = enqueue(repository, 'update:1', 'friend:1', 999);
    const second = enqueue(repository, 'update:2', 'friend:1', 101);

    assert.equal(first.deduplicated, false);
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.inboxEventId, first.inboxEventId);
    assert.equal(duplicate.delivery.id, first.delivery.id);
    assert.equal(first.delivery.sequenceNo, 1);
    assert.equal(second.delivery.sequenceNo, 2);
    assert.deepEqual(first.delivery.payload, { text: 'update:1' });
  });
});

test('leaseNext preserves FIFO within one conversation', () => {
  withRepository(repository => {
    const first = enqueue(repository, 'update:1', 'friend:1', 100);
    const second = enqueue(repository, 'update:2', 'friend:1', 101);

    const leasedFirst = repository.leaseNext('zalo', 'worker-a', 110, 50);
    assert.equal(leasedFirst?.id, first.delivery.id);
    assert.equal(leasedFirst?.attempts, 1);
    assert.equal(repository.leaseNext('zalo', 'worker-b', 110, 50), undefined);

    repository.markSent(first.delivery.id, 'worker-a', 111, 'zalo-message-1');
    const leasedSecond = repository.leaseNext('zalo', 'worker-b', 112, 50);
    assert.equal(leasedSecond?.id, second.delivery.id);
  });
});

test('leaseNext allows concurrency between conversations', () => {
  withRepository(repository => {
    const first = enqueue(repository, 'update:a', 'friend:a', 100);
    const second = enqueue(repository, 'update:b', 'friend:b', 100);

    const leaseA = repository.leaseNext('zalo', 'worker-a', 100, 50);
    const leaseB = repository.leaseNext('zalo', 'worker-b', 100, 50);
    assert.deepEqual(
      new Set([leaseA?.id, leaseB?.id]),
      new Set([first.delivery.id, second.delivery.id]),
    );
    assert.equal(repository.leaseNext('zalo', 'worker-c', 100, 50), undefined);
  });
});

test('expired crash lease becomes UNKNOWN until an operator explicitly retries it', () => {
  withRepository(repository => {
    const queued = enqueue(repository, 'update:crash', 'friend:crash', 100);
    const firstLease = repository.leaseNext('zalo', 'dead-worker', 100, 10);
    assert.equal(firstLease?.id, queued.delivery.id);

    assert.equal(repository.leaseNext('zalo', 'new-worker', 111, 10), undefined);
    assert.equal(repository.releaseExpired(111), 1);
    assert.equal(repository.getById(queued.delivery.id)?.status, 'UNKNOWN');
    assert.equal(repository.leaseNext('zalo', 'new-worker', 111, 10), undefined);

    repository.requeueProblem(queued.delivery.id, 112);
    const secondLease = repository.leaseNext('zalo', 'new-worker', 112, 10);
    assert.equal(secondLease?.id, queued.delivery.id);
    assert.equal(secondLease?.attempts, 2);
    assert.equal(secondLease?.lastErrorCode, 'OPERATOR_RETRY');
  });
});

test('expired lease recovery is isolated by destination worker', () => {
  withRepository(repository => {
    const toZalo = enqueue(repository, 'update:to-zalo', 'friend:zalo', 100, 'zalo');
    const toTelegram = enqueue(repository, 'update:to-telegram', 'friend:telegram', 100, 'telegram');
    repository.leaseNext('zalo', 'zalo-worker', 100, 10);
    repository.leaseNext('telegram', 'telegram-worker', 100, 10);

    assert.equal(repository.releaseExpired(111, 'zalo'), 1);
    assert.equal(repository.getById(toZalo.delivery.id)?.status, 'UNKNOWN');
    assert.equal(repository.getById(toTelegram.delivery.id)?.status, 'SENDING');

    assert.equal(repository.releaseExpired(111, 'telegram'), 1);
    assert.equal(repository.getById(toTelegram.delivery.id)?.status, 'UNKNOWN');
  });
});

test('retry, unknown, permanent failure, DLQ, and sent transitions are recorded', () => {
  withRepository((repository, _databasePath, db) => {
    const retry = enqueue(repository, 'update:retry', 'friend:retry', 100);
    repository.leaseNext('zalo', 'retry-worker', 100, 50);
    const retrying = repository.markRetry(retry.delivery.id, 'retry-worker', 101, {
      code: 'RATE_LIMIT',
      message: 'try later',
      backoff: {
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        jitterRatio: 0.2,
        random: () => 0.5,
      },
    });
    assert.equal(retrying.status, 'RETRY');
    assert.equal(retrying.nextAttemptAt, 201);
    assert.equal(repository.leaseNext('zalo', 'retry-worker', 200, 50), undefined);
    assert.equal(repository.leaseNext('zalo', 'retry-worker', 201, 50)?.id, retry.delivery.id);
    assert.equal(
      repository.markUnknown(retry.delivery.id, 'retry-worker', 202, {
        code: 'TIMEOUT',
      }).status,
      'UNKNOWN',
    );

    const permanent = enqueue(repository, 'update:permanent', 'friend:permanent', 300);
    repository.leaseNext('zalo', 'permanent-worker', 300, 50);
    db.prepare(`
      INSERT INTO media_objects(
        id, sha256, relative_path, mime_type, byte_size, status,
        expires_at, created_at, updated_at
      ) VALUES ('permanent-media', ?, 'media/objects/permanent.blob', NULL, 1, 'READY', 1000, 300, 300)
    `).run('c'.repeat(64));
    db.prepare(`
      INSERT INTO delivery_media(delivery_id, media_id, ordinal, filename)
      VALUES (?, 'permanent-media', 0, 'permanent.bin')
    `).run(permanent.delivery.id);
    assert.equal(
      repository.markPermanentFailed(
        permanent.delivery.id,
        'permanent-worker',
        301,
        { code: 'BAD_REQUEST' },
      ).status,
      'PERMANENT_FAILED',
    );
    assert.equal(db.prepare(`
      SELECT count(*) AS count FROM delivery_media WHERE delivery_id = ?
    `).get(permanent.delivery.id).count, 1);

    const dlq = enqueue(repository, 'update:dlq', 'friend:dlq', 400);
    repository.leaseNext('zalo', 'dlq-worker', 400, 50);
    assert.equal(
      repository.markDlq(dlq.delivery.id, 'dlq-worker', 401, { code: 'MAX_ATTEMPTS' }).status,
      'DLQ',
    );

    const sent = enqueue(repository, 'update:sent', 'friend:sent', 500);
    repository.leaseNext('zalo', 'sent-worker', 500, 50);
    db.prepare(`
      INSERT INTO media_objects(
        id, sha256, relative_path, mime_type, byte_size, status,
        expires_at, created_at, updated_at
      ) VALUES ('sent-media', ?, 'media/objects/sent.blob', NULL, 1, 'READY', 1000, 500, 500)
    `).run('b'.repeat(64));
    db.prepare(`
      INSERT INTO delivery_media(delivery_id, media_id, ordinal, filename)
      VALUES (?, 'sent-media', 0, 'sent.bin')
    `).run(sent.delivery.id);
    const completed = repository.markSent(sent.delivery.id, 'sent-worker', 501, 'provider:1');
    assert.equal(completed.status, 'SENT');
    assert.equal(completed.providerMessageId, 'provider:1');
    assert.equal(completed.leaseOwner, null);
    assert.equal(db.prepare(`
      SELECT count(*) AS count FROM delivery_media WHERE delivery_id = ?
    `).get(sent.delivery.id).count, 0);

    const skipped = enqueue(repository, 'update:skipped', 'friend:skipped', 600);
    repository.leaseNext('zalo', 'skip-worker', 600, 50);
    const policySkipped = repository.markSkipped(
      skipped.delivery.id,
      'skip-worker',
      601,
      {
        code: 'SKIPPED_STRANGER_DM',
        message: 'Skipped by configured policy.',
      },
    );
    assert.equal(policySkipped.status, 'SKIPPED');
    assert.equal(policySkipped.providerMessageId, null);
    assert.equal(policySkipped.lastErrorCode, null);
    assert.equal(policySkipped.lastErrorMessage, null);
    assert.deepEqual(repository.listAttempts(skipped.delivery.id).map(attempt => ({
      outcome: attempt.outcome,
      errorCode: attempt.errorCode,
    })), [{
      outcome: 'SKIPPED',
      errorCode: null,
    }]);
    assert.deepEqual(repository.getSkipAudit(skipped.delivery.id), {
      deliveryId: skipped.delivery.id,
      attemptNo: 1,
      reasonCode: 'SKIPPED_STRANGER_DM',
      reason: 'Skipped by configured policy.',
      createdAt: 601,
    });
  });
});

test('retry helper applies exponential backoff, cap, and deterministic jitter', () => {
  assert.equal(computeRetryDelayMs(1, {
    baseDelayMs: 100,
    maxDelayMs: 500,
    jitterRatio: 0.2,
    random: () => 0.5,
  }), 100);
  assert.equal(computeRetryDelayMs(4, {
    baseDelayMs: 100,
    maxDelayMs: 500,
    jitterRatio: 0.2,
    random: () => 0,
  }), 400);
});

test('provider receipts survive UNKNOWN recovery and prevent blind auto-retry', () => {
  withRepository((repository, _databasePath) => {
    const queued = enqueue(repository, 'update:receipt-crash', 'friend:receipt-crash', 100);
    const leased = repository.leaseNext('zalo', 'receipt-worker', 100, 50);
    assert.equal(leased?.id, queued.delivery.id);

    const receipt = repository.recordProviderReceipt(
      queued.delivery.id,
      'receipt-worker',
      101,
      {
        provider: 'zalo',
        providerMessageId: 'zalo-message-99',
        receiptKind: 'primary',
        providerConversationId: 'friend:receipt-crash',
      },
    );
    assert.equal(receipt.attemptNo, 1);
    assert.equal(repository.getById(queued.delivery.id)?.status, 'SENDING');
    assert.equal(
      repository.getById(queued.delivery.id)?.providerMessageId,
      'zalo-message-99',
    );
    assert.throws(
      () => repository.markRetry(
        queued.delivery.id,
        'receipt-worker',
        102,
        { code: 'EAGAIN' },
      ),
      /has provider receipts and cannot auto-retry/,
    );

    assert.equal(repository.releaseExpired(151, 'zalo'), 1);
    const recovered = repository.getById(queued.delivery.id);
    assert.equal(recovered?.status, 'UNKNOWN');
    assert.equal(recovered?.providerMessageId, 'zalo-message-99');
    assert.equal(repository.listProviderReceipts(queued.delivery.id).length, 1);
    assert.equal(
      repository.listAttempts(queued.delivery.id)[0]?.providerMessageId,
      'zalo-message-99',
    );
  });
});

test('markSent preserves an immediately persisted primary provider receipt', () => {
  withRepository((repository, _databasePath) => {
    const queued = enqueue(repository, 'update:receipt-sent', 'friend:receipt-sent', 200);
    repository.leaseNext('zalo', 'receipt-worker', 200, 50);
    repository.recordProviderReceipt(
      queued.delivery.id,
      'receipt-worker',
      201,
      {
        provider: 'zalo',
        providerMessageId: 'zalo-message-100',
      },
    );
    const sent = repository.markSent(
      queued.delivery.id,
      'receipt-worker',
      202,
    );
    assert.equal(sent.status, 'SENT');
    assert.equal(sent.providerMessageId, 'zalo-message-100');
    assert.equal(
      repository.listAttempts(queued.delivery.id)[0]?.providerMessageId,
      'zalo-message-100',
    );
  });
});

test('SKIPPED is terminal and releases FIFO for the next conversation delivery', () => {
  withRepository((repository, _databasePath) => {
    const first = enqueue(repository, 'update:skip-first', 'friend:skip-fifo', 300);
    const second = enqueue(repository, 'update:skip-second', 'friend:skip-fifo', 301);
    repository.leaseNext('zalo', 'skip-worker', 300, 50);
    repository.markSkipped(first.delivery.id, 'skip-worker', 302, {
      code: 'SKIPPED_DUPLICATE_SOURCE',
      message: 'Already delivered.',
    });
    assert.equal(
      repository.leaseNext('zalo', 'next-worker', 302, 50)?.id,
      second.delivery.id,
    );
  });
});

test('retention purges only old SENT and SKIPPED deliveries', () => {
  withRepository((repository, _databasePath, db) => {
    const oldSent = enqueue(repository, 'update:purge-sent', 'friend:purge-sent', 100);
    repository.leaseNext('zalo', 'purge-worker', 100, 50);
    repository.markSent(oldSent.delivery.id, 'purge-worker', 101, 'provider-old');

    const oldSkipped = enqueue(repository, 'update:purge-skip', 'friend:purge-skip', 200);
    repository.leaseNext('zalo', 'purge-worker', 200, 50);
    repository.markSkipped(oldSkipped.delivery.id, 'purge-worker', 201, {
      code: 'SKIPPED_DUPLICATE_SOURCE',
      message: 'duplicate',
    });

    const unresolved = enqueue(repository, 'update:purge-unknown', 'friend:purge-unknown', 300);
    repository.leaseNext('zalo', 'purge-worker', 300, 50);
    repository.markUnknown(unresolved.delivery.id, 'purge-worker', 301, {
      code: 'ETIMEDOUT',
    });

    const recentSent = enqueue(repository, 'update:purge-recent', 'friend:purge-recent', 900);
    repository.leaseNext('zalo', 'purge-worker', 900, 50);
    repository.markSent(recentSent.delivery.id, 'purge-worker', 901, 'provider-new');

    assert.deepEqual(repository.purgeTerminalBefore(500), {
      deliveriesDeleted: 2,
      inboxEventsDeleted: 2,
    });
    assert.equal(repository.getById(oldSent.delivery.id), undefined);
    assert.equal(repository.getById(oldSkipped.delivery.id), undefined);
    assert.equal(repository.getById(unresolved.delivery.id)?.status, 'UNKNOWN');
    assert.equal(repository.getById(recentSent.delivery.id)?.status, 'SENT');
    assert.equal(
      (db.prepare('SELECT count(*) AS count FROM inbox_events').get() as { count: number }).count,
      2,
    );
  });
});

test('operator can inspect and resolve UNKNOWN without leaving FIFO blocked forever', () => {
  withRepository((repository, _databasePath, db) => {
    const first = enqueue(repository, 'update:unknown-operator', 'friend:operator', 100);
    const second = enqueue(repository, 'update:after-unknown', 'friend:operator', 101);
    repository.leaseNext('zalo', 'worker', 100, 50);
    repository.markUnknown(first.delivery.id, 'worker', 101, { code: 'TIMEOUT' });

    assert.equal(repository.leaseNext('zalo', 'worker', 102, 50), undefined);
    assert.equal(repository.listProblems()[0]?.id, first.delivery.id);
    assert.equal(repository.problemCount(), 1);
    assert.equal(repository.statusCounts().find(row => row.status === 'UNKNOWN')?.count, 1);

    db.prepare(`
      INSERT INTO media_objects(
        id, sha256, relative_path, mime_type, byte_size, status,
        expires_at, created_at, updated_at
      ) VALUES ('operator-media', ?, 'media/objects/operator.blob', NULL, 1, 'READY', 1000, 100, 100)
    `).run('a'.repeat(64));
    db.prepare(`
      INSERT INTO delivery_media(delivery_id, media_id, ordinal, filename)
      VALUES (?, 'operator-media', 0, 'operator.bin')
    `).run(first.delivery.id);

    repository.resolveProblemAsSent(first.delivery.id, 103, {
      actorTelegramUserId: 123456,
      reason: 'Confirmed at destination',
    });
    assert.deepEqual(repository.listOperatorActions(first.delivery.id), [{
      action: 'sent',
      previousStatus: 'UNKNOWN',
      actorTelegramUserId: 123456,
      reason: 'Confirmed at destination',
      createdAt: 103,
    }]);
    assert.equal(repository.listAttempts(first.delivery.id)[0]?.outcome, 'UNKNOWN');
    assert.equal(db.prepare(`
      SELECT count(*) AS count FROM delivery_media WHERE delivery_id = ?
    `).get(first.delivery.id).count, 0);
    assert.equal(repository.leaseNext('zalo', 'worker', 104, 50)?.id, second.delivery.id);
  });
});
