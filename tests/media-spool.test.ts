import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeBridgeDatabase,
  openBridgeDatabase,
  type BridgeDatabase,
} from '../src/infrastructure/database/database.js';
import { DeliveryRepository } from '../src/infrastructure/database/delivery-repository.js';
import {
  MediaSizeLimitError,
  MediaSpool,
  MediaSpoolCapacityError,
  type MediaSpoolOptions,
} from '../src/infrastructure/media/media-spool.js';

interface Fixture {
  directory: string;
  dataDir: string;
  db: BridgeDatabase;
  spool: MediaSpool;
}

function createFixture(options: MediaSpoolOptions = {}): Fixture {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-media-spool-'));
  const dataDir = path.join(directory, 'data');
  const db = openBridgeDatabase(path.join(dataDir, 'bridge.db'));
  let nextId = 0;
  const spool = new MediaSpool(db, dataDir, {
    createId: () => `media-${++nextId}`,
    ...options,
  });
  return { directory, dataDir, db, spool };
}

function closeFixture(fixture: Fixture): void {
  closeBridgeDatabase(fixture.db);
  rmSync(fixture.directory, { recursive: true, force: true });
}

test('stageBuffer writes atomically, hashes content, deduplicates READY media, and leaves JSON untouched', () => {
  const fixture = createFixture({ maxObjectBytes: 64, maxTotalBytes: 128 });
  try {
    const jsonPath = path.join(fixture.dataDir, 'msg-map.json');
    const jsonBefore = '{\n  "keep": true\n}\n';
    writeFileSync(jsonPath, jsonBefore, 'utf8');

    const payload = Buffer.from('durable-media');
    const first = fixture.spool.stageBuffer(payload, {
      mimeType: 'application/octet-stream',
      now: 100,
      expiresAt: 1_000,
    });

    assert.equal(first.deduplicated, false);
    assert.equal(first.media.status, 'READY');
    assert.equal(
      first.media.sha256,
      '54818b512eeb068748a6f1827b6f3fb583433b5b2d868654a9b7c18c369cee8a',
    );
    assert.equal(first.media.byteSize, payload.byteLength);
    assert.equal(readFileSync(first.media.absolutePath, 'utf8'), 'durable-media');
    assert.ok(first.media.absolutePath.startsWith(path.join(fixture.dataDir, 'media')));
    assert.deepEqual(
      readdirSync(path.dirname(first.media.absolutePath)).filter(name => name.endsWith('.tmp')),
      [],
    );

    const duplicate = fixture.spool.stageBuffer(payload, {
      mimeType: 'application/octet-stream',
      now: 200,
      expiresAt: 2_000,
    });
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.media.id, first.media.id);
    assert.equal(duplicate.media.expiresAt, 2_000);
    assert.equal(
      (fixture.db.prepare('SELECT count(*) AS count FROM media_objects').get() as { count: number }).count,
      1,
    );
    assert.equal(readFileSync(jsonPath, 'utf8'), jsonBefore);
  } finally {
    closeFixture(fixture);
  }
});

test('stageBuffer enforces per-object and total spool size limits', () => {
  const fixture = createFixture({ maxObjectBytes: 8, maxTotalBytes: 10 });
  try {
    fixture.spool.stageBuffer(Buffer.from('123456'), { now: 1, expiresAt: 100 });

    assert.throws(
      () => fixture.spool.stageBuffer(Buffer.from('abcdefghi'), { now: 2, expiresAt: 100 }),
      MediaSizeLimitError,
    );
    assert.throws(
      () => fixture.spool.stageBuffer(Buffer.from('abcde'), { now: 2, expiresAt: 100 }),
      MediaSpoolCapacityError,
    );
    assert.equal(
      (fixture.db.prepare('SELECT count(*) AS count FROM media_objects').get() as { count: number }).count,
      1,
    );
  } finally {
    closeFixture(fixture);
  }
});

