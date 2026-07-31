import type { Migration } from './types.js';

export const durableDeliveryMigration: Migration = {
  version: 3,
  name: 'durable-delivery',
  sql: `
    CREATE TABLE inbox_events (
      id                TEXT PRIMARY KEY,
      source            TEXT NOT NULL CHECK (source IN ('telegram', 'zalo')),
      source_event_key  TEXT NOT NULL,
      conversation_key  TEXT NOT NULL,
      event_type        TEXT NOT NULL,
      payload_json      TEXT NOT NULL,
      received_at       INTEGER NOT NULL,
      UNIQUE (source, source_event_key)
    );

    CREATE TABLE conversation_sequences (
      destination       TEXT NOT NULL CHECK (destination IN ('telegram', 'zalo')),
      conversation_key  TEXT NOT NULL,
      next_sequence     INTEGER NOT NULL CHECK (next_sequence >= 1),
      PRIMARY KEY (destination, conversation_key)
    );

    CREATE TABLE deliveries (
      id                   TEXT PRIMARY KEY,
      inbox_event_id       TEXT NOT NULL REFERENCES inbox_events(id) ON DELETE CASCADE,
      destination          TEXT NOT NULL CHECK (destination IN ('telegram', 'zalo')),
      conversation_key     TEXT NOT NULL,
      sequence_no          INTEGER NOT NULL CHECK (sequence_no >= 1),
      status               TEXT NOT NULL CHECK (status IN (
        'READY', 'SENDING', 'SENT', 'RETRY', 'UNKNOWN', 'PERMANENT_FAILED', 'DLQ'
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

    CREATE INDEX idx_deliveries_ready
      ON deliveries(destination, status, next_attempt_at, conversation_key, sequence_no);
    CREATE INDEX idx_deliveries_conversation
      ON deliveries(destination, conversation_key, sequence_no, status);
    CREATE INDEX idx_deliveries_lease
      ON deliveries(status, lease_expires_at);

    CREATE TABLE delivery_attempts (
      id                   INTEGER PRIMARY KEY,
      delivery_id          TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
      attempt_no           INTEGER NOT NULL,
      started_at           INTEGER NOT NULL,
      finished_at          INTEGER,
      outcome              TEXT NOT NULL CHECK (outcome IN (
        'SENDING', 'SENT', 'RETRY', 'UNKNOWN', 'PERMANENT_FAILED', 'DLQ'
      )),
      provider_message_id  TEXT,
      error_code           TEXT,
      error_message        TEXT,
      UNIQUE (delivery_id, attempt_no)
    );

    CREATE TABLE instance_leases (
      lease_name   TEXT PRIMARY KEY,
      owner_id     TEXT NOT NULL,
      acquired_at  INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      CHECK (expires_at > acquired_at)
    );
  `,
};
