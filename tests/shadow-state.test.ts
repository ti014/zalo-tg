import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeBridgeDatabase, openBridgeDatabase } from '../src/infrastructure/database/database.js';
import {
  configureSqliteShadow,
  disableSqliteShadow,
  lookupShadowIncomingQuote,
  lookupShadowIncomingTelegramId,
  lookupShadowSentInfo,
  lookupShadowSentTelegramId,
  lookupShadowSentTelegramIdByAlias,
  shadowSentMessage,
  shadowSettingsReplace,
  shadowMessagesReplace,
  sqliteShadowErrorCount,
} from '../src/infrastructure/database/shadow-state.js';

test('message shadow replacement atomically mirrors incoming and sent mappings', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-shadow-'));
  const db = openBridgeDatabase(path.join(directory, 'bridge.db'));
  configureSqliteShadow(db, -1001);
  try {
    shadowMessagesReplace([
      {
        telegramMessageId: 10,
        aliases: ['zalo-a', '0'],
        quote: {
          msgId: 'zalo-a',
          cliMsgId: '0',
          uidFrom: 'sender',
          ts: '1',
          msgType: 'webchat',
          content: 'hello',
          ttl: 0,
          zaloId: 'group-a',
          threadType: 1,
        },
      },
    ], [
      {
        telegramMessageId: 20,
        info: { msgId: 'zalo-b', cliMsgId: '0', zaloId: 'user-b', threadType: 0 },
      },
    ]);

    assert.equal(db.prepare('SELECT count(*) AS n FROM message_links').get().n, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM message_aliases').get().n, 2);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM message_aliases WHERE alias = '0'").get().n,
      0,
    );
    assert.equal(lookupShadowSentTelegramId('user-b', 0, ['0', 'zalo-b']), 20);
    assert.equal(lookupShadowIncomingTelegramId('zalo-a'), 10);
    assert.equal(lookupShadowIncomingQuote(10)?.content, 'hello');
    assert.equal(lookupShadowSentTelegramIdByAlias('zalo-b'), 20);
    assert.deepEqual(lookupShadowSentInfo(20), {
      msgId: 'zalo-b',
      zaloId: 'user-b',
      threadType: 0,
    });

    shadowMessagesReplace([], []);
    assert.equal(db.prepare('SELECT count(*) AS n FROM message_links').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM message_aliases').get().n, 0);
  } finally {
    disableSqliteShadow();
    closeBridgeDatabase(db);
  }
});

test('shadow write failures are surfaced instead of being silently ignored', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-shadow-failure-'));
  const db = openBridgeDatabase(path.join(directory, 'bridge.db'));
  configureSqliteShadow(db, -1001);
  closeBridgeDatabase(db);
  try {
    assert.throws(
      () => shadowSettingsReplace({
        telegramUi: { compactMode: true, statusDetails: false, topicActions: true },
      }),
      error => (error as { code?: string }).code === 'SHADOW_WRITE_FAILED',
    );
    assert.equal(sqliteShadowErrorCount(), 1);
  } finally {
    disableSqliteShadow();
  }
});

test('sent shadow updates replace stale aliases and retain provider alias kinds', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-shadow-alias-update-'));
  const db = openBridgeDatabase(path.join(directory, 'bridge.db'));
  configureSqliteShadow(db, -1001);
  try {
    shadowSentMessage(20, {
      msgId: 'provisional-msg',
      cliMsgId: 'provisional-cli',
      zaloId: 'user-b',
      threadType: 0,
    });
    shadowSentMessage(20, {
      msgId: 'final-msg',
      cliMsgId: 'final-cli',
      zaloId: 'user-b',
      threadType: 0,
    });

    assert.deepEqual(db.prepare(`
      SELECT alias, alias_kind
      FROM message_aliases
      ORDER BY alias_kind
    `).all(), [
      { alias: 'final-cli', alias_kind: 'cli_msg_id' },
      { alias: 'final-msg', alias_kind: 'msg_id' },
    ]);
    assert.equal(lookupShadowSentTelegramIdByAlias('provisional-msg'), undefined);
    assert.equal(lookupShadowSentTelegramIdByAlias('final-msg'), 20);
    assert.deepEqual(lookupShadowSentInfo(20), {
      msgId: 'final-msg',
      cliMsgId: 'final-cli',
      zaloId: 'user-b',
      threadType: 0,
    });
  } finally {
    disableSqliteShadow();
    closeBridgeDatabase(db);
  }
});
