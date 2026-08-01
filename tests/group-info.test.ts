import test from 'node:test';
import assert from 'node:assert/strict';
import { renderGroupInfo } from '../src/telegram/commands/group-info.js';

test('group info rendering escapes names and reports incomplete member lists', () => {
  const text = renderGroupInfo({
    groupId: 'group-1',
    name: '<Team>',
    totalMember: 3,
    memberIds: ['1', '2'],
    names: new Map([['1', '<Alice>']]),
    appAvailable: false,
  }, true);
  assert.match(text, /&lt;Team&gt;/);
  assert.match(text, /&lt;Alice&gt;/);
  assert.match(text, /2\/3/);
  assert.match(text, /loginapp/);
});
