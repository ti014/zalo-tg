import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.TG_TOKEN ??= 'test-token';
process.env.TG_GROUP_ID ??= '-1001234567890';
process.env.TG_OWNER_IDS ??= '123456789';
process.env.DATA_DIR ??= path.join(os.tmpdir(), `zalo-tg-media-input-${process.pid}`);

const {
  isTelegramFileUriRejection,
  isPathWithinSharedRoot,
  sendTelegramAnimationWithFallback,
  sendTelegramPhotoWithFallback,
} = await import('../src/telegram/media-input.js');

async function consumeMedia(media: unknown): Promise<void> {
  if (media && typeof media === 'object' && 'source' in media) {
    const source = (media as { source: AsyncIterable<unknown> }).source;
    for await (const _chunk of source) { /* Drain the test stream. */ }
  }
}

test('multipart retry is limited to HTTP 400 errors that identify a local file URI', () => {
  assert.equal(isTelegramFileUriRejection({
    response: { error_code: 400, description: 'Bad Request: file not found at file:///shared/a.jpg' },
  }), true);
  assert.equal(isTelegramFileUriRejection({
    response: { error_code: 400, description: 'Bad Request: chat not found' },
  }), false);
  assert.equal(isTelegramFileUriRejection({
    response: { error_code: 500, description: 'file:// transport failed' },
  }), false);
});

test('zero-copy file URIs are restricted to the configured shared root', () => {
  const root = path.join(os.tmpdir(), 'zalo-shared-boundary');
  assert.equal(isPathWithinSharedRoot(path.join(root, 'photo.jpg'), root), true);
  assert.equal(isPathWithinSharedRoot(path.join(root, '..', 'secret.json'), root), false);
  assert.equal(isPathWithinSharedRoot(root, root), false);
});

test('animation delivery falls back in animation, video, document order', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-animation-fallback-'));
  const filePath = path.join(directory, 'animation.gif');
  writeFileSync(filePath, 'gif');
  const calls: string[] = [];
  try {
    const result = await sendTelegramAnimationWithFallback(
      filePath,
      'animation.gif',
      {
        animation: async media => {
          await consumeMedia(media);
          calls.push('animation');
          throw new Error('Bad Request: wrong animation format');
        },
        video: async media => {
          await consumeMedia(media);
          calls.push('video');
          throw new Error('Bad Request: wrong video format');
        },
        document: async media => {
          await consumeMedia(media);
          calls.push('document');
          return { message_id: 42 };
        },
      },
    );
    assert.deepEqual(result, { message_id: 42 });
    assert.deepEqual(calls, ['animation', 'video', 'document']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('animation delivery suppresses format fallback after an ambiguous timeout', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-animation-timeout-'));
  const filePath = path.join(directory, 'animation.gif');
  writeFileSync(filePath, 'gif');
  const calls: string[] = [];
  try {
    await assert.rejects(
      sendTelegramAnimationWithFallback(
        filePath,
        'animation.gif',
        {
          animation: async media => {
            await consumeMedia(media);
            calls.push('animation');
            throw Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' });
          },
          video: async media => { await consumeMedia(media); calls.push('video'); return { message_id: 2 }; },
          document: async media => { await consumeMedia(media); calls.push('document'); return { message_id: 3 }; },
        },
      ),
      /timed out/,
    );
    assert.deepEqual(calls, ['animation']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid Telegram photo dimensions fall back to a document', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-photo-fallback-'));
  const filePath = path.join(directory, 'photo.jpg');
  writeFileSync(filePath, 'image');
  const calls: string[] = [];
  try {
    const result = await sendTelegramPhotoWithFallback(
      filePath,
      'photo.jpg',
      {
        photo: async media => {
          await consumeMedia(media);
          calls.push('photo');
          throw Object.assign(new Error('400: Bad Request: PHOTO_INVALID_DIMENSIONS'), { code: 400 });
        },
        document: async media => {
          await consumeMedia(media);
          calls.push('document');
          return { message_id: 43 };
        },
      },
    );
    assert.deepEqual(result, { message_id: 43 });
    assert.deepEqual(calls, ['photo', 'document']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ambiguous photo timeout does not send a duplicate document', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-photo-timeout-'));
  const filePath = path.join(directory, 'photo.jpg');
  writeFileSync(filePath, 'image');
  let documentCalls = 0;
  try {
    await assert.rejects(
      sendTelegramPhotoWithFallback(
        filePath,
        'photo.jpg',
        {
          photo: async media => {
            await consumeMedia(media);
            throw Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' });
          },
          document: async media => {
            await consumeMedia(media);
            documentCalls += 1;
            return { message_id: 44 };
          },
        },
      ),
      /timed out/,
    );
    assert.equal(documentCalls, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
