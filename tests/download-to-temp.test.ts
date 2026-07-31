import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  cleanTemp,
  DownloadSizeLimitError,
  downloadToTemp,
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
