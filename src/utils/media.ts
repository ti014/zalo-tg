import axios from 'axios';
import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'fs';
import { chmod, copyFile, readFile, realpath, stat, unlink } from 'fs/promises';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { pipeline, Transform } from 'node:stream';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'node:url';
import { imageSizeFromFile } from 'image-size/fromFile';
import { config } from '../config.js';
import { getSharedTempDir, getSharedTempRoot } from './sharedTemp.js';

const TMP_DIR = config.telegram.localServer
  ? getSharedTempDir('zalo-tg')
  : path.join(os.tmpdir(), 'zalo-tg');
const require = createRequire(import.meta.url);
const pipelineAsync = promisify(pipeline);

export const ZALO_GIF_MAX_BYTES = 5_000_000;
const TGS_COMPRESSED_MAX_BYTES = 1 * 1024 * 1024;
const TGS_JSON_MAX_BYTES = 8 * 1024 * 1024;

function formatMegabytes(bytes: number): string {
  const megabytes = bytes / 1_000_000;
  return `${Number.isInteger(megabytes) ? megabytes.toFixed(0) : megabytes.toFixed(1)}MB`;
}

interface GifPreset {
  fps: number;
  width: number;
  colors: number;
}

const GIF_QUALITY_PRESETS: GifPreset[] = [
  { fps: 30, width: 512, colors: 256 },
  { fps: 24, width: 512, colors: 256 },
  { fps: 20, width: 480, colors: 192 },
  { fps: 15, width: 384, colors: 160 },
  { fps: 12, width: 320, colors: 128 },
  { fps: 10, width: 256, colors: 96 },
  { fps: 8, width: 192, colors: 64 },
  { fps: 6, width: 128, colors: 48 },
  { fps: 5, width: 96, colors: 32 },
];

const HIGH_QUALITY_GIF_PRESET: GifPreset = GIF_QUALITY_PRESETS[0]!;

const ULTRA_GIF_PRESET: GifPreset = { fps: 1, width: 64, colors: 8 };

let tgsConversionQueue: Promise<void> = Promise.resolve();

/** Preserve readable Unicode while removing path, control, and bidi characters. */
export function sanitizeFileName(fileName: string, fallback = 'media.bin'): string {
  let sanitized = fileName
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001F\u007F-\u009F]/gu, '_')
    .replace(/[\u202A-\u202E\u2066-\u2069]/gu, '_')
    .trim()
    .replace(/[. ]+$/gu, '');
  if (!sanitized || sanitized === '.' || sanitized === '..') sanitized = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  const maxCodePoints = 180;
  if (Array.from(sanitized).length <= maxCodePoints) return sanitized;
  const extension = path.extname(sanitized).slice(0, 32);
  const extensionLength = Array.from(extension).length;
  const stem = sanitized.slice(0, sanitized.length - path.extname(sanitized).length);
  return `${Array.from(stem).slice(0, Math.max(1, maxCodePoints - extensionLength)).join('')}${extension}`;
}

function runTgsConversionExclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = tgsConversionQueue.then(task, task);
  tgsConversionQueue = run.then(() => undefined, () => undefined);
  return run;
}

let _ffmpegPathCache: string | null | undefined;

function getFfmpegPath(): string {
  if (_ffmpegPathCache === undefined) {
    if (process.env.FFMPEG_BIN?.trim()) {
      _ffmpegPathCache = process.env.FFMPEG_BIN.trim();
      return _ffmpegPathCache;
    }
    try {
      _ffmpegPathCache = require('ffmpeg-static') as string | null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'MODULE_NOT_FOUND') {
        _ffmpegPathCache = null;
        throw new Error('ffmpeg-static not installed; run `npm install` to enable sticker→GIF');
      }
      throw err;
    }
  }
  if (!_ffmpegPathCache) throw new Error('ffmpeg-static unavailable');
  return _ffmpegPathCache;
}

const CHILD_PROCESS_TIMEOUT_MS = 120_000;

