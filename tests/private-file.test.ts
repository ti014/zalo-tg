import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { writePrivateJsonFileSync, writePrivateTextFileSync } from '../src/utils/privateFile.js';

test('private file writers create nested files and preserve JSON', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zalo-private-'));
  const textPath = path.join(root, 'nested', 'secret.txt');
  const jsonPath = path.join(root, 'session.json');
  writePrivateTextFileSync(textPath, 'secret');
  writePrivateJsonFileSync(jsonPath, { token: 'x' });
  assert.equal(await readFile(textPath, 'utf8'), 'secret');
  assert.deepEqual(JSON.parse(await readFile(jsonPath, 'utf8')), { token: 'x' });
  if (process.platform !== 'win32') assert.equal((await stat(textPath)).mode & 0o777, 0o600);
});
