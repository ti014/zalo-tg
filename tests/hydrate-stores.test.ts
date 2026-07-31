import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeBridgeDatabase,
  openBridgeDatabase,
} from '../src/infrastructure/database/database.js';

test('SQLite hydration preserves durable message history beyond bounded compatibility caches', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-hydrate-history-'));
  process.env.TG_TOKEN = 'test-token';
  process.env.TG_GROUP_ID = '-1001';
  process.env.TG_OWNER_IDS = '1';
  process.env.DATA_DIR = directory;
  process.env.DATABASE_PATH = path.join(directory, 'bridge.db');

  const { hydrateCompatibilityStores } = await import('../src/bootstrap/hydrate-stores.js');
  const {
    configureSqliteShadow,
    disableSqliteShadow,
    lookupShadowIncomingTelegramId,
  } = await import('../src/infrastructure/database/shadow-state.js');

  const db = openBridgeDatabase(path.join(directory, 'bridge.db'));
  configureSqliteShadow(db, -1001);
  try {
    const insertLink = db.prepare(`
      INSERT INTO message_links(
        telegram_chat_id, telegram_message_id, conversation_key, direction,
        quote_json, source, created_at
      ) VALUES (?, ?, '0:user-a', 'zalo_to_telegram', ?, 'runtime', ?)
    `);
    const insertAlias = db.prepare(`
      INSERT INTO message_aliases(
        conversation_key, alias, alias_kind, message_link_id, created_at
      ) VALUES ('0:user-a', ?, 'msg_id', ?, ?)
    `);
    db.transaction(() => {
      for (let index = 0; index < 2_105; index += 1) {
        const telegramMessageId = index + 10;
        const alias = `zalo-${index}`;
        const quote = {
          msgId: alias,
          cliMsgId: '',
          uidFrom: 'user-a',
          ts: String(index),
          msgType: 'chat.text',
          content: `message-${index}`,
          ttl: 0,
          zaloId: 'user-a',
          threadType: 0,
        };
        const inserted = insertLink.run(-1001, telegramMessageId, JSON.stringify(quote), index);
        insertAlias.run(alias, Number(inserted.lastInsertRowid), index);
      }
    }).immediate();

    const hydration = hydrateCompatibilityStores(db, -1001);

    assert.equal(hydration.incomingMessageLinks, 2_105);
    assert.equal(
      db.prepare('SELECT count(*) AS count FROM message_links').get().count,
      2_105,
    );
    assert.equal(
      db.prepare('SELECT count(*) AS count FROM message_aliases').get().count,
      2_105,
    );
    assert.equal(lookupShadowIncomingTelegramId('zalo-0'), 10);
  } finally {
    disableSqliteShadow();
    closeBridgeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  }
});
