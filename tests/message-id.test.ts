import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeMessageId, normalizeMessageIds } from '../src/domain/message-id.js';

test('normalizeMessageId rejects Zalo placeholder IDs', () => {
  for (const invalid of [undefined, null, '', ' ', '0', 0, ' 0 ']) {
    assert.equal(normalizeMessageId(invalid), undefined);
  }
});

test('normalizeMessageIds trims and deduplicates aliases', () => {
  assert.deepEqual(normalizeMessageIds([' 123 ', 123, '456', '0']), ['123', '456']);
});
