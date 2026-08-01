import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  cleanTemp,
  compressGifForZalo,
  convertImageToGif,
  convertSpriteSheetToGif,
  convertTgsToGif,
  convertVideoToMp4,
  DownloadSizeLimitError,
  getSpriteSheetLayout,
  sanitizeFileName,
  splitFileForTelegram,
} from '../src/utils/media.js';

test('large file splitting is lossless and cleanTemp never deletes outside managed temp root', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-media-split-'));
  const sourcePath = path.join(directory, 'source.bin');
  const source = Buffer.from('abcdefghijklmnopqrstuvwxyz');
  writeFileSync(sourcePath, source);
  try {
    const parts = await splitFileForTelegram(sourcePath, 10);
    assert.equal(parts.length, 3);
    assert.deepEqual(Buffer.concat(parts.map(part => readFileSync(part))), source);
    await Promise.all(parts.map(part => cleanTemp(part)));

    await cleanTemp(sourcePath);
    assert.deepEqual(readFileSync(sourcePath), source);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Unicode filenames remain readable while path and control characters are removed', () => {
  const sanitized = sanitizeFileName('../Báo cáo quý 1?.pdf');
  assert.match(sanitized, /Báo cáo quý 1_\.pdf$/u);
  assert.doesNotMatch(sanitized, /[\\/:*?"<>|]/u);
  assert.equal(sanitizeFileName('CON'), '_CON');
});

test('Zalo sticker sprite layout supports declared and inferred strips', () => {
  assert.deepEqual(getSpriteSheetLayout(96, 32, 3), {
    frames: 3,
    frameWidth: 32,
    frameHeight: 32,
    direction: 'horizontal',
  });
  assert.deepEqual(getSpriteSheetLayout(24, 72), {
    frames: 3,
    frameWidth: 24,
    frameHeight: 24,
    direction: 'vertical',
  });
  assert.deepEqual(getSpriteSheetLayout(40, 30, 7), {
    frames: 1,
    frameWidth: 40,
    frameHeight: 30,
    direction: 'horizontal',
  });
});

test('Zalo sticker sprite sheets are rendered as animated GIFs', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-sprite-gif-'));
  const sourcePath = path.join(directory, 'sprite.png');
  writeFileSync(
    sourcePath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  let outputPath: string | undefined;
  try {
    outputPath = await convertSpriteSheetToGif(sourcePath, 2, 100);
    const output = readFileSync(outputPath);
    assert.match(output.subarray(0, 6).toString('ascii'), /^GIF8[79]a$/);
    assert.ok(output.length > 100);
  } finally {
    if (outputPath) await cleanTemp(outputPath);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('TGS conversion rejects oversized compressed input before decompression or Chromium launch', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-tgs-limit-'));
  const sourcePath = path.join(directory, 'oversized.tgs');
  writeFileSync(sourcePath, Buffer.alloc((1024 * 1024) + 1));
  try {
    await assert.rejects(
      convertTgsToGif(sourcePath),
      error => error instanceof DownloadSizeLimitError,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('GIFs within the Zalo limit are preserved without a lossy re-encode', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-gif-preserve-'));
  const sourcePath = path.join(directory, 'source.gif');
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  writeFileSync(sourcePath, gif);
  try {
    assert.equal(await compressGifForZalo(sourcePath), sourcePath);
    assert.deepEqual(readFileSync(sourcePath), gif);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('video sticker conversion produces an H.264 MP4 accepted by Zalo', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-video-sticker-'));
  const sourcePath = path.join(directory, 'source.gif');
  const outputPath = path.join(directory, 'sticker.mp4');
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  writeFileSync(sourcePath, gif);
  try {
    await convertVideoToMp4(sourcePath, outputPath);
    const output = readFileSync(outputPath);
    assert.ok(output.includes(Buffer.from('ftyp')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('GIF fallback uses a valid palette-encoded GIF output', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-image-gif-'));
  const sourcePath = path.join(directory, 'source.png');
  const outputPath = path.join(directory, 'output.gif');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  writeFileSync(sourcePath, png);
  try {
    await convertImageToGif(sourcePath, outputPath);
    const output = readFileSync(outputPath);
    assert.equal(output.subarray(0, 6).toString('ascii'), 'GIF89a');
    assert.ok(output.length > 100);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