async function runFfmpeg(args: string[], label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ff = spawn(getFfmpegPath(), args);
    const timer = setTimeout(() => {
      ff.kill('SIGKILL');
      reject(new Error(`${label} timeout after ${Math.round(CHILD_PROCESS_TIMEOUT_MS / 1000)}s`));
    }, CHILD_PROCESS_TIMEOUT_MS);
    ff.on('close', code => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${label} exit ${code}`));
    });
    ff.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function runTgsConverterInNode(inputPath: string, outputPath: string): Promise<void> {
  mkdirSync(TMP_DIR, { recursive: true });
  const workDir = mkdtempSync(path.join(TMP_DIR, 'tgs-'));
  const framesDir = path.join(workDir, 'frames');
  mkdirSync(framesDir, { recursive: true });
  const puppeteerTmpDir = process.env.PUPPETEER_TMP_DIR?.trim() || os.tmpdir();
  mkdirSync(puppeteerTmpDir, { recursive: true });
  let browser: Awaited<ReturnType<typeof import('puppeteer-core')['launch']>> | undefined;
  try {
    const compressed = await readFile(inputPath);
    if (compressed.byteLength > TGS_COMPRESSED_MAX_BYTES) {
      throw new DownloadSizeLimitError(compressed.byteLength, TGS_COMPRESSED_MAX_BYTES);
    }
    const decompressed = await new Promise<Buffer>((resolve, reject) => {
      gunzip(compressed, { maxOutputLength: TGS_JSON_MAX_BYTES }, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
    const animationData = JSON.parse(decompressed.toString('utf8')) as {
      fr?: number;
      ip?: number;
      op?: number;
      w?: number;
      h?: number;
      [key: string]: unknown;
    };
    const sourceFps = Number(animationData.fr);
    const firstFrame = Number(animationData.ip ?? 0);
    const lastFrame = Number(animationData.op);
    if (
      !Number.isFinite(sourceFps) || sourceFps <= 0
      || !Number.isFinite(firstFrame)
      || !Number.isFinite(lastFrame)
      || lastFrame <= firstFrame
    ) {
      throw new Error('TGS animation has invalid frame metadata.');
    }

    const width = Math.max(1, Math.min(512, Math.round(Number(animationData.w) || 512)));
    const height = Math.max(1, Math.min(512, Math.round(Number(animationData.h) || 512)));
    const outputFps = Math.max(1, Math.min(30, Math.round(sourceFps)));
    const sourceFrames = lastFrame - firstFrame;
    const outputFrames = Math.ceil(sourceFrames * outputFps / sourceFps);
    if (outputFrames > 600) throw new Error(`TGS animation has too many frames: ${outputFrames}`);

    const puppeteer = await import('puppeteer-core');
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
    if (!executablePath) {
      throw new Error('PUPPETEER_EXECUTABLE_PATH is required for TGS conversion.');
    }
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      timeout: 30_000,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(
      '<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">'
      + `<div id="animation" style="width:${width}px;height:${height}px"></div>`
      + '</body></html>',
      { waitUntil: 'domcontentloaded' },
    );
    await page.addScriptTag({
      path: require.resolve('lottie-web/build/player/lottie_light.min.js'),
    });
    await page.evaluate(async data => {
      const runtime = globalThis as unknown as {
        lottie: {
          loadAnimation(options: Record<string, unknown>): {
            isLoaded?: boolean;
            addEventListener(event: string, callback: () => void): void;
            goToAndStop(frame: number, isFrame: boolean): void;
          };
        };
        animation?: {
          goToAndStop(frame: number, isFrame: boolean): void;
        };
      };
      const container = document.getElementById('animation');
      if (!container || !runtime.lottie) throw new Error('Lottie runtime failed to initialize.');
      const animation = runtime.lottie.loadAnimation({
        container,
        renderer: 'svg',
        loop: false,
        autoplay: false,
        animationData: data,
      });
      runtime.animation = animation;
      if (!animation.isLoaded) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Lottie DOMLoaded timeout.')), 10_000);
          animation.addEventListener('DOMLoaded', () => {
            clearTimeout(timer);
            resolve();
          });
          animation.addEventListener('data_failed', () => {
            clearTimeout(timer);
            reject(new Error('Lottie rejected the TGS animation data.'));
          });
        });
      }
    }, animationData);

    for (let index = 0; index < outputFrames; index += 1) {
      const sourceFrame = Math.min(sourceFrames - 1, Math.floor(index * sourceFps / outputFps));
      await page.evaluate(async frame => {
        const runtime = globalThis as unknown as {
          animation?: { goToAndStop(value: number, isFrame: boolean): void };
        };
        runtime.animation?.goToAndStop(frame, true);
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }, sourceFrame);
      const framePath = path.join(framesDir, `frame_${String(index).padStart(5, '0')}.png`);
      await page.screenshot({
        path: framePath as `${string}.png`,
        omitBackground: true,
      });
    }

    await runFfmpeg([
      '-y',
      '-framerate', String(outputFps),
      '-i', path.join(framesDir, 'frame_%05d.png'),
      '-filter_complex', gifFilter(HIGH_QUALITY_GIF_PRESET),
      '-loop', '0',
      outputPath,
    ], 'TGS frames to GIF');
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function fileSize(filePath: string): Promise<number> {
  const { size } = await stat(filePath);
  return size;
}

function gifFilter(preset: GifPreset): string {
  return `fps=${preset.fps},scale='min(${preset.width},iw)':-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=${preset.colors}:reserve_transparent=on[p];[s1][p]paletteuse=dither=sierra2_4a`;
}

export class DownloadSizeLimitError extends Error {
  readonly code = 'MEDIA_TOO_LARGE';

  constructor(actualBytes: number, maxBytes: number) {
    super(`Download exceeded ${maxBytes} bytes (received at least ${actualBytes} bytes).`);
    this.name = 'DownloadSizeLimitError';
  }
}

/** Download a remote URL to a temp file. Returns the local file path. */
export async function downloadToTemp(
  url: string,
  fileName?: string,
  retries = 3,
  maxBytes?: number,
): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
    throw new Error('maxBytes must be a positive safe integer.');
  }

  // Sanitize filename and add a unique prefix so concurrent downloads
  // with the same logical name (e.g. multiple 'photo.jpg' in a media group)
  // do not overwrite each other.
  const baseName = sanitizeFileName(fileName ?? `download_${Date.now()}`);

  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 500ms, 1500ms, ...
      await new Promise(r => setTimeout(r, 500 * attempt * attempt));
    }

    const filePath = path.join(TMP_DIR, `${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${baseName}`);
    try {
      if (url.startsWith('file:')) {
        const sourcePath = await realpath(fileURLToPath(new URL(url)));
        const sharedRoot = await realpath(getSharedTempRoot());
        const relative = path.relative(sharedRoot, sourcePath);
        if (
          !relative
          || relative === '..'
          || relative.startsWith(`..${path.sep}`)
          || path.isAbsolute(relative)
        ) {
          throw new Error('Refusing file URL outside the configured shared temp root.');
        }
        const sourceStats = await stat(sourcePath);
        if (!sourceStats.isFile() || sourceStats.size < 1) throw new Error('Local Bot API file is empty.');
        if (maxBytes !== undefined && sourceStats.size > maxBytes) {
          throw new DownloadSizeLimitError(sourceStats.size, maxBytes);
        }
        await copyFile(sourcePath, filePath, fsConstants.COPYFILE_EXCL);
        return filePath;
      }
      const resp = await axios.get<NodeJS.ReadableStream>(url, {
        responseType: 'stream',
        timeout: 30_000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZaloTGBridge/1.0)' },
      });
      const contentLength = Number(resp.headers['content-length']);
      if (maxBytes !== undefined && Number.isFinite(contentLength) && contentLength > maxBytes) {
        (resp.data as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        throw new DownloadSizeLimitError(contentLength, maxBytes);
      }
      let receivedBytes = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback): void {
          receivedBytes += chunk.length;
          if (maxBytes !== undefined && receivedBytes > maxBytes) {
            callback(new DownloadSizeLimitError(receivedBytes, maxBytes));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipelineAsync(
        resp.data,
        limiter,
        createWriteStream(filePath, { flags: 'wx', mode: 0o600 }),
      );

      const { size } = await stat(filePath);
      if (size === 0) {
        await unlink(filePath).catch(() => undefined);
        lastErr = new Error(`Downloaded file is empty: ${url}`);
        continue;
      }

      return filePath;
    } catch (err) {
      await unlink(filePath).catch(() => undefined);
      if (err instanceof DownloadSizeLimitError) throw err;
      lastErr = err;
    }
  }

  throw lastErr;
}

/** Download the first working URL in priority order. */
export async function downloadToTempFromCandidates(
  urls: readonly string[],
  fileName?: string,
  retries = 3,
  maxBytes?: number,
): Promise<string> {
  const candidates = Array.from(new Set(
    urls.map(url => url.trim()).filter(Boolean),
  ));
  if (candidates.length === 0) throw new Error('No media URL candidates were provided.');

  const errors: unknown[] = [];
  for (const url of candidates) {
    try {
      return await downloadToTemp(url, fileName, retries, maxBytes);
    } catch (error) {
      if (error instanceof DownloadSizeLimitError) throw error;
      errors.push(error);
    }
  }
  throw new AggregateError(
    errors,
    `Failed to download media from ${candidates.length} URL candidate(s).`,
  );
}

export interface SpriteSheetLayout {
  frames: number;
  frameWidth: number;
  frameHeight: number;
  direction: 'horizontal' | 'vertical';
}

/** Resolve equally sized frames from a horizontal or vertical sticker sheet. */
export function getSpriteSheetLayout(
  width: number,
  height: number,
  declaredFrames = 0,
): SpriteSheetLayout {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error('Sprite dimensions must be positive integers.');
  }
  const requested = Number.isSafeInteger(declaredFrames) && declaredFrames > 1
    ? declaredFrames
    : 0;
  if (requested > 1 && width % requested === 0) {
    return {
      frames: requested,
      frameWidth: width / requested,
      frameHeight: height,
      direction: 'horizontal',
    };
  }
  if (requested > 1 && height % requested === 0) {
    return {
      frames: requested,
      frameWidth: width,
      frameHeight: height / requested,
      direction: 'vertical',
    };
  }
  if (width > height && width % height === 0) {
    return {
      frames: width / height,
      frameWidth: height,
      frameHeight: height,
      direction: 'horizontal',
    };
  }
  if (height > width && height % width === 0) {
    return {
      frames: height / width,
      frameWidth: width,
      frameHeight: width,
      direction: 'vertical',
    };
  }
  return { frames: 1, frameWidth: width, frameHeight: height, direction: 'horizontal' };
}

/** Convert a Zalo sprite sheet into a looping Telegram-compatible GIF. */
export async function convertSpriteSheetToGif(
  inputPath: string,
  declaredFrames: number,
  frameDurationMs: number,
): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const dimensions = await imageSizeFromFile(inputPath);
  if (!dimensions.width || !dimensions.height) {
    throw new Error('Cannot read sticker sprite dimensions.');
  }
  const layout = getSpriteSheetLayout(dimensions.width, dimensions.height, declaredFrames);
  if (layout.frames < 2 || layout.frames > 600) {
    throw new Error('Sticker sprite must contain between 2 and 600 frames.');
  }
  const duration = Number.isFinite(frameDurationMs)
    ? Math.min(1_000, Math.max(20, frameDurationMs))
    : 100;
  const frameRate = (1_000 / duration).toFixed(6);
  const position = layout.direction === 'horizontal'
    ? `x='mod(n\\,${layout.frames})*${layout.frameWidth}':y=0`
    : `x=0:y='mod(n\\,${layout.frames})*${layout.frameHeight}'`;
  const outputPath = path.join(
    TMP_DIR,
    `zalo_sticker_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.gif`,
  );
  try {
    await runFfmpeg([
      '-y',
      '-loop', '1',
      '-framerate', frameRate,
      '-i', inputPath,
      '-vf', `crop=${layout.frameWidth}:${layout.frameHeight}:${position},format=rgba`,
      '-frames:v', String(layout.frames),
      '-loop', '0',
      outputPath,
    ], 'ffmpeg Zalo sticker sprite');
    if (await fileSize(outputPath) < 1) throw new Error('Sticker sprite conversion produced an empty GIF.');
    return outputPath;
  } catch (error) {
    await unlink(outputPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Copies a durable media object to the managed temp directory while restoring
 * its logical filename extension for provider SDKs that classify uploads from
 * the local path rather than from file contents.
 */
export async function materializeTempFile(
  sourcePath: string,
  fileName: string,
): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const source = path.resolve(sourcePath);
  const sourceStats = await stat(source);
  if (!sourceStats.isFile() || sourceStats.size < 1) {
    throw new Error(`Cannot materialize an empty or non-regular file: ${source}`);
  }
  const baseName = sanitizeFileName(fileName);
  const destination = path.join(
    TMP_DIR,
    `${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${baseName}`,
  );
  try {
    await copyFile(source, destination, fsConstants.COPYFILE_EXCL);
    await chmod(destination, 0o600);
    const destinationStats = await stat(destination);
    if (!destinationStats.isFile() || destinationStats.size !== sourceStats.size) {
      throw new Error(`Materialized media size mismatch: ${source}`);
    }
    return destination;
  } catch (error) {
    await unlink(destination).catch(() => undefined);
    throw error;
  }
}

/** Remove a temp file, ignoring errors. */
export async function cleanTemp(filePath: string): Promise<void> {
  const resolved = path.resolve(filePath);
  const tempRoot = `${path.resolve(TMP_DIR)}${path.sep}`;
  if (!resolved.startsWith(tempRoot)) return;
  try { await unlink(resolved); } catch { /* ignore */ }
}

export async function splitFileForTelegram(
  filePath: string,
  maxPartBytes = 45 * 1024 * 1024,
): Promise<string[]> {
  if (!Number.isSafeInteger(maxPartBytes) || maxPartBytes <= 0) {
    throw new Error('maxPartBytes must be a positive safe integer.');
  }
  const { size } = await stat(filePath);
  if (size <= maxPartBytes) return [];
  mkdirSync(TMP_DIR, { recursive: true });
  const partCount = Math.ceil(size / maxPartBytes);
  const partPaths: string[] = [];
  try {
    for (let index = 0; index < partCount; index += 1) {
      const start = index * maxPartBytes;
      const end = Math.min(size, start + maxPartBytes) - 1;
      const partPath = path.join(
        TMP_DIR,
        `${path.basename(filePath)}.${Date.now()}.part${String(index + 1).padStart(3, '0')}`,
      );
      await pipelineAsync(
        createReadStream(filePath, { start, end }),
        createWriteStream(partPath, { flags: 'wx', mode: 0o600 }),
      );
      partPaths.push(partPath);
    }
    return partPaths;
  } catch (error) {
    await Promise.all(partPaths.map(partPath => cleanTemp(partPath)));
    throw error;
  }
}

export async function hashFileSha256(
  filePath: string,
): Promise<{ sha256: string; byteSize: number }> {
  const stats = await stat(filePath);
  if (!stats.isFile() || stats.size < 1) {
    throw new Error(`Cannot hash an empty or non-regular file: ${filePath}`);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return {
    sha256: hash.digest('hex'),
    byteSize: stats.size,
  };
}

/**
 * Convert an audio file to M4A (AAC) using ffmpeg.
 * Returns the path to the converted file (caller must clean it up).
 */
export async function convertToM4a(inputPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const outputPath = path.join(TMP_DIR, `voice_${Date.now()}.m4a`);
  await runFfmpeg([
    '-y', '-i', inputPath,
    '-c:a', 'aac', '-b:a', '64k', '-ar', '44100',
    '-vn', outputPath,
  ], 'ffmpeg audio');
  return outputPath;
}

/**
 * Extract the first frame of a video as a JPEG thumbnail.
 * Returns the path to the thumbnail file (caller must clean it up).
 */
export async function convertTgsToGif(inputPath: string, outputPath?: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const targetPath = outputPath ?? path.join(TMP_DIR, `sticker_${Date.now()}.gif`);
  mkdirSync(path.dirname(targetPath), { recursive: true });

  return runTgsConversionExclusive(async () => {
    await runTgsConverterInNode(inputPath, targetPath);
    const { size } = await stat(targetPath);
    if (size === 0) throw new Error(`TGS conversion produced empty GIF: ${targetPath}`);
    return targetPath;
  });
}

export async function convertImageToGif(inputPath: string, outputPath?: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const targetPath = outputPath ?? path.join(TMP_DIR, `sticker_${Date.now()}.gif`);
  mkdirSync(path.dirname(targetPath), { recursive: true });

  await runFfmpeg([
    '-y', '-i', inputPath,
    '-filter_complex', gifFilter(HIGH_QUALITY_GIF_PRESET),
    '-loop', '0',
    targetPath,
  ], 'ffmpeg image gif');

  const size = await fileSize(targetPath);
  if (size === 0) throw new Error(`Image conversion produced empty GIF: ${targetPath}`);
  return targetPath;
}

export async function compressGifForZalo(inputPath: string): Promise<string> {
  const initialSize = await fileSize(inputPath);
  if (initialSize > 0 && initialSize <= ZALO_GIF_MAX_BYTES) return inputPath;

  let lastSize = initialSize;
  for (const preset of GIF_QUALITY_PRESETS) {
    const targetPath = path.join(TMP_DIR, `sticker_${Date.now()}_${preset.width}w.gif`);
    await runFfmpeg([
      '-y', '-i', inputPath,
      '-filter_complex', gifFilter(preset),
      '-loop', '0',
      targetPath,
    ], `ffmpeg gif compress ${preset.width}px/${preset.fps}fps`);

    lastSize = await fileSize(targetPath);
    if (lastSize === 0) throw new Error(`GIF compression produced empty file: ${targetPath}`);
    if (lastSize <= ZALO_GIF_MAX_BYTES) return targetPath;

    console.warn(`[media] Compressed GIF ${formatMegabytes(lastSize)} still exceeds safe Zalo limit (${formatMegabytes(ZALO_GIF_MAX_BYTES)}); retrying smaller preset.`);
    await unlink(targetPath).catch(() => undefined);
  }

  throw new Error(`GIF still exceeds safe Zalo limit ${formatMegabytes(ZALO_GIF_MAX_BYTES)} (last output: ${formatMegabytes(lastSize)})`);
}

export async function forceUltraSmallGif(inputPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const targetPath = path.join(TMP_DIR, `sticker_${Date.now()}_ultra.gif`);
  await runFfmpeg([
    '-y', '-i', inputPath,
    '-filter_complex', gifFilter(ULTRA_GIF_PRESET),
    '-loop', '0',
    targetPath,
  ], 'ffmpeg gif ultra');
  const size = await fileSize(targetPath);
  if (size === 0) throw new Error(`Ultra GIF produced empty file: ${targetPath}`);
  return targetPath;
}

export async function convertVideoToGif(inputPath: string, outputPath?: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const targetPath = outputPath ?? path.join(TMP_DIR, `sticker_${Date.now()}.gif`);
  mkdirSync(path.dirname(targetPath), { recursive: true });

  let lastSize = 0;
  for (const preset of GIF_QUALITY_PRESETS) {
    await runFfmpeg([
      '-y', '-i', inputPath,
      '-filter_complex', gifFilter(preset),
      '-loop', '0',
      targetPath,
    ], `ffmpeg gif ${preset.width}px/${preset.fps}fps`);

    lastSize = await fileSize(targetPath);
    if (lastSize === 0) throw new Error(`Video conversion produced empty GIF: ${targetPath}`);
    if (lastSize <= ZALO_GIF_MAX_BYTES) return targetPath;

    console.warn(`[media] GIF ${formatMegabytes(lastSize)} exceeds Zalo limit ${formatMegabytes(ZALO_GIF_MAX_BYTES)}; retrying smaller preset.`);
    await unlink(targetPath).catch(() => undefined);
  }

  throw new Error(`Converted GIF still exceeds Zalo limit ${formatMegabytes(ZALO_GIF_MAX_BYTES)} (last output: ${formatMegabytes(lastSize)})`);
}

/**
 * Convert a Telegram video sticker (WebM) to an H.264 MP4 accepted by Zalo.
 * Video stickers do not need audio, and are bounded to Telegram's sticker size.
 */
export async function convertVideoToMp4(inputPath: string, outputPath?: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const targetPath = outputPath ?? path.join(TMP_DIR, `sticker_${Date.now()}.mp4`);
  mkdirSync(path.dirname(targetPath), { recursive: true });

  await runFfmpeg([
    '-y', '-i', inputPath,
    '-vf', "scale='min(512,iw)':-2:flags=lanczos,pad=ceil(iw/2)*2:ceil(ih/2)*2:(ow-iw)/2:(oh-ih)/2:color=black",
    '-an',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    targetPath,
  ], 'ffmpeg video sticker mp4');

  const size = await fileSize(targetPath);
  if (size === 0) throw new Error(`MP4 conversion produced empty file: ${targetPath}`);
  return targetPath;
}

export async function extractVideoThumbnail(videoPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const outputPath = path.join(TMP_DIR, `thumb_${Date.now()}.jpg`);
  await runFfmpeg([
    '-y', '-i', videoPath,
    '-vframes', '1',
    '-q:v', '5',
    '-vf', 'scale=\'min(720,iw)\':-2',
    outputPath,
  ], 'ffmpeg thumb');
  return outputPath;
}

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv']);

/** Guess media type from filename or URL. */
export function detectMediaType(fileNameOrUrl: string): 'image' | 'video' | 'document' {
  const lower = fileNameOrUrl.toLowerCase();
  const ext   = path.extname(lower.split('?')[0] ?? '');
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (/\.(jpg|jpeg|png|gif|webp)(\?|$)/.test(lower)) return 'image';
  if (/\.(mp4|mov|avi|mkv|webm)(\?|$)/.test(lower))  return 'video';
  return 'document';
}
