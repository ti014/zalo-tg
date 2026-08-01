import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  cleanTemp,
  DownloadSizeLimitError,
  downloadToTemp,
  downloadToTempFromCandidates,
} from '../src/utils/media.js';

test('streaming download enforces byte limit even without Content-Length', async () => {
  const server = http.createServer((_request, response) => {
    response.write('12345');
    response.end('67890');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port.');
    await assert.rejects(
      downloadToTemp(`http://127.0.0.1:${address.port}/file`, 'bounded.bin', 1, 5),
      DownloadSizeLimitError,
    );

    const downloaded = await downloadToTemp(
      `http://127.0.0.1:${address.port}/file`,
      'allowed.bin',
      1,
      10,
    );
    await cleanTemp(downloaded);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('local Bot API file URLs are copied only from the configured shared root', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'zalo-local-file-root-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'zalo-local-file-outside-'));
  const source = path.join(root, 'telegram.bin');
  const forbidden = path.join(outside, 'credentials.json');
  writeFileSync(source, 'telegram-file');
  writeFileSync(forbidden, 'secret');
  const previousRoot = process.env.ZALO_TG_SHARED_TMP_ROOT;
  process.env.ZALO_TG_SHARED_TMP_ROOT = root;
  let copied: string | undefined;
  try {
    copied = await downloadToTemp(pathToFileURL(source).toString(), 'tệp Unicode.bin', 1, 100);
    assert.equal(readFileSync(copied, 'utf8'), 'telegram-file');
    await assert.rejects(
      downloadToTemp(pathToFileURL(forbidden).toString(), 'forbidden.bin', 1, 100),
      /outside the configured shared temp root/,
    );
  } finally {
    if (copied) await cleanTemp(copied);
    if (previousRoot === undefined) delete process.env.ZALO_TG_SHARED_TMP_ROOT;
    else process.env.ZALO_TG_SHARED_TMP_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('candidate download falls back from an expired HD URL to the normal photo URL', async () => {
  const requested: string[] = [];
  const server = http.createServer((request, response) => {
    requested.push(request.url ?? '');
    if (request.url === '/hd') {
      response.writeHead(404).end('expired');
      return;
    }
    response.writeHead(200, { 'content-type': 'image/jpeg' }).end('normal-photo');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  let downloaded: string | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port.');
    downloaded = await downloadToTempFromCandidates([
      `http://127.0.0.1:${address.port}/hd`,
      `http://127.0.0.1:${address.port}/normal`,
    ], 'ảnh mùa hè.jpg', 1, 100);
    assert.deepEqual(requested, ['/hd', '/normal']);
  } finally {
    if (downloaded) await cleanTemp(downloaded);
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
