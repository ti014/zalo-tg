import type { Migration } from './types.js';

export const telegramMultipartMigration: Migration = {
  version: 7,
  name: 'telegram-multipart',
  sql: `
    CREATE TABLE telegram_multipart_manifests (
      delivery_id              TEXT PRIMARY KEY REFERENCES deliveries(id) ON DELETE CASCADE,
      source_media_id          TEXT REFERENCES media_objects(id) ON DELETE SET NULL,
      source_sha256            TEXT NOT NULL CHECK (length(source_sha256) = 64),
      source_byte_size         INTEGER NOT NULL CHECK (source_byte_size > 0),
      original_filename        TEXT NOT NULL,
      part_size_bytes          INTEGER NOT NULL CHECK (part_size_bytes > 0),
      part_count               INTEGER NOT NULL CHECK (part_count >= 2),
      telegram_chat_id         TEXT NOT NULL,
      telegram_thread_id       INTEGER,
      disable_notification     INTEGER NOT NULL CHECK (disable_notification IN (0, 1)),
      reply_to_message_id      INTEGER,
      created_at               INTEGER NOT NULL,
      updated_at               INTEGER NOT NULL
    );

    CREATE TABLE telegram_multipart_parts (
      delivery_id          TEXT NOT NULL REFERENCES telegram_multipart_manifests(delivery_id)
                             ON DELETE CASCADE,
      part_no              INTEGER NOT NULL CHECK (part_no >= 1),
      byte_offset          INTEGER NOT NULL CHECK (byte_offset >= 0),
      byte_size            INTEGER NOT NULL CHECK (byte_size > 0),
      sha256               TEXT NOT NULL CHECK (length(sha256) = 64),
      provider_filename    TEXT NOT NULL,
      status               TEXT NOT NULL CHECK (status IN (
        'PENDING', 'SENDING', 'SENT', 'UNKNOWN'
      )),
      attempts             INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      provider_message_id  TEXT,
      last_error_code      TEXT,
      last_error_message   TEXT,
      sent_at              INTEGER,
      updated_at           INTEGER NOT NULL,
      PRIMARY KEY (delivery_id, part_no),
      UNIQUE (delivery_id, provider_filename),
      CHECK (
        (status = 'SENT' AND provider_message_id IS NOT NULL AND sent_at IS NOT NULL)
        OR status <> 'SENT'
      )
    );

    CREATE INDEX idx_telegram_multipart_parts_status
      ON telegram_multipart_parts(delivery_id, status, part_no);

    CREATE TABLE telegram_multipart_part_actions (
      id                         INTEGER PRIMARY KEY,
      delivery_id                TEXT NOT NULL,
      part_no                    INTEGER NOT NULL,
      actor_telegram_user_id      INTEGER NOT NULL CHECK (actor_telegram_user_id > 0),
      action                     TEXT NOT NULL CHECK (action IN ('sent', 'retry')),
      previous_status            TEXT NOT NULL CHECK (previous_status = 'UNKNOWN'),
      provider_message_id        TEXT,
      reason                     TEXT,
      created_at                 INTEGER NOT NULL,
      FOREIGN KEY (delivery_id, part_no)
        REFERENCES telegram_multipart_parts(delivery_id, part_no) ON DELETE CASCADE
    );

    CREATE INDEX idx_telegram_multipart_part_actions
      ON telegram_multipart_part_actions(delivery_id, part_no, created_at, id);
  `,
};
