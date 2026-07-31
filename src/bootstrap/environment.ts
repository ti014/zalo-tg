export function requireEnvValue(
  env: NodeJS.ProcessEnv,
  key: string,
): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export function parseSafeInteger(
  raw: string,
  key: string,
  options: { positive?: boolean } = {},
): number {
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new Error(`${key} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (options.positive && value <= 0)) {
    throw new Error(`${key} must be a ${options.positive ? 'positive ' : ''}safe integer`);
  }
  return value;
}

export function parseNegativeSafeInteger(raw: string, key: string): number {
  const value = parseSafeInteger(raw, key);
  if (value >= 0) throw new Error(`${key} must be a negative safe integer`);
  return value;
}

export function parseRequiredPositiveIntegerList(
  env: NodeJS.ProcessEnv,
  key: string,
): number[] {
  const raw = requireEnvValue(env, key);
  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  const values = tokens.map(token => parseSafeInteger(token, key, { positive: true }));
  const unique = [...new Set(values)];
  if (unique.length === 0) throw new Error(`${key} must contain at least one ID`);
  return unique;
}

export function parseBooleanFlag(raw: string | undefined, defaultValue = false): boolean {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

export function requirePathWithinRoot(rootPath: string, targetPath: string, key: string): string {
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${key} must resolve to a file inside DATA_DIR`);
  }
  return target;
}
import path from 'node:path';
