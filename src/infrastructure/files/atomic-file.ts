import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Write and fsync a sibling temp file before atomically replacing target. */
export function writeUtf8AtomicSync(targetPath: string, content: string): void {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tempPath, 'wx', 0o600);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tempPath, targetPath);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* ignore cleanup failure */ }
    }
    if (existsSync(tempPath)) {
      try { unlinkSync(tempPath); } catch { /* ignore cleanup failure */ }
    }
    throw error;
  }
}

export function writeJsonAtomicSync(targetPath: string, value: unknown, spaces?: number): void {
  writeUtf8AtomicSync(targetPath, JSON.stringify(value, null, spaces));
}
