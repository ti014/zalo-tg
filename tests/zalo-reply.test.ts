import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTelegramReplyTarget } from '../src/domain/zalo-reply.js';

function reader(overrides: Partial<Parameters<typeof resolveTelegramReplyTarget>[3]> = {}) {
  return {
    incomingTelegramId: () => undefined,
    incomingConversation: () => undefined,
    sentTelegramId: () => undefined,
    sentConversation: () => undefined,
    ...overrides,
  };
}

test('Zalo reply target falls back to cliMsgId when globalMsgId is zero', () => {
  const target = resolveTelegramReplyTarget(
    { globalMsgId: 0, cliMsgId: 'client-42' },
    'group-a',
    1,
    reader({ incomingTelegramId: alias => alias === 'client-42' ? 99 : undefined }),
  );
  assert.equal(target, 99);
});

test('Zalo reply target rejects aliases owned by another conversation', () => {
  const target = resolveTelegramReplyTarget(
    { globalMsgId: 'shared-id' },
    'group-a',
    1,
    reader({
      incomingTelegramId: () => 10,
      incomingConversation: () => ({ zaloId: 'group-b', threadType: 1 }),
      sentTelegramId: () => 20,
      sentConversation: () => ({ zaloId: 'group-a', threadType: 1 }),
    }),
  );
  assert.equal(target, 20);
});
