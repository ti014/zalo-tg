import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function writePrivateTextFileSync(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(filePath, 0o600); } catch { /* Windows ACLs are authoritative. */ }
}

export function writePrivateJsonFileSync(filePath: string, value: unknown): void {
  writePrivateTextFileSync(filePath, JSON.stringify(value, null, 2));
}
