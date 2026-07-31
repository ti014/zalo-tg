import type { Migration } from './types.js';

export const deliveryReceiptsMigration: Migration = {
  version: 6,
  name: 'delivery-receipts',
  sql: `
    CREATE TABLE deliveries_v6 (
      id                   TEXT PRIMARY KEY,
      inbox_event_id       TEXT NOT NULL REFERENCES inbox_events(id) ON DELETE CASCADE,
      destination          TEXT NOT NULL CHECK (destination IN ('telegram', 'zalo')),
      conversation_key     TEXT NOT NULL,
      sequence_no          INTEGER NOT NULL CHECK (sequence_no >= 1),
      status               TEXT NOT NULL CHECK (status IN (
        'READY', 'SENDING', 'SENT', 'SKIPPED', 'RETRY',
        'UNKNOWN', 'PERMANENT_FAILED', 'DLQ'
      )),
      attempts             INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at      INTEGER NOT NULL,
      lease_owner          TEXT,
      lease_expires_at     INTEGER,
      provider_message_id  TEXT,
      last_error_code      TEXT,
      last_error_message   TEXT,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      UNIQUE (inbox_event_id, destination),
      UNIQUE (destination, conversation_key, sequence_no)
    );

    INSERT INTO deliveries_v6(
      id, inbox_event_id, destination, conversation_key, sequence_no,
      status, attempts, next_attempt_at, lease_owner, lease_expires_at,
      provider_message_id, last_error_code, last_error_message,
      created_at, updated_at
    )
    SELECT
      id, inbox_event_id, destination, conversation_key, sequence_no,
      status, attempts, next_attempt_at, lease_owner, lease_expires_at,
      provider_message_id, last_error_code, last_error_message,
      created_at, updated_at
    FROM deliveries;

    CREATE TABLE delivery_attempts_v6 (
      id                   INTEGER PRIMARY KEY,
      delivery_id          TEXT NOT NULL REFERENCES deliveries_v6(id) ON DELETE CASCADE,
      attempt_no           INTEGER NOT NULL,
      started_at           INTEGER NOT NULL,
      finished_at          INTEGER,
      outcome              TEXT NOT NULL CHECK (outcome IN (
        'SENDING', 'SENT', 'SKIPPED', 'RETRY',
        'UNKNOWN', 'PERMANENT_FAILED', 'DLQ'
      )),
      provider_message_id  TEXT,
      error_code           TEXT,
      error_message        TEXT,
      UNIQUE (delivery_id, attempt_no)
    );

    INSERT INTO delivery_attempts_v6(
      id, delivery_id, attempt_no, started_at, finished_at, outcome,
      provider_message_id, error_code, error_message
    )
    SELECT
      id, delivery_id, attempt_no, started_at, finished_at, outcome,
      provider_message_id, error_code, error_message
    FROM delivery_attempts;

    CREATE TABLE delivery_media_v6 (
      delivery_id  TEXT NOT NULL REFERENCES deliveries_v6(id) ON DELETE CASCADE,
      media_id     TEXT NOT NULL REFERENCES media_objects(id) ON DELETE RESTRICT,
      ordinal      INTEGER NOT NULL CHECK (ordinal >= 0),
      filename     TEXT NOT NULL,
      PRIMARY KEY (delivery_id, ordinal),
      UNIQUE (delivery_id, media_id)
    );

    INSERT INTO delivery_media_v6(delivery_id, media_id, ordinal, filename)
    SELECT delivery_id, media_id, ordinal, filename
    FROM delivery_media;

    CREATE TABLE delivery_operator_actions_v6 (
      id                         INTEGER PRIMARY KEY,
      delivery_id                TEXT NOT NULL REFERENCES deliveries_v6(id) ON DELETE CASCADE,
      actor_telegram_user_id      INTEGER NOT NULL CHECK (actor_telegram_user_id > 0),
      action                     TEXT NOT NULL CHECK (action IN ('retry', 'sent', 'dlq')),
      previous_status            TEXT NOT NULL CHECK (previous_status IN (
        'UNKNOWN', 'PERMANENT_FAILED', 'DLQ'
      )),
      reason                     TEXT,
      created_at                 INTEGER NOT NULL
    );

    INSERT INTO delivery_operator_actions_v6(
      id, delivery_id, actor_telegram_user_id, action,
      previous_status, reason, created_at
    )
    SELECT
      id, delivery_id, actor_telegram_user_id, action,
      previous_status, reason, created_at
    FROM delivery_operator_actions;

    DROP TABLE delivery_operator_actions;
    DROP TABLE delivery_media;
    DROP TABLE delivery_attempts;
    DROP TABLE deliveries;

    ALTER TABLE deliveries_v6 RENAME TO deliveries;
    ALTER TABLE delivery_attempts_v6 RENAME TO delivery_attempts;
    ALTER TABLE delivery_media_v6 RENAME TO delivery_media;
    ALTER TABLE delivery_operator_actions_v6 RENAME TO delivery_operator_actions;

    CREATE INDEX idx_deliveries_ready
      ON deliveries(destination, status, next_attempt_at, conversation_key, sequence_no);
    CREATE INDEX idx_deliveries_conversation
      ON deliveries(destination, conversation_key, sequence_no, status);
    CREATE INDEX idx_deliveries_lease
      ON deliveries(status, lease_expires_at);
    CREATE INDEX idx_delivery_operator_actions_delivery
      ON delivery_operator_actions(delivery_id, created_at, id);

    CREATE TABLE delivery_receipts (
      id                         INTEGER PRIMARY KEY,
      delivery_id                TEXT NOT NULL,
      attempt_no                 INTEGER NOT NULL,
      provider                   TEXT NOT NULL CHECK (provider IN ('telegram', 'zalo')),
      provider_message_id        TEXT NOT NULL,
      receipt_kind               TEXT NOT NULL CHECK (receipt_kind IN (
        'primary', 'attachment', 'part', 'poll', 'edit', 'auxiliary'
      )),
      ordinal                    INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
      is_primary                 INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
      provider_conversation_id   TEXT,
      provider_thread_id         TEXT,
      received_at                INTEGER NOT NULL,
      FOREIGN KEY (delivery_id, attempt_no)
        REFERENCES delivery_attempts(delivery_id, attempt_no) ON DELETE CASCADE,
      UNIQUE (delivery_id, attempt_no, receipt_kind, ordinal)
    );

    CREATE INDEX idx_delivery_receipts_delivery
      ON delivery_receipts(delivery_id, attempt_no, ordinal, id);

    CREATE TABLE delivery_skip_audits (
      delivery_id   TEXT PRIMARY KEY,
      attempt_no    INTEGER NOT NULL,
      reason_code   TEXT NOT NULL,
      reason        TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      FOREIGN KEY (delivery_id, attempt_no)
        REFERENCES delivery_attempts(delivery_id, attempt_no) ON DELETE CASCADE
    );
  `,
};
