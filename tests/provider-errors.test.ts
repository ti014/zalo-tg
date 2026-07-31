import assert from 'node:assert/strict';
import test from 'node:test';

import { isAmbiguousProviderFailure } from '../src/domain/provider-errors.js';

test('ambiguous provider failures are distinguished from definitive failures', () => {
  assert.equal(
    isAmbiguousProviderFailure(Object.assign(new Error('request failed'), { code: 'ETIMEDOUT' })),
    true,
  );
  assert.equal(isAmbiguousProviderFailure(new Error('socket hang up')), true);
  assert.equal(
    isAmbiguousProviderFailure(Object.assign(new Error('forbidden'), { code: '403' })),
    false,
  );
});