test('ready-media verification detects corruption and tombstones retain capacity', () => {
  const fixture = createFixture({ maxObjectBytes: 8, maxTotalBytes: 10 });
  try {
    const staged = fixture.spool.stageBuffer(Buffer.from('123456'), {
      now: 1,
      expiresAt: 100,
    });
    assert.equal(fixture.spool.isReadyAndIntact(staged.media.id), true);

    writeFileSync(staged.media.absolutePath, '654321');
    assert.equal(fixture.spool.isReadyAndIntact(staged.media.id), false);

    fixture.db.prepare(`
      UPDATE media_objects SET status = 'DELETED', sha256 = NULL WHERE id = ?
    `).run(staged.media.id);
    assert.throws(
      () => fixture.spool.stageBuffer(Buffer.from('abcde'), { now: 2, expiresAt: 100 }),
      MediaSpoolCapacityError,
    );
  } finally {
    closeFixture(fixture);
  }
});

test('recoverStaleDownloads promotes complete files and fails incomplete reservations', () => {
  const fixture = createFixture({ maxObjectBytes: 64, maxTotalBytes: 128 });
  try {
    const complete = fixture.spool.stageBuffer(Buffer.from('complete'), {
      now: 10,
      expiresAt: 1_000,
    });
    fixture.db.prepare(`
      UPDATE media_objects SET status = 'DOWNLOADING', updated_at = 10 WHERE id = ?
    `).run(complete.media.id);
    fixture.db.prepare(`
      INSERT INTO media_objects(
        id, sha256, relative_path, mime_type, byte_size, status,
        expires_at, created_at, updated_at
      ) VALUES ('missing', ?, 'media/objects/missing.blob', NULL, 7, 'DOWNLOADING', 1000, 10, 10)
    `).run('0'.repeat(64));

    const orphanTemp = path.join(fixture.dataDir, 'media', 'objects', '.orphan.tmp');
    writeFileSync(orphanTemp, 'partial');
    utimesSync(orphanTemp, new Date(0), new Date(0));

    const recovery = fixture.spool.recoverStaleDownloads(100, 50);
    assert.deepEqual(recovery, { recovered: 1, failed: 1, orphanTempsRemoved: 1 });
    assert.equal(fixture.spool.getById(complete.media.id)?.status, 'READY');
    assert.equal(fixture.spool.getById('missing')?.status, 'FAILED');
    assert.equal(existsSync(orphanTemp), false);
  } finally {
    closeFixture(fixture);
  }
});

test('cleanupExpired deletes only media that has no delivery reference', () => {
  const fixture = createFixture({ maxObjectBytes: 64, maxTotalBytes: 128 });
  try {
    const referenced = fixture.spool.stageBuffer(Buffer.from('referenced'), {
      now: 100,
      expiresAt: 200,
    });
    const unreferenced = fixture.spool.stageBuffer(Buffer.from('unreferenced'), {
      now: 100,
      expiresAt: 200,
    });

    const delivery = new DeliveryRepository(fixture.db, (() => {
      let id = 0;
      return () => `delivery-fixture-${++id}`;
    })()).ingestAndEnqueue({
      source: 'telegram',
      sourceEventKey: 'update:1',
      conversationKey: '0:friend',
      eventType: 'message',
      payload: { text: 'file' },
      destination: 'zalo',
      receivedAt: 100,
    }).delivery;
    fixture.spool.attachToDelivery(delivery.id, referenced.media.id, 0, 'referenced.bin');

    const firstCleanup = fixture.spool.cleanupExpired(300);
    assert.deepEqual(firstCleanup, { deleted: 1, missing: 0, failed: 0 });
    assert.equal(existsSync(unreferenced.media.absolutePath), false);
    assert.equal(fixture.spool.getById(unreferenced.media.id), undefined);
    assert.equal(existsSync(referenced.media.absolutePath), true);
    assert.equal(fixture.spool.getById(referenced.media.id)?.status, 'READY');

    assert.equal(fixture.spool.detachFromDelivery(delivery.id, 0), true);
    const secondCleanup = fixture.spool.cleanupExpired(300);
    assert.deepEqual(secondCleanup, { deleted: 1, missing: 0, failed: 0 });
    assert.equal(existsSync(referenced.media.absolutePath), false);
    assert.equal(fixture.spool.getById(referenced.media.id), undefined);
  } finally {
    closeFixture(fixture);
  }
});
