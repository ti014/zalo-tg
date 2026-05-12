import { mkdirSync, openSync, closeSync, unlinkSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';
import { config } from '../config.js';

export interface InstanceLock {
  release(): void;
}

interface LockFileData {
  pid?: number;
  startedAt?: string;
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== 'ESRCH';
  }
}

function readLockPid(lockPath: string): number | undefined {
  try {
    const data = JSON.parse(readFileSync(lockPath, 'utf8')) as LockFileData;
    return data.pid;
  } catch {
    return undefined;
  }
}

function tryOpenLock(lockPath: string): number {
  try {
    return openSync(lockPath, 'wx');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw err;

    const existingPid = readLockPid(lockPath);
    if (isProcessAlive(existingPid)) {
      throw new Error(`Bridge đang chạy ở process ${existingPid}. Hãy dừng process đó trước khi chạy instance mới.`);
    }

    try { unlinkSync(lockPath); } catch { /* ignore stale lock cleanup failure */ }
    return openSync(lockPath, 'wx');
  }
}

export function acquireInstanceLock(): InstanceLock {
  mkdirSync(config.dataDir, { recursive: true });
  const lockPath = path.join(config.dataDir, 'bridge.lock');
  const fd = tryOpenLock(lockPath);

  let released = false;
  writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));

  return {
    release(): void {
      if (released) return;
      released = true;
      try { closeSync(fd); } catch { /* ignore */ }
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    },
  };
}
