import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeJsonAtomicSync, writeUtf8AtomicSync } from '../src/infrastructure/files/atomic-file.js';

test('atomic writer replaces a file and leaves no temporary sibling', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-atomic-'));
  try {
    const target = path.join(directory, 'state.json');
    writeUtf8AtomicSync(target, 'old');
    writeJsonAtomicSync(target, { value: 'new' });
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { value: 'new' });
    assert.deepEqual(readdirSync(directory), ['state.json']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
