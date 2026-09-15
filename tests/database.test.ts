import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeBridgeDatabase, openBridgeDatabase, verifyDatabase } from '../src/infrastructure/database/database.js';
import { migrations } from '../src/infrastructure/database/migrations/index.js';

test('database enables WAL and applies all migrations idempotently', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-db-'));
  const databasePath = path.join(directory, 'bridge.db');
  try {
    let db = openBridgeDatabase(databasePath);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, 8);
    assert.ok(
      (db.pragma('table_info(topic_links)') as Array<{ name: string }>)
        .some(column => column.name === 'name_source'),
    );
    verifyDatabase(db);
    closeBridgeDatabase(db);

    db = openBridgeDatabase(databasePath);
    assert.equal(db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, 8);
    closeBridgeDatabase(db);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('current migrations preserve v5 deliveries, attempts, media, and operator actions', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-db-v5-upgrade-'));
  const databasePath = path.join(directory, 'bridge.db');
  try {
    const legacy = new Database(databasePath);
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version     INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        checksum    TEXT NOT NULL,
        applied_at  INTEGER NOT NULL
      );
    `);
    const insertMigration = legacy.prepare(`
      INSERT INTO schema_migrations(version, name, checksum, applied_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const migration of migrations.filter(item => item.version <= 5)) {
      legacy.transaction(() => {
        legacy.exec(migration.sql);
        const checksum = createHash('sha256')
          .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
          .digest('hex');
        insertMigration.run(migration.version, migration.name, checksum, migration.version);
      })();
    }

    legacy.prepare(`
      INSERT INTO inbox_events(
        id, source, source_event_key, conversation_key,
        event_type, payload_json, received_at
      ) VALUES ('inbox-v5', 'zalo', 'event-v5', '0:friend-v5', 'text', '{}', 10)
    `).run();
    legacy.prepare(`
      INSERT INTO deliveries(
        id, inbox_event_id, destination, conversation_key, sequence_no,
        status, attempts, next_attempt_at, provider_message_id,
        last_error_code, last_error_message, created_at, updated_at
      ) VALUES (
        'delivery-v5', 'inbox-v5', 'telegram', '0:friend-v5', 1,
        'UNKNOWN', 1, 20, 'telegram-55',
        'ETIMEDOUT', 'ambiguous', 10, 20
      )
    `).run();
    legacy.prepare(`
      INSERT INTO delivery_attempts(
        id, delivery_id, attempt_no, started_at, finished_at,
        outcome, provider_message_id, error_code, error_message
      ) VALUES (
        7, 'delivery-v5', 1, 10, 20,
        'UNKNOWN', 'telegram-55', 'ETIMEDOUT', 'ambiguous'
      )
    `).run();
    legacy.prepare(`
      INSERT INTO media_objects(
        id, sha256, relative_path, byte_size, status,
        expires_at, created_at, updated_at
      ) VALUES (
        'media-v5', ?, 'media/objects/v5.blob', 1, 'READY',
        1000, 10, 10
      )
    `).run('a'.repeat(64));
    legacy.prepare(`
      INSERT INTO delivery_media(delivery_id, media_id, ordinal, filename)
      VALUES ('delivery-v5', 'media-v5', 0, 'v5.bin')
    `).run();
    legacy.prepare(`
      INSERT INTO delivery_operator_actions(
        id, delivery_id, actor_telegram_user_id, action,
        previous_status, reason, created_at
      ) VALUES (
        9, 'delivery-v5', 123, 'retry',
        'UNKNOWN', 'v5 action', 21
      )
    `).run();
    legacy.prepare(`
      INSERT INTO topic_links(
        telegram_chat_id, telegram_topic_id, zalo_thread_id,
        thread_type, name, source, updated_at
      ) VALUES (-1001, 77, 'group-v5', 1, 'Legacy group', 'runtime', 21)
    `).run();
    legacy.close();

    const upgraded = openBridgeDatabase(databasePath);
    assert.equal(
      upgraded.prepare('SELECT count(*) AS count FROM schema_migrations').get().count,
      8,
    );
    assert.equal(
      upgraded.prepare(`SELECT status FROM deliveries WHERE id = 'delivery-v5'`).get().status,
      'UNKNOWN',
    );
    assert.equal(
      upgraded.prepare(`SELECT count(*) AS count FROM delivery_attempts WHERE delivery_id = 'delivery-v5'`).get().count,
      1,
    );
    assert.equal(
      upgraded.prepare(`SELECT count(*) AS count FROM delivery_media WHERE delivery_id = 'delivery-v5'`).get().count,
      1,
    );
    assert.equal(
      upgraded.prepare(`SELECT count(*) AS count FROM delivery_operator_actions WHERE delivery_id = 'delivery-v5'`).get().count,
      1,
    );
    assert.equal(
      upgraded.prepare(`SELECT count(*) AS count FROM delivery_receipts`).get().count,
      0,
    );
    assert.equal(
      upgraded.prepare(`SELECT name_source FROM topic_links WHERE zalo_thread_id = 'group-v5'`).get().name_source,
      'legacy',
    );
    verifyDatabase(upgraded);
    closeBridgeDatabase(upgraded);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('schema rejects sentinel aliases and duplicate inbox events', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-db-'));
  const databasePath = path.join(directory, 'bridge.db');
  const db = openBridgeDatabase(databasePath);
  try {
    const now = Date.now();
    const link = db.prepare(`
      INSERT INTO message_links(
        telegram_chat_id, telegram_message_id, conversation_key, direction, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(-100, 1, '0:friend', 'zalo_to_telegram', 'test', now);
    assert.throws(() => db.prepare(`
      INSERT INTO message_aliases(conversation_key, alias, message_link_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run('0:friend', '0', link.lastInsertRowid, now));

    const insertInbox = db.prepare(`
      INSERT INTO inbox_events(id, source, source_event_key, conversation_key, event_type, payload_json, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertInbox.run('one', 'telegram', 'update:1', '0:friend', 'message', '{}', now);
    assert.throws(() => insertInbox.run('two', 'telegram', 'update:1', '0:friend', 'message', '{}', now));
  } finally {
    closeBridgeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  }
});
