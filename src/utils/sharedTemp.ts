import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';

const directoryCache = new Map<string, string>();

function safeSegment(value: string, fallback: string): string {
  const cleaned = value.normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

export function currentUserToken(
  getUid: (() => number) | undefined = typeof process.getuid === 'function'
    ? () => process.getuid!()
    : undefined,
  getUsername: () => string = () => os.userInfo().username,
): string {
  try {
    if (getUid) return String(getUid());
  } catch { /* Fall back to the portable username path. */ }
  try {
    return safeSegment(getUsername(), 'user');
  } catch {
    return 'user';
  }
}

function sharedDirMode(): number { return config.telegram.localServer ? 0o755 : 0o700; }
function sharedFileMode(): number { return config.telegram.localServer ? 0o644 : 0o600; }

function isWritableDirectory(directory: string): boolean {
  try {
    mkdirSync(directory, { recursive: true, mode: sharedDirMode() });
    try { chmodSync(directory, sharedDirMode()); } catch { /* best effort */ }
    accessSync(directory, constants.W_OK | constants.X_OK);
    const probe = path.join(directory, `.write-test-${process.pid}-${Date.now()}`);
    writeFileSync(probe, '', { mode: sharedFileMode() });
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

export function getSharedTempRoot(): string {
  const override = process.env.ZALO_TG_SHARED_TMP_ROOT?.trim();
  if (override) return path.resolve(override);
  if (config.telegram.localServer && process.platform !== 'win32') return '/tmp';
  return os.tmpdir();
}

export function getSharedTempDir(namespace = 'zalo-tg'): string {
  const root = getSharedTempRoot();
  const safeNamespace = safeSegment(namespace, 'zalo-tg');
  const cacheKey = `${root}\0${safeNamespace}\0${config.telegram.localServer ? 'local' : 'private'}`;
  const cached = directoryCache.get(cacheKey);
  if (cached && isWritableDirectory(cached)) return cached;

  const candidates = [
    path.join(root, safeNamespace),
    path.join(root, `${safeNamespace}-${currentUserToken()}`),
  ];
  for (const candidate of candidates) {
    if (isWritableDirectory(candidate)) {
      directoryCache.set(cacheKey, candidate);
      return candidate;
    }
  }

  try {
    const unique = mkdtempSync(path.join(root, `${safeNamespace}-${currentUserToken()}-`));
    if (isWritableDirectory(unique)) {
      directoryCache.set(cacheKey, unique);
      return unique;
    }
  } catch { /* Fall through to the actionable error below. */ }
  throw new Error(
    `Cannot create writable shared temp directory under ${root}. `
    + 'Check volume permissions or set ZALO_TG_SHARED_TMP_ROOT to a writable shared path.',
  );
}

export function createSharedTempPath(namespace: string, prefix: string, extension: string): string {
  const safePrefix = safeSegment(prefix, 'file');
  const safeExtension = extension
    ? `.${extension.replace(/^\.+/, '').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 16)}`
    : '';
  return path.join(
    getSharedTempDir(namespace),
    `${safePrefix}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 9)}${safeExtension}`,
  );
}

export function prepareSharedTempFile(filePath: string): void {
  try { chmodSync(filePath, sharedFileMode()); } catch { /* best effort */ }
}
