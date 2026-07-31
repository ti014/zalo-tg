import type { Migration } from './types.js';

export const legacyImportMigration: Migration = {
  version: 2,
  name: 'legacy-import',
  sql: `
    CREATE TABLE legacy_imports (
      id                 INTEGER PRIMARY KEY,
      source_path        TEXT NOT NULL,
      source_sha256      TEXT NOT NULL,
      imported_at        INTEGER NOT NULL,
      records_read       INTEGER NOT NULL,
      records_imported   INTEGER NOT NULL,
      records_quarantined INTEGER NOT NULL,
      UNIQUE (source_path, source_sha256)
    );

    CREATE TABLE migration_quarantine (
      id            INTEGER PRIMARY KEY,
      source_path   TEXT NOT NULL,
      source_sha256 TEXT NOT NULL,
      record_key    TEXT,
      reason        TEXT NOT NULL,
      payload_json  TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE INDEX idx_migration_quarantine_source
      ON migration_quarantine(source_path, source_sha256);
  `,
};
