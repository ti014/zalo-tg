import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeBridgeDatabase,
  openBridgeDatabase,
} from '../src/infrastructure/database/database.js';
import { importLegacyState } from '../src/infrastructure/database/legacy-import.js';

function fileSha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

test('legacy importer imports valid state, quarantines sentinel aliases, and is idempotent', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-legacy-import-'));
  const dataDir = path.join(directory, 'data');
  const databasePath = path.join(directory, 'bridge.db');
  const topicsPath = path.join(dataDir, 'topics.json');
  const settingsPath = path.join(dataDir, 'settings.json');
  const messageMapPath = path.join(dataDir, 'msg-map.json');

  const topics = {
    topics: {
      101: {
        topicId: 101,
        zaloId: 'group-1',
        type: 1,
        name: 'Nhóm kiểm thử',
      },
    },
    zaloIndex: { '1:group-1': 101 },
  };
  const settings = {
    telegramUi: {
      compactMode: false,
      statusDetails: true,
      topicActions: true,
    },
  };
  const quote = {
    msgId: 'incoming-1',
    cliMsgId: 'incoming-cli-1',
    uidFrom: 'sender-1',
    ts: '123456',
    msgType: 'chat.text',
    content: 'Nội dung hợp lệ',
    ttl: 0,
    zaloId: 'group-1',
    threadType: 1,
  };
  const messageMap = {
    pairs: [
      ['incoming-1', 501],
      ['0', 501],
      [' incoming-1 ', 501],
    ],
    quotes: [[501, quote]],
    sent: [[
      601,
      {
        msgId: 'outgoing-1',
        cliMsgId: '0',
        zaloId: 'user-1',
        threadType: 0,
      },
    ]],
  };

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(topicsPath, JSON.stringify(topics, null, 2), 'utf8');
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  writeFileSync(messageMapPath, JSON.stringify(messageMap, null, 2), 'utf8');
  const sourceHashes = new Map([
    [topicsPath, fileSha256(topicsPath)],
    [settingsPath, fileSha256(settingsPath)],
    [messageMapPath, fileSha256(messageMapPath)],
  ]);

  const db = openBridgeDatabase(databasePath);
  try {
    const first = importLegacyState(db, dataDir, -100123);
    assert.deepEqual(first.files.map(file => file.status), [
      'imported',
      'imported',
      'imported',
    ]);

    const topic = db.prepare(`
      SELECT telegram_topic_id, zalo_thread_id, thread_type, name, source
      FROM topic_links
      WHERE telegram_chat_id = ?
    `).get(-100123) as Record<string, unknown>;
    assert.deepEqual(topic, {
      telegram_topic_id: 101,
      zalo_thread_id: 'group-1',
      thread_type: 1,
      name: 'Nhóm kiểm thử',
      source: 'legacy',
    });

    const appSettings = db.prepare(`
      SELECT value_json
      FROM app_settings
      WHERE key = 'app'
    `).get() as { value_json: string };
    assert.deepEqual(JSON.parse(appSettings.value_json), settings);

    const links = db.prepare(`
      SELECT telegram_message_id, conversation_key, direction, source
      FROM message_links
      ORDER BY telegram_message_id
    `).all();
    assert.deepEqual(links, [
      {
        telegram_message_id: 501,
        conversation_key: '1:group-1',
        direction: 'zalo_to_telegram',
        source: 'legacy',
      },
      {
        telegram_message_id: 601,
        conversation_key: '0:user-1',
        direction: 'telegram_to_zalo',
        source: 'legacy',
      },
    ]);

    const aliases = db.prepare(`
      SELECT conversation_key, alias
      FROM message_aliases
      ORDER BY conversation_key, alias
    `).all();
    assert.deepEqual(aliases, [
      { conversation_key: '0:user-1', alias: 'outgoing-1' },
      { conversation_key: '1:group-1', alias: 'incoming-1' },
    ]);
    assert.equal(
      db.prepare(`SELECT count(*) AS count FROM message_aliases WHERE alias = '0'`).get().count,
      0,
    );

    const quarantineBefore = Number(
      db.prepare('SELECT count(*) AS count FROM migration_quarantine').get().count,
    );
    assert.ok(quarantineBefore >= 2);
    assert.equal(
      db.prepare(`
        SELECT count(*) AS count
        FROM migration_quarantine
        WHERE reason = 'invalid_message_alias'
      `).get().count,
      2,
    );

    const second = importLegacyState(db, dataDir, -100123);
    assert.deepEqual(second.files.map(file => file.status), [
      'skipped',
      'skipped',
      'skipped',
    ]);
    assert.equal(db.prepare('SELECT count(*) AS count FROM legacy_imports').get().count, 3);
    assert.equal(
      db.prepare('SELECT count(*) AS count FROM migration_quarantine').get().count,
      quarantineBefore,
    );
    assert.equal(db.prepare('SELECT count(*) AS count FROM topic_links').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM message_links').get().count, 2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM message_aliases').get().count, 2);

    topics.topics[202] = {
      topicId: 202,
      zaloId: 'group-after-migration',
      type: 1,
      name: 'Không được import lại',
    };
    writeFileSync(topicsPath, JSON.stringify(topics, null, 2), 'utf8');
    const changedShadow = importLegacyState(db, dataDir, -100123);
    assert.deepEqual(changedShadow.files.map(file => file.status), [
      'skipped',
      'skipped',
      'skipped',
    ]);
    assert.equal(db.prepare('SELECT count(*) AS count FROM topic_links').get().count, 1);

    for (const [filePath, hash] of sourceHashes) {
      if (filePath === topicsPath) continue;
      assert.equal(fileSha256(filePath), hash);
    }
  } finally {
    closeBridgeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy importer does not replay a compatibility shadow after DATA_DIR changes', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-legacy-moved-'));
  const firstDataDir = path.join(directory, 'first-data');
  const movedDataDir = path.join(directory, 'moved-data');
  const databasePath = path.join(directory, 'bridge.db');
  const document = {
    topics: {
      101: { topicId: 101, zaloId: 'old-group', type: 1, name: 'Old group' },
    },
    zaloIndex: { '1:old-group': 101 },
  };
  mkdirSync(firstDataDir, { recursive: true });
  mkdirSync(movedDataDir, { recursive: true });
  writeFileSync(path.join(firstDataDir, 'topics.json'), JSON.stringify(document), 'utf8');
  writeFileSync(path.join(movedDataDir, 'topics.json'), JSON.stringify(document), 'utf8');

  const db = openBridgeDatabase(databasePath);
  try {
    const first = importLegacyState(db, firstDataDir, -1001);
    const moved = importLegacyState(db, movedDataDir, -2002);

    assert.equal(first.files[0]?.status, 'imported');
    assert.equal(moved.files[0]?.status, 'skipped');
    assert.equal(
      db.prepare('SELECT count(*) AS count FROM topic_links WHERE telegram_chat_id = ?')
        .get(-1001).count,
      1,
    );
    assert.equal(
      db.prepare('SELECT count(*) AS count FROM topic_links WHERE telegram_chat_id = ?')
        .get(-2002).count,
      0,
    );
  } finally {
    closeBridgeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  }
});
