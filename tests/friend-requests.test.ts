import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.TG_TOKEN ??= 'test-token';
process.env.TG_GROUP_ID ??= '-1001234567890';
process.env.TG_OWNER_IDS ??= '123456789';
process.env.DATA_DIR ??= path.join(os.tmpdir(), `zalo-tg-friend-requests-${process.pid}`);

const {
  normalizeFriendRequestItems,
  renderFriendRequestPage,
} = await import('../src/telegram/commands/friendrequests.js');

test('friend requests normalize PC-App payloads and retain sent-map user IDs', () => {
  const items = normalizeFriendRequestItems(
    {
      'sent-1': {
        displayName: 'Sent <User>',
        fReqInfo: { message: 'hello' },
      },
    },
    [
      {
        dataInfo: {
          recommType: 2,
          userId: 'received-1',
          displayName: 'Received & User',
          recommInfo: { message: '<script>' },
        },
      },
      { recommType: 1, userId: 'not-a-request', displayName: 'Ignored' },
    ],
    [{
      groupInfo: { groupId: 'group-1', name: 'Group', totalMember: 12 },
      inviterInfo: { dName: 'Inviter' },
      expiredTs: '1700000000',
    }],
  );

  assert.deepEqual(items.map(item => item.kind), ['received', 'sent', 'group']);
  assert.equal(items[1]?.kind === 'sent' ? items[1].userId : undefined, 'sent-1');
});

test('friend request pages escape HTML and expose accept, revoke, and navigation actions', () => {
  const items = normalizeFriendRequestItems(
    Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
      `sent-${index}`,
      { displayName: `Sent ${index}` },
    ])),
    [{ recommType: 2, userId: 'received-1', displayName: '<Alice>' }],
    [],
  );

  const first = renderFriendRequestPage(items, 0);
  assert.match(first.text, /&lt;Alice&gt;/);
  assert.equal(first.totalPages, 2);
  assert.ok(first.replyMarkup?.inline_keyboard.flat().some(button => (
    button.callback_data === 'afr:received-1'
  )));
  assert.ok(first.replyMarkup?.inline_keyboard.flat().some(button => (
    button.callback_data === 'ufr:sent-0'
  )));
  assert.ok(first.replyMarkup?.inline_keyboard.flat().some(button => (
    button.callback_data === 'frq_pg:1'
  )));

  const last = renderFriendRequestPage(items, 99);
  assert.equal(last.page, 1);
  assert.ok(last.replyMarkup?.inline_keyboard.flat().some(button => (
    button.callback_data === 'frq_pg:0'
  )));
});
