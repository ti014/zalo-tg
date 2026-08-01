import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.TG_TOKEN ??= 'test-token';
process.env.TG_GROUP_ID ??= '-1001234567890';
process.env.TG_OWNER_IDS ??= '123456789';
process.env.DATA_DIR ??= path.join(os.tmpdir(), `zalo-tg-shared-temp-${process.pid}`);

const root = mkdtempSync(path.join(os.tmpdir(), 'zalo-shared-root-'));
process.env.ZALO_TG_SHARED_TMP_ROOT = root;

const {
  createSharedTempPath,
  currentUserToken,
  getSharedTempDir,
} = await import('../src/utils/sharedTemp.js');

test('shared temp user token survives unavailable OS account metadata', () => {
  assert.equal(currentUserToken(() => 10001, () => 'ignored'), '10001');
  assert.equal(currentUserToken(undefined, () => { throw new Error('no user database'); }), 'user');
});

test('shared temp paths are writable-root scoped and unique per operation', () => {
  try {
    const directory = getSharedTempDir('zalo test');
    const first = createSharedTempPath('zalo test', 'đăng nhập', '.png');
    const second = createSharedTempPath('zalo test', 'đăng nhập', '.png');
    assert.equal(path.dirname(first), directory);
    assert.equal(path.dirname(second), directory);
    assert.notEqual(first, second);
    assert.equal(path.relative(root, first).startsWith('..'), false);
    assert.equal(path.extname(first), '.png');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
