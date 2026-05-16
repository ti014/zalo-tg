import axios from 'axios';
import { createWriteStream, mkdirSync } from 'fs';
import { stat, unlink } from 'fs/promises';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import os from 'os';

const TMP_DIR = path.join(os.tmpdir(), 'zalo-tg');
const require = createRequire(import.meta.url);

const ZALO_GIF_MAX_BYTES = 5_000_000;

function formatMegabytes(bytes: number): string {
  const megabytes = bytes / 1_000_000;
  return `${Number.isInteger(megabytes) ? megabytes.toFixed(0) : megabytes.toFixed(1)}MB`;
}

interface GifPreset {
  fps: number;
  width: number;
  colors: number;
}

const VIDEO_GIF_PRESETS: GifPreset[] = [
  { fps: 12, width: 384, colors: 128 },
  { fps: 10, width: 320, colors: 96 },
  { fps: 8, width: 256, colors: 64 },
  { fps: 6, width: 192, colors: 64 },
  { fps: 5, width: 160, colors: 48 },
  { fps: 4, width: 128, colors: 32 },
  { fps: 3, width: 96, colors: 24 },
  { fps: 2, width: 72, colors: 16 },
];

const ULTRA_GIF_PRESET: GifPreset = { fps: 1, width: 64, colors: 8 };

let tgsConversionQueue: Promise<void> = Promise.resolve();

function runTgsConversionExclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = tgsConversionQueue.then(task, task);
  tgsConversionQueue = run.then(() => undefined, () => undefined);
  return run;
}

function getFfmpegPath(): string {
  const ffmpegPath = require('ffmpeg-static') as string | null;
  if (!ffmpegPath) throw new Error('ffmpeg-static did not provide a binary path');
  return ffmpegPath;
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

function createCleanNodeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (env.NODE_OPTIONS && /(?:tsx|ts-node|esbuild)/i.test(env.NODE_OPTIONS)) {
    delete env.NODE_OPTIONS;
  }
  return env;
}

async function runTgsConverterInNode(inputPath: string, outputPath: string): Promise<void> {
  const tgsModulePath = require.resolve('tgs-to');
  const yargsPackagePath = require.resolve('yargs/package.json', { paths: [require.resolve('@puppeteer/browsers')] });
  const yargsBuildPath = path.join(path.dirname(yargsPackagePath), 'build', 'index.cjs');
  const converterScript = `
const Module = require('node:module');
const [inputPath, outputPath, tgsModulePath, yargsBuildPath] = process.argv.slice(1);
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'yargs/yargs') {
    const { applyExtends, cjsPlatformShim, Parser, processArgv, Yargs } = originalLoad(yargsBuildPath, parent, isMain);
    Yargs.applyExtends = (config, cwd, mergeExtends) => applyExtends(config, cwd, mergeExtends, cjsPlatformShim);
    Yargs.hideBin = processArgv.hideBin;
    Yargs.Parser = Parser;
    return Yargs;
  }
  return originalLoad.apply(this, arguments);
};
(async () => {
  const TGS = require(tgsModulePath);
  const converter = new TGS(inputPath);
  await converter.convertToGif(outputPath);
})().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', converterScript, inputPath, outputPath, tgsModulePath, yargsBuildPath], {
      cwd: process.cwd(),
      env: createCleanNodeEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout = (stdout + String(chunk)).slice(-12_000);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = (stderr + String(chunk)).slice(-12_000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`TGS converter timeout after ${Math.round(CHILD_PROCESS_TIMEOUT_MS / 1000)}s`));
    }, CHILD_PROCESS_TIMEOUT_MS);
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const details = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      reject(new Error(`TGS converter child exit ${code}${details ? `\n${details}` : ''}`));
    });
  });
}

async function fileSize(filePath: string): Promise<number> {
  const { size } = await stat(filePath);
  return size;
}

function gifFilter(preset: GifPreset): string {
  return `fps=${preset.fps},scale=${preset.width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=${preset.colors}:reserve_transparent=on[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`;
}

/** Download a remote URL to a temp file. Returns the local file path. */
export async function downloadToTemp(url: string, fileName?: string, retries = 3): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });

  // Sanitize filename and add a unique prefix so concurrent downloads
  // with the same logical name (e.g. multiple 'photo.jpg' in a media group)
  // do not overwrite each other.
  const baseName = (fileName ?? `download_${Date.now()}`)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 128);

  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 500ms, 1500ms, ...
      await new Promise(r => setTimeout(r, 500 * attempt * attempt));
    }

    const filePath = path.join(TMP_DIR, `${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${baseName}`);
    try {
      const resp = await axios.get<NodeJS.ReadableStream>(url, {
        responseType: 'stream',
        timeout: 30_000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZaloTGBridge/1.0)' },
      });

      await new Promise<void>((resolve, reject) => {
        const writer = createWriteStream(filePath);
        resp.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      const { size } = await stat(filePath);
      if (size === 0) {
        await unlink(filePath).catch(() => undefined);
        lastErr = new Error(`Downloaded file is empty: ${url}`);
        continue;
      }

      return filePath;
    } catch (err) {
      await unlink(filePath).catch(() => undefined);
      lastErr = err;
    }
  }

  throw lastErr;
}

/** Remove a temp file, ignoring errors. */
export async function cleanTemp(filePath: string): Promise<void> {
  try { await unlink(filePath); } catch { /* ignore */ }
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
    '-vf', 'scale=\'min(512,iw)\':-1:flags=lanczos',
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
  for (const preset of VIDEO_GIF_PRESETS) {
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
  for (const preset of VIDEO_GIF_PRESETS) {
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
