import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parseBooleanFlag,
  parseNegativeSafeInteger,
  parseRequiredPositiveIntegerList,
  parseSafeInteger,
  requirePathWithinRoot,
  requireEnvValue,
} from './bootstrap/environment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Root của project (src/../) */
const PROJECT_ROOT = path.resolve(__dirname, '..');

function resolvePath(envVal: string | undefined, defaultRelative: string): string {
  const raw = envVal ?? defaultRelative;
  // Already absolute → use as-is, otherwise resolve from project root
  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
}

const DATA_DIR = resolvePath(process.env.DATA_DIR, 'data');
const DATABASE_PATH = resolvePath(process.env.DATABASE_PATH, path.join(DATA_DIR, 'bridge.db'));
const ZALO_CREDENTIALS_PATH = resolvePath(
  process.env.ZALO_CREDENTIALS_PATH,
  'credentials.json',
);

if (process.env.NODE_ENV === 'production') {
  requirePathWithinRoot(DATA_DIR, DATABASE_PATH, 'DATABASE_PATH');
  requirePathWithinRoot(DATA_DIR, ZALO_CREDENTIALS_PATH, 'ZALO_CREDENTIALS_PATH');
}

function parseMegabytes(key: string, defaultValue: number, maxValue = 200): number {
  const value = parseSafeInteger(process.env[key] ?? String(defaultValue), key, { positive: true });
  if (value > maxValue) throw new Error(`${key} must not exceed ${maxValue} MB`);
  return value * 1024 * 1024;
}

function parseSeconds(key: string, defaultValue: number, maxValue: number): number {
  const value = parseSafeInteger(process.env[key] ?? String(defaultValue), key, { positive: true });
  if (value > maxValue) throw new Error(`${key} must not exceed ${maxValue} seconds`);
  return value * 1_000;
}

function parseDays(key: string, defaultValue: number, maxValue: number): number {
  const value = parseSafeInteger(process.env[key] ?? String(defaultValue), key, { positive: true });
  if (value > maxValue) throw new Error(`${key} must not exceed ${maxValue} days`);
  return value * 24 * 60 * 60 * 1_000;
}

export const config = {
  telegram: {
    token:    requireEnvValue(process.env, 'TG_TOKEN'),
    groupId:  parseNegativeSafeInteger(requireEnvValue(process.env, 'TG_GROUP_ID'), 'TG_GROUP_ID'),
    ownerIds: new Set<number>(parseRequiredPositiveIntegerList(process.env, 'TG_OWNER_IDS')),
    apiRoot: process.env.TG_API_ROOT?.trim() || undefined,
    downloadMaxBytes: parseMegabytes('TG_DOWNLOAD_MAX_MB', 20, 200),
    uploadPartBytes: parseMegabytes('TG_UPLOAD_PART_MB', 45, 200),
    uploadTimeoutMs: parseSeconds('TG_UPLOAD_TIMEOUT_SEC', 600, 3_600),
  },
  zalo: {
    credentialsPath: ZALO_CREDENTIALS_PATH,
    skipMutedGroups: parseBooleanFlag(process.env.ZALO_SKIP_MUTED_GROUPS),
    skipStrangerMessages: parseBooleanFlag(process.env.ZALO_SKIP_STRANGER_MESSAGES),
  },
  runtime: {
    updateCheckerEnabled: parseBooleanFlag(
      process.env.UPDATE_CHECK_ENABLED,
      process.env.NODE_ENV !== 'production',
    ),
    healthDir: resolvePath(process.env.HEALTH_DIR, DATA_DIR),
    allowSecretBackup: parseBooleanFlag(process.env.ALLOW_SECRET_BACKUP, false),
  },
  media: {
    maxObjectBytes: parseMegabytes('MEDIA_MAX_OBJECT_MB', 200, 2_048),
    maxSpoolBytes: parseMegabytes('MEDIA_SPOOL_MAX_MB', 5_120, 102_400),
  },
  delivery: {
    sentRetentionMs: parseDays('DELIVERY_SENT_RETENTION_DAYS', 90, 3_650),
  },
  storage: {
    minFreeBytes: parseMegabytes('DATA_MIN_FREE_MB', 512, 1_048_576),
  },
  databasePath: DATABASE_PATH,
  dataDir: DATA_DIR,
} as const;

export function isOwner(userId: number | undefined): boolean {
  if (userId === undefined) return false;
  return config.telegram.ownerIds.has(userId);
}
