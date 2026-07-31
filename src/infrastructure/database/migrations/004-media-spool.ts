import type { Migration } from './types.js';

export const mediaSpoolMigration: Migration = {
  version: 4,
  name: 'media-spool',
  sql: `
    CREATE TABLE media_objects (
      id             TEXT PRIMARY KEY,
      sha256         TEXT,
      relative_path  TEXT NOT NULL UNIQUE,
      mime_type      TEXT,
      byte_size      INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
      status         TEXT NOT NULL CHECK (status IN ('DOWNLOADING', 'READY', 'FAILED', 'DELETED')),
      expires_at     INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX idx_media_objects_sha256
      ON media_objects(sha256) WHERE sha256 IS NOT NULL;
    CREATE INDEX idx_media_objects_expiry
      ON media_objects(status, expires_at);

    CREATE TABLE delivery_media (
      delivery_id  TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
      media_id     TEXT NOT NULL REFERENCES media_objects(id) ON DELETE RESTRICT,
      ordinal      INTEGER NOT NULL CHECK (ordinal >= 0),
      filename     TEXT NOT NULL,
      PRIMARY KEY (delivery_id, ordinal),
      UNIQUE (delivery_id, media_id)
    );
  `,
};
