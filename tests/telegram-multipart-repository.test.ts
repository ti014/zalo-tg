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
  DeliveryRepository,
  type TelegramMultipartManifestInput,
} from '../src/infrastructure/database/delivery-repository.js';

function withRepository<T>(
  run: (repository: DeliveryRepository, db: BridgeDatabase) => T,
): T {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-multipart-'));
  const db = openBridgeDatabase(path.join(directory, 'bridge.db'));
  try {
    return run(new DeliveryRepository(db), db);
  } finally {
    closeBridgeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  }
}

function enqueue(repository: DeliveryRepository, sourceEventKey: string, now: number) {
  return repository.ingestAndEnqueue({
    source: 'zalo',
    sourceEventKey,
    conversationKey: '1:zalo-group',
    eventType: 'file',
    payload: { sourceEventKey },
    destination: 'telegram',
    receivedAt: now,
  });
}

function manifest(): TelegramMultipartManifestInput {
  return {
    sourceMediaId: undefined,
    sourceSha256: 'a'.repeat(64),
    sourceByteSize: 12,
    originalFilename: 'archive.bin',
    partSizeBytes: 5,
    telegramChatId: '-100123',
    telegramThreadId: 42,
    disableNotification: true,
    replyToMessageId: 99,
    parts: [
      {
        partNo: 1,
        byteOffset: 0,
        byteSize: 5,
        sha256: '1'.repeat(64),
        providerFilename: 'archive.bin.part001',
      },
      {
        partNo: 2,
        byteOffset: 5,
        byteSize: 5,
        sha256: '2'.repeat(64),
        providerFilename: 'archive.bin.part002',
      },
      {
        partNo: 3,
        byteOffset: 10,
        byteSize: 2,
        sha256: '3'.repeat(64),
        providerFilename: 'archive.bin.part003',
      },
    ],
  };
}

test('multipart receipts resume confirmed parts without resending them', () => {
  withRepository((repository, _db) => {
    const queued = enqueue(repository, 'multipart:resume', 100);
    repository.leaseNext('telegram', 'worker-a', 100, 100);
    repository.ensureTelegramMultipartManifest(
      queued.delivery.id,
      'worker-a',
      101,
      manifest(),
    );

    repository.markTelegramMultipartPartSending(
      queued.delivery.id,
      'worker-a',
      1,
      102,
    );
    repository.recordProviderReceipt(
      queued.delivery.id,
      'worker-a',
      103,
      {
        provider: 'telegram',
        providerMessageId: '501',
        receiptKind: 'part',
        ordinal: 0,
        isPrimary: true,
      },
    );
    repository.markTelegramMultipartPartSending(
      queued.delivery.id,
      'worker-a',
      2,
      104,
    );
    repository.markTelegramMultipartPartFailure(
      queued.delivery.id,
      'worker-a',
      2,
      105,
      'UNKNOWN',
      { code: 'ETIMEDOUT', message: 'ambiguous upload' },
    );
    repository.markUnknown(
      queued.delivery.id,
      'worker-a',
      106,
      { code: 'PARTIAL_CHUNK_UPLOAD', message: '1/3 accepted' },
    );

    assert.throws(
      () => repository.requeueProblem(queued.delivery.id, 107),
      /Resolve every UNKNOWN multipart part/,
    );
    repository.resolveTelegramMultipartPart(
      queued.delivery.id,
      2,
      108,
      'sent',
      {
        actorTelegramUserId: 123,
        providerMessageId: '502',
        reason: 'Confirmed in Telegram topic.',
      },
    );
    assert.equal(repository.requeueProblem(queued.delivery.id, 109).status, 'RETRY');
    repository.leaseNext('telegram', 'worker-b', 109, 100);

    const beforeFinalPart = repository.listTelegramMultipartParts(queued.delivery.id);
    assert.deepEqual(beforeFinalPart.map(part => ({
      partNo: part.partNo,
      status: part.status,
      providerMessageId: part.providerMessageId,
    })), [
      { partNo: 1, status: 'SENT', providerMessageId: '501' },
      { partNo: 2, status: 'SENT', providerMessageId: '502' },
      { partNo: 3, status: 'PENDING', providerMessageId: null },
    ]);

    repository.markTelegramMultipartPartSending(
      queued.delivery.id,
      'worker-b',
      3,
      110,
    );
    repository.recordProviderReceipt(
      queued.delivery.id,
      'worker-b',
      111,
      {
        provider: 'telegram',
        providerMessageId: '503',
        receiptKind: 'part',
        ordinal: 2,
      },
    );
    const sent = repository.markSent(queued.delivery.id, 'worker-b', 112);
    assert.equal(sent.status, 'SENT');
    assert.equal(sent.providerMessageId, '501');
    assert.deepEqual(
      repository.listTelegramMultipartParts(queued.delivery.id)
        .map(part => part.providerMessageId),
      ['501', '502', '503'],
    );
    assert.deepEqual(
      repository.listProviderReceipts(queued.delivery.id)
        .map(receipt => [receipt.ordinal, receipt.providerMessageId]),
      [[0, '501'], [1, '502'], [2, '503']],
    );
  });
});

test('lease expiry turns only the in-flight multipart part UNKNOWN', () => {
  withRepository((repository, _db) => {
    const queued = enqueue(repository, 'multipart:crash', 200);
    repository.leaseNext('telegram', 'worker-a', 200, 50);
    repository.ensureTelegramMultipartManifest(
      queued.delivery.id,
      'worker-a',
      201,
      manifest(),
    );
    repository.markTelegramMultipartPartSending(
      queued.delivery.id,
      'worker-a',
      1,
      202,
    );

    assert.equal(repository.releaseExpired(250, 'telegram'), 1);
    assert.equal(repository.getById(queued.delivery.id)?.status, 'UNKNOWN');
    assert.deepEqual(
      repository.listTelegramMultipartParts(queued.delivery.id)
        .map(part => part.status),
      ['UNKNOWN', 'PENDING', 'PENDING'],
    );
  });
});

test('durable multipart manifest rejects config or byte-range drift', () => {
  withRepository((repository, _db) => {
    const queued = enqueue(repository, 'multipart:drift', 300);
    repository.leaseNext('telegram', 'worker-a', 300, 100);
    repository.ensureTelegramMultipartManifest(
      queued.delivery.id,
      'worker-a',
      301,
      manifest(),
    );
    const changed = manifest();
    changed.telegramThreadId = 99;
    assert.throws(
      () => repository.ensureTelegramMultipartManifest(
        queued.delivery.id,
        'worker-a',
        302,
        changed,
      ),
      (error: unknown) => (error as { code?: string }).code === 'PART_MANIFEST_MISMATCH',
    );
  });
});
