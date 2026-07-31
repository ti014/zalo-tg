import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('hydration clears compatibility shadows when the current Telegram chat has no rows', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-hydrate-empty-'));
  process.env.TG_TOKEN = 'test-token';
  process.env.TG_GROUP_ID = '-2002';
  process.env.TG_OWNER_IDS = '1';
  process.env.DATA_DIR = directory;
  process.env.DATABASE_PATH = path.join(directory, 'bridge.db');
  writeFileSync(path.join(directory, 'topics.json'), JSON.stringify({
    topics: { 99: { topicId: 99, zaloId: 'stale', type: 1, name: 'Stale topic' } },
    zaloIndex: { '1:stale': 99 },
  }));
  writeFileSync(path.join(directory, 'msg-map.json'), JSON.stringify({
    pairs: [['stale-message', 88]],
    quotes: [[88, {
      msgId: 'stale-message', uidFrom: 'stale', ts: '1', msgType: 'chat.text',
      content: 'stale', ttl: 0, zaloId: 'stale', threadType: 1,
    }]],
    sent: [],
  }));

  const { openBridgeDatabase, closeBridgeDatabase } = await import('../src/infrastructure/database/database.js');
  const { hydrateCompatibilityStores } = await import('../src/bootstrap/hydrate-stores.js');
  const { configureSqliteShadow, disableSqliteShadow } = await import('../src/infrastructure/database/shadow-state.js');
  const { msgStore, store } = await import('../src/store/index.js');
  const db = openBridgeDatabase(path.join(directory, 'bridge.db'));
  configureSqliteShadow(db, -2002);
  try {
    const result = hydrateCompatibilityStores(db, -2002);
    assert.equal(result.topics, 0);
    assert.equal(result.incomingMessageLinks, 0);
    assert.deepEqual(store.all(), []);
    assert.equal(msgStore.getTgMsgId('stale-message'), undefined);
    assert.deepEqual(JSON.parse(readFileSync(path.join(directory, 'topics.json'), 'utf8')).topics, {});
    assert.deepEqual(JSON.parse(readFileSync(path.join(directory, 'msg-map.json'), 'utf8')), {
      pairs: [], quotes: [], sent: [],
    });
  } finally {
    disableSqliteShadow();
    closeBridgeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  }
});
