import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecallPayloadGroups, buildRecallPayloads } from '../src/domain/recall.js';

test('recall payloads prefer confirmed client ID and retain provider fallbacks', () => {
  assert.deepEqual(buildRecallPayloads({ msgId: 'global', cliMsgId: 'client' }), [
    { msgId: 'global', cliMsgId: 'client' },
    { msgId: 'global', cliMsgId: 'global' },
    { msgId: 'global', cliMsgId: 0 },
  ]);
});

test('recall payload groups retain every provider message in an album', () => {
  assert.deepEqual(buildRecallPayloadGroups({
    msgIds: ['global-1', 'global-2', 'global-1'],
    cliMsgId: 'client-1',
  }), [
    [
      { msgId: 'global-1', cliMsgId: 'client-1' },
      { msgId: 'global-1', cliMsgId: 'global-1' },
      { msgId: 'global-1', cliMsgId: 0 },
    ],
    [
      { msgId: 'global-2', cliMsgId: 'global-2' },
      { msgId: 'global-2', cliMsgId: 0 },
    ],
  ]);
});

test('recall payloads deduplicate equal global and client IDs', () => {
  assert.deepEqual(buildRecallPayloads({ msgId: 'same', cliMsgId: 'same' }), [
    { msgId: 'same', cliMsgId: 'same' },
    { msgId: 'same', cliMsgId: 0 },
  ]);
});
