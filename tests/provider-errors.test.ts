import assert from 'node:assert/strict';
import test from 'node:test';

import { isAmbiguousProviderFailure, isConnectPhaseFailure } from '../src/domain/provider-errors.js';

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

test('connect-phase failures are detected without changing fallback ambiguity', () => {
  const connectTimeout = Object.assign(
    new Error('request to https://api.telegram.org/bot<redacted>/sendPhoto failed, reason: connect ETIMEDOUT 149.154.166.110:443'),
    { code: 'ETIMEDOUT' },
  );
  assert.equal(isConnectPhaseFailure(connectTimeout), true);
  // Fallback paths must still stop: retrying the same format is the worker's job.
  assert.equal(isAmbiguousProviderFailure(connectTimeout), true);
  assert.equal(
    isConnectPhaseFailure(Object.assign(new Error('x'), { code: 'ECONNREFUSED', syscall: 'connect' })),
    true,
  );
  assert.equal(
    isConnectPhaseFailure(new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { syscall: 'connect' }),
    })),
    true,
  );
  const readReset = Object.assign(
    new Error('request to https://api.telegram.org/bot<redacted>/sendMessage failed, reason: read ECONNRESET'),
    { code: 'ECONNRESET' },
  );
  assert.equal(isConnectPhaseFailure(readReset), false);
  assert.equal(isAmbiguousProviderFailure(readReset), true);
  assert.equal(isConnectPhaseFailure(new Error('could not connect EVERYTHING')), false);
});
