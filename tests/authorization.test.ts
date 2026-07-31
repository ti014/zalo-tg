import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commandNameFromUpdate,
  isAnonymousAdminUpdate,
  requiresOwner,
  updateChatId,
} from '../src/telegram/authorization-policy.js';

test('privileged commands and callback updates require an owner', () => {
  assert.equal(requiresOwner({ message: { text: '/login', chat: { id: 1 } } }), true);
  assert.equal(requiresOwner({ message: { text: '/restore@bridge_bot file', chat: { id: 1 } } }), true);
  assert.equal(requiresOwner({ message: { text: '/clear confirm', chat: { id: 1 } } }), true);
  assert.equal(requiresOwner({ callback_query: { data: 'af:123' } }), true);
  assert.equal(requiresOwner({ message: { poll: { question: 'x' } } }), true);
  assert.equal(requiresOwner({ message_reaction: { chat: { id: -100 } } }), true);
});

test('read-only commands and ordinary relay messages stay unblocked', () => {
  assert.equal(requiresOwner({ message: { text: '/help' } }), false);
  assert.equal(requiresOwner({ message: { text: '/status' } }), false);
  assert.equal(requiresOwner({ message: { text: 'ordinary message' } }), false);
});

test('command and chat extraction handles bot suffixes and callbacks', () => {
  assert.equal(commandNameFromUpdate({ message: { text: '/BACKUP@bridge_bot full' } }), 'backup');
  assert.equal(updateChatId({ callback_query: { message: { chat: { id: -123 } } } }), -123);
});

test('anonymous administrator messages are detected from sender_chat identity', () => {
  assert.equal(isAnonymousAdminUpdate({
    message: {
      chat: { id: -1001 },
      sender_chat: { id: -1001 },
      from: { id: 1087968824, is_bot: true },
      text: '/clear',
    },
  }), true);
  assert.equal(isAnonymousAdminUpdate({
    message: {
      chat: { id: -1001 },
      from: { id: 1908304666 },
      text: '/clear',
    },
  }), false);
  assert.equal(isAnonymousAdminUpdate({
    message: {
      chat: { id: -1001 },
      sender_chat: { id: -1001 },
      from: { id: 1908304666, is_bot: false },
      text: '/clear',
    },
  }), false);
});
