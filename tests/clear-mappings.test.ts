import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('clearBridgeMappings clears current topic/message shadows but preserves durable deliveries', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-clear-mappings-'));
  process.env.TG_TOKEN = 'test-token';
  process.env.TG_GROUP_ID = '-3003';
  process.env.TG_OWNER_IDS = '1';
  process.env.DATA_DIR = directory;
  process.env.DATABASE_PATH = path.join(directory, 'bridge.db');

  const { openBridgeDatabase, closeBridgeDatabase } = await import('../src/infrastructure/database/database.js');
  const { configureSqliteShadow, disableSqliteShadow } = await import('../src/infrastructure/database/shadow-state.js');
  const { DeliveryRepository } = await import('../src/infrastructure/database/delivery-repository.js');
  const { clearBridgeMappings } = await import('../src/application/clear-mappings.js');
  const { msgStore, store } = await import('../src/store/index.js');
  const db = openBridgeDatabase(path.join(directory, 'bridge.db'));
  configureSqliteShadow(db, -3003);
  try {
    store.set({ topicId: 11, zaloId: 'group-a', type: 1, name: 'Group A' });
    msgStore.save(22, ['zalo-message-a'], {
      msgId: 'zalo-message-a', cliMsgId: '', uidFrom: 'user-a', ts: '1',
      msgType: 'chat.text', content: 'test', ttl: 0, zaloId: 'group-a', threadType: 1,
    });
    db.prepare(`
      INSERT INTO topic_links(
        telegram_chat_id, telegram_topic_id, zalo_thread_id, thread_type,
        name, source, updated_at
      ) VALUES (-4004, 33, 'other-group', 1, 'Other group', 'runtime', 1)
    `).run();
    const otherLink = db.prepare(`
      INSERT INTO message_links(
        telegram_chat_id, telegram_message_id, conversation_key, direction,
        quote_json, source, created_at
      ) VALUES (-4004, 44, '1:other-group', 'zalo_to_telegram', '{}', 'runtime', 1)
    `).run();
    db.prepare(`
      INSERT INTO message_aliases(
        conversation_key, alias, alias_kind, message_link_id, created_at
      ) VALUES ('1:other-group', 'other-alias', 'msg_id', ?, 1)
    `).run(Number(otherLink.lastInsertRowid));
    new DeliveryRepository(db).ingestAndEnqueue({
      source: 'zalo', sourceEventKey: 'clear-test', conversationKey: '1:group-a',
      eventType: 'chat.text', payload: { test: true }, destination: 'telegram', receivedAt: 1,
    });

    assert.deepEqual(clearBridgeMappings(), { topics: 1 });
    assert.deepEqual(store.all(), []);
    assert.equal(msgStore.getTgMsgId('zalo-message-a'), undefined);
    assert.equal(
      db.prepare('SELECT count(*) AS count FROM topic_links WHERE telegram_chat_id = -3003')
        .get().count,
      0,
    );
    assert.equal(
      db.prepare('SELECT count(*) AS count FROM message_links WHERE telegram_chat_id = -3003')
        .get().count,
      0,
    );
    assert.equal(
      db.prepare('SELECT count(*) AS count FROM topic_links WHERE telegram_chat_id = -4004')
        .get().count,
      1,
    );
    assert.equal(
      db.prepare('SELECT count(*) AS count FROM message_links WHERE telegram_chat_id = -4004')
        .get().count,
      1,
    );
    assert.equal(
      db.prepare('SELECT count(*) AS count FROM message_aliases WHERE alias = ?')
        .get('other-alias').count,
      1,
    );
    assert.equal(db.prepare('SELECT count(*) AS count FROM deliveries').get().count, 1);

    disableSqliteShadow();
    assert.throws(() => clearBridgeMappings(), /mapping\.clear failed/);
  } finally {
    disableSqliteShadow();
    closeBridgeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  }
});
