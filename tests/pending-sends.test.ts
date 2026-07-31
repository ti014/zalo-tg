import assert from 'node:assert/strict';
import test from 'node:test';

import { PendingSendRegistry } from '../src/domain/pending-sends.js';

test('two pending sends in one conversation do not overwrite each other', () => {
  const registry = new PendingSendRegistry();
  const first = registry.begin({ conversationId: 'c', telegramMessageId: 1, kind: 'text', fingerprint: 'A' });
  const second = registry.begin({ conversationId: 'c', telegramMessageId: 2, kind: 'text', fingerprint: 'B' });
  registry.bindAliases(first, ['101']);
  registry.bindAliases(second, ['102']);

  assert.equal(registry.consume({ conversationId: 'c', aliases: ['102'], kind: 'text' }), 2);
  assert.equal(registry.consume({ conversationId: 'c', aliases: ['101'], kind: 'text' }), 1);
});

test('a direct self-message is not consumed merely because a send is pending', () => {
  const registry = new PendingSendRegistry();
  registry.begin({ conversationId: 'c', telegramMessageId: 1, kind: 'text', fingerprint: 'from telegram' });

  assert.equal(registry.consume({
    conversationId: 'c',
    aliases: ['phone-message'],
    kind: 'text',
    fingerprint: 'typed on phone',
  }), undefined);
  assert.equal(registry.size, 1);
});

test('fingerprint fallback handles an echo that arrives before API aliases', () => {
  const registry = new PendingSendRegistry();
  registry.begin({ conversationId: 'c', telegramMessageId: 7, kind: 'text', fingerprint: ' hello   world ' });
  assert.equal(registry.consume({
    conversationId: 'c',
    aliases: ['server-id'],
    kind: 'text',
    fingerprint: 'hello world',
  }), 7);
});

test('failed and expired records cannot consume later messages', () => {
  let now = 100;
  const registry = new PendingSendRegistry(10, () => now);
  const failed = registry.begin({ conversationId: 'c', telegramMessageId: 1, kind: 'text', fingerprint: 'x' });
  registry.cancel(failed);
  assert.equal(registry.size, 0);

  registry.begin({ conversationId: 'c', telegramMessageId: 2, kind: 'text', fingerprint: 'y' });
  now = 111;
  registry.prune();
  assert.equal(registry.size, 0);
});
