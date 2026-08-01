import test from 'node:test';
import assert from 'node:assert/strict';

test('group join request callback payload has a stable action contract', () => {
  const payload = 'gm:approve:group-123:user-456';
  const [, action, groupId, uid] = payload.split(':');
  assert.deepEqual({ action, groupId, uid }, {
    action: 'approve',
    groupId: 'group-123',
    uid: 'user-456',
  });
});
