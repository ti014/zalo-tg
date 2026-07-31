import assert from 'node:assert/strict';
import test from 'node:test';

import { GROUP_BOT_COMMANDS, PRIVATE_BOT_COMMANDS } from '../src/telegram/bot.js';

test('Telegram group command catalog exposes every supported slash shortcut once', () => {
  const commands = GROUP_BOT_COMMANDS.map(entry => entry.command);
  assert.equal(commands.length, 19);
  assert.equal(new Set(commands).size, commands.length);
  for (const required of [
    'menu', 'status', 'search', 'topic', 'clear', 'queue', 'settings',
    'members', 'recall', 'backup', 'restore', 'login', 'help',
  ]) {
    assert.ok(commands.includes(required), required);
  }
});

test('Telegram private command catalog only exposes the private login flow', () => {
  assert.deepEqual(PRIVATE_BOT_COMMANDS.map(entry => entry.command), ['login']);
});
