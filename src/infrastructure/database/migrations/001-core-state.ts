import type { Migration } from './types.js';

export const coreStateMigration: Migration = {
  version: 1,
  name: 'core-state',
  sql: `
    CREATE TABLE topic_links (
      telegram_chat_id   INTEGER NOT NULL,
      telegram_topic_id  INTEGER NOT NULL,
      zalo_thread_id     TEXT NOT NULL,
      thread_type        INTEGER NOT NULL CHECK (thread_type IN (0, 1)),
      name               TEXT NOT NULL,
      source             TEXT NOT NULL DEFAULT 'runtime',
      updated_at         INTEGER NOT NULL,
      PRIMARY KEY (telegram_chat_id, telegram_topic_id),
      UNIQUE (telegram_chat_id, zalo_thread_id, thread_type),
      CHECK (telegram_topic_id > 1),
      CHECK (length(trim(zalo_thread_id)) > 0)
    );

    CREATE TABLE message_links (
      id                   INTEGER PRIMARY KEY,
      telegram_chat_id     INTEGER NOT NULL,
      telegram_message_id  INTEGER NOT NULL,
      conversation_key     TEXT NOT NULL,
      direction            TEXT NOT NULL CHECK (direction IN ('zalo_to_telegram', 'telegram_to_zalo')),
      quote_json            TEXT,
      source                TEXT NOT NULL DEFAULT 'runtime',
      created_at            INTEGER NOT NULL,
      UNIQUE (telegram_chat_id, telegram_message_id, direction)
    );

    CREATE TABLE message_aliases (
      conversation_key  TEXT NOT NULL,
      alias              TEXT NOT NULL,
      alias_kind         TEXT NOT NULL DEFAULT 'unknown',
      message_link_id    INTEGER NOT NULL REFERENCES message_links(id) ON DELETE CASCADE,
      created_at         INTEGER NOT NULL,
      PRIMARY KEY (conversation_key, alias),
      CHECK (length(trim(alias)) > 0),
      CHECK (alias <> '0')
    );

    CREATE INDEX idx_message_aliases_link ON message_aliases(message_link_id);

    CREATE TABLE app_settings (
      key         TEXT PRIMARY KEY,
      value_json  TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE poll_links (
      poll_id                   INTEGER PRIMARY KEY,
      zalo_group_id             TEXT NOT NULL,
      telegram_poll_message_id  INTEGER NOT NULL,
      telegram_score_message_id INTEGER NOT NULL,
      telegram_thread_id        INTEGER NOT NULL,
      payload_json              TEXT NOT NULL,
      updated_at                INTEGER NOT NULL
    );

    CREATE TABLE reaction_links (
      conversation_key   TEXT NOT NULL,
      zalo_message_id    TEXT NOT NULL,
      telegram_message_id INTEGER NOT NULL,
      payload_json       TEXT NOT NULL,
      updated_at         INTEGER NOT NULL,
      PRIMARY KEY (conversation_key, zalo_message_id)
    );

    CREATE TABLE conversation_policies (
      conversation_key  TEXT PRIMARY KEY,
      conversation_type TEXT NOT NULL CHECK (conversation_type IN ('group', 'friend_dm', 'stranger_dm')),
      muted              INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
      stranger_approved  INTEGER NOT NULL DEFAULT 0 CHECK (stranger_approved IN (0, 1)),
      mode               TEXT NOT NULL CHECK (mode IN ('normal', 'forward_silent', 'quarantine', 'blocked')),
      updated_at         INTEGER NOT NULL
    );
  `,
};
