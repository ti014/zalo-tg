import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  parseBooleanFlag,
  parseNegativeSafeInteger,
  parseRequiredPositiveIntegerList,
  parseSafeInteger,
  requirePathWithinRoot,
} from '../src/bootstrap/environment.js';

test('owner list is required and rejects malformed or non-positive IDs', () => {
  assert.throws(() => parseRequiredPositiveIntegerList({}, 'TG_OWNER_IDS'));
  assert.throws(() => parseRequiredPositiveIntegerList({ TG_OWNER_IDS: '12,bad' }, 'TG_OWNER_IDS'));
  assert.throws(() => parseRequiredPositiveIntegerList({ TG_OWNER_IDS: '0' }, 'TG_OWNER_IDS'));
  assert.deepEqual(
    parseRequiredPositiveIntegerList({ TG_OWNER_IDS: '12, 13 12' }, 'TG_OWNER_IDS'),
    [12, 13],
  );
});

test('Telegram group ID accepts a negative safe integer only', () => {
  assert.equal(parseNegativeSafeInteger('-100123', 'TG_GROUP_ID'), -100123);
  assert.throws(() => parseNegativeSafeInteger('123', 'TG_GROUP_ID'));
  assert.throws(() => parseNegativeSafeInteger('0', 'TG_GROUP_ID'));
  assert.throws(() => parseNegativeSafeInteger('NaN', 'TG_GROUP_ID'));
  assert.throws(() => parseNegativeSafeInteger('1.2', 'TG_GROUP_ID'));
});

test('boolean flags reject ambiguous values', () => {
  assert.equal(parseBooleanFlag('yes'), true);
  assert.equal(parseBooleanFlag('off'), false);
  assert.throws(() => parseBooleanFlag('sometimes'));
});

test('production persistence paths must remain inside the data root', () => {
  const root = path.resolve('tmp', 'app-data-root');
  const databasePath = path.join(root, 'bridge.db');
  assert.equal(
    requirePathWithinRoot(root, databasePath, 'DATABASE_PATH'),
    databasePath,
  );
  assert.throws(() => requirePathWithinRoot(root, path.resolve('tmp', 'bridge.db'), 'DATABASE_PATH'));
  assert.throws(() => requirePathWithinRoot(root, root, 'DATABASE_PATH'));
});
