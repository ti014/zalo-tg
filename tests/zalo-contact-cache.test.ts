import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.TG_TOKEN ??= 'test-token';
process.env.TG_GROUP_ID ??= '-1001234567890';
process.env.TG_OWNER_IDS ??= '123456789';
process.env.DATA_DIR ??= path.join(os.tmpdir(), `zalo-tg-contact-cache-${process.pid}`);

const { loadZaloAddressBook } = await import('../src/zalo/handler.js');
const {
  resolveUserDisplayName,
  summarizeGroupMemberList,
} = await import('../src/zalo/helpers.js');
const { friendsCache } = await import('../src/store/users.js');
const { shouldReplaceStoredName } = await import('../src/zalo/topic.js');

test('friend contacts still load when the explicit alias endpoint fails', async () => {
  const api = {
    getAliasList: async () => { throw new Error('alias endpoint unavailable'); },
    getAllFriends: async () => [{ userId: 'friend-42', displayName: 'Tên trong danh bạ' }],
    getUserInfo: async () => { throw new Error('profile lookup must not run'); },
  };
  const result = await loadZaloAddressBook(api as never);
  assert.deepEqual(result, { aliases: 0, friends: 1 });
  assert.equal(friendsCache.get('friend-42')?.displayName, 'Tên trong danh bạ');
  assert.equal(
    await resolveUserDisplayName(api as never, 'friend-42', 'Tên công khai'),
    'Tên trong danh bạ',
  );
});

test('group member summary reports hidden or incomplete member lists', () => {
  assert.deepEqual(summarizeGroupMemberList({
    memVerList: ['u1_0', 'u2_1', 'u1_2'],
    currentMems: [{ id: 'u3_0' }],
    totalMember: 5,
    hasMoreMember: 1,
  }), {
    memberIds: ['u1', 'u2', 'u3'],
    totalMember: 5,
    incomplete: true,
  });
  assert.deepEqual(summarizeGroupMemberList({
    memVerList: ['u1_0'],
    currentMems: [],
    totalMember: 1,
    hasMoreMember: 0,
  }), {
    memberIds: ['u1'],
    totalMember: 1,
    incomplete: false,
  });
});

test('DM topics follow changed contact names while group topics only replace placeholders', () => {
  assert.equal(shouldReplaceStoredName('Tên cũ', 'Tên danh bạ mới', 'u1', 0), true);
  assert.equal(shouldReplaceStoredName('Nhóm ổn định', 'Tên khác', 'g1', 1), false);
  assert.equal(shouldReplaceStoredName('g1', 'Nhóm chính thức', 'g1', 1), true);
  assert.equal(
    shouldReplaceStoredName(
      'Tên người gửi',
      'Nhóm chính thức',
      'g1',
      1,
      'legacy',
      'group_info',
    ),
    true,
  );
  assert.equal(
    shouldReplaceStoredName(
      'Nhóm chính thức',
      'Nhóm Zalo g1',
      'g1',
      1,
      'group_info',
      'placeholder',
    ),
    false,
  );
});
