import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.TG_TOKEN ??= 'test-token';
process.env.TG_GROUP_ID ??= '-1001234567890';
process.env.TG_OWNER_IDS ??= '123456789';
process.env.DATA_DIR ??= path.join(os.tmpdir(), `zalo-tg-admin-${process.pid}`);

const {
  renderAdminCache,
  renderAdminLookupHelp,
  renderAdminMapping,
} = await import('../src/telegram/commands/admin.js');
const { sentMsgStore } = await import('../src/store/messages.js');

test('admin cache rendering includes durable states and escapes provider values', () => {
  const text = renderAdminCache({
    topics: { topics: 3, groups: 2, directMessages: 1 },
    incoming: { aliases: 8, quotes: 5, maxAliases: 2_000 },
    sent: { entries: 4, aliases: 6, maxEntries: 300 },
    users: { users: 7, groups: 2, maxUsers: 500 },
    aliases: 3,
    friends: 9,
    groups: 4,
    reactionSummaries: 2,
    reactionDedupe: 1,
    deliveries: [{ status: '<UNKNOWN>', count: 2 }],
  });
  assert.match(text, /3/);
  assert.match(text, /&lt;UNKNOWN&gt;=2/);
  assert.match(text, /durable queue/i);
});

test('admin mapping and lookup help are explicit when no mapping exists', () => {
  const mapping = renderAdminMapping(987654321);
  assert.match(mapping, /987654321/);
  assert.match(mapping, /không tìm thấy/);
  assert.match(renderAdminLookupHelp(), /\/admin lookup/);
});

test('admin mapping renders every provider message ID for album and chunk sends', () => {
  sentMsgStore.save(7654321, {
    msgId: 'provider-1',
    msgIds: ['provider-1', 'provider-2', 'provider-3'],
    cliMsgId: 'client-1',
    zaloId: 'conversation-1',
    threadType: 1,
  });
  const mapping = renderAdminMapping(7654321);
  assert.match(mapping, /provider-1/);
  assert.match(mapping, /provider-2/);
  assert.match(mapping, /provider-3/);
});
