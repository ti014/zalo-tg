import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { migrations } from './migrations/index.js';
import type { Migration } from './migrations/types.js';

export type BridgeDatabase = Database.Database;

interface AppliedMigration {
  version: number;
  name: string;
  checksum: string;
}

function migrationChecksum(migration: Migration): string {
  return createHash('sha256')
    .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
    .digest('hex');
}

function applyMigrations(db: BridgeDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      checksum    TEXT NOT NULL,
      applied_at  INTEGER NOT NULL
    );
  `);

  const findApplied = db.prepare('SELECT version, name, checksum FROM schema_migrations WHERE version = ?');
  const insertApplied = db.prepare(`
    INSERT INTO schema_migrations(version, name, checksum, applied_at)
    VALUES (?, ?, ?, ?)
  `);

  for (const migration of migrations) {
    const checksum = migrationChecksum(migration);
    const applied = findApplied.get(migration.version) as AppliedMigration | undefined;
    if (applied) {
      if (applied.name !== migration.name || applied.checksum !== checksum) {
        throw new Error(`Migration ${migration.version} checksum mismatch; database history was modified.`);
      }
      continue;
    }

    db.transaction(() => {
      db.exec(migration.sql);
      insertApplied.run(migration.version, migration.name, checksum, Date.now());
    })();
  }
}

export function verifyDatabase(db: BridgeDatabase): void {
  const quickCheck = db.pragma('quick_check') as Array<Record<string, unknown>>;
  const result = String(quickCheck[0]?.quick_check ?? quickCheck[0]?.integrity_check ?? '');
  if (result.toLowerCase() !== 'ok') {
    throw new Error(`SQLite quick_check failed: ${result || 'unknown result'}`);
  }
  const foreignKeyErrors = db.pragma('foreign_key_check') as unknown[];
  if (foreignKeyErrors.length > 0) {
    throw new Error(`SQLite foreign_key_check found ${foreignKeyErrors.length} violation(s).`);
  }
}

function secureDatabaseFiles(databasePath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const filePath = `${databasePath}${suffix}`;
    if (existsSync(filePath)) chmodSync(filePath, 0o600);
  }
}

export function openBridgeDatabase(databasePath: string): BridgeDatabase {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new Database(databasePath, { timeout: 5_000 });
  try {
    secureDatabaseFiles(databasePath);
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = FULL');
    const journalMode = String(db.pragma('journal_mode = WAL', { simple: true })).toLowerCase();
    if (journalMode !== 'wal') throw new Error(`SQLite refused WAL mode: ${journalMode}`);
    applyMigrations(db);
    verifyDatabase(db);
    secureDatabaseFiles(databasePath);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function closeBridgeDatabase(db: BridgeDatabase): void {
  if (!db.open) return;
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}
