import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TG_TOKEN ??= 'test-token';
process.env.TG_GROUP_ID ??= '-1001234567890';
process.env.TG_OWNER_IDS ??= '123456789';

const {
  clearZaloPolicyCaches,
  decideZaloConversationPolicy,
  isMutedZaloConversation,
} = await import('../src/zalo/conversation-policy.js');
const { friendsCache } = await import('../src/store/users.js');

test('conversation policy preserves muted and stranger messages by default', () => {
  assert.deepEqual(decideZaloConversationPolicy({
    type: 1,
    muteState: true,
    strangerState: false,
    skipMutedGroups: false,
    skipStrangerMessages: false,
  }), {
    forward: true,
    silent: true,
    strangerStateUnknown: false,
  });
  assert.deepEqual(decideZaloConversationPolicy({
    type: 0,
    muteState: true,
    strangerState: true,
    skipMutedGroups: false,
    skipStrangerMessages: false,
  }), {
    forward: true,
    silent: true,
    strangerStateUnknown: false,
  });
});

test('conversation policy only skips explicitly enabled muted groups or confirmed strangers', () => {
  assert.deepEqual(decideZaloConversationPolicy({
    type: 1,
    muteState: true,
    strangerState: false,
    skipMutedGroups: true,
    skipStrangerMessages: false,
  }), {
    forward: false,
    silent: true,
    reason: 'muted_group',
    strangerStateUnknown: false,
  });
  assert.deepEqual(decideZaloConversationPolicy({
    type: 0,
    muteState: false,
    strangerState: true,
    skipMutedGroups: false,
    skipStrangerMessages: true,
  }), {
    forward: false,
    silent: false,
    reason: 'stranger_dm',
    strangerStateUnknown: false,
  });
  assert.deepEqual(decideZaloConversationPolicy({
    type: 0,
    muteState: undefined,
    strangerState: undefined,
    skipMutedGroups: false,
    skipStrangerMessages: true,
  }), {
    forward: true,
    silent: false,
    strangerStateUnknown: true,
  });
});

test('conversation policy can mirror a muted thread with notifications enabled', () => {
  assert.deepEqual(decideZaloConversationPolicy({
    type: 1,
    muteState: true,
    strangerState: false,
    skipMutedGroups: false,
    muteSilent: false,
    skipStrangerMessages: false,
  }), {
    forward: true,
    silent: false,
    strangerStateUnknown: false,
  });
});

test('mute policy resolves muted group and muted direct conversation from one cached response', async () => {
  clearZaloPolicyCaches();
  let calls = 0;
  const api = {
    getMute: async () => {
      calls += 1;
      return {
        groupChatEntries: [{ id: 'group-1', duration: -1, startTime: 0 }],
        chatEntries: [{ id: 'user-1', duration: -1, startTime: 0 }],
      };
    },
  };

  assert.equal(await isMutedZaloConversation(api as never, 'group-1', 1), true);
  assert.equal(await isMutedZaloConversation(api as never, 'user-1', 0), true);
  assert.equal(await isMutedZaloConversation(api as never, 'user-2', 0), false);
  assert.equal(calls, 1);
});

test('mute policy fails open when Zalo mute state is unavailable', async () => {
  clearZaloPolicyCaches();
  const api = {
    getMute: async () => {
      throw Object.assign(new Error('mute endpoint unavailable'), { code: 'ECONNRESET' });
    },
  };

  assert.equal(await isMutedZaloConversation(api as never, 'group-1', 1), undefined);
});

test('account policy reset invalidates friend cache', () => {
  friendsCache.set([{ userId: 'friend-1', displayName: 'Friend' }]);
  assert.equal(friendsCache.isFresh(), true);
  clearZaloPolicyCaches();
  assert.equal(friendsCache.isFresh(), false);
  assert.equal(friendsCache.has('friend-1'), false);
});
