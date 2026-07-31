import type { Migration } from './types.js';

export const deliveryOperationsMigration: Migration = {
  version: 5,
  name: 'delivery-operations',
  sql: `
    CREATE TABLE delivery_operator_actions (
      id                         INTEGER PRIMARY KEY,
      delivery_id                TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
      actor_telegram_user_id      INTEGER NOT NULL CHECK (actor_telegram_user_id > 0),
      action                     TEXT NOT NULL CHECK (action IN ('retry', 'sent', 'dlq')),
      previous_status            TEXT NOT NULL CHECK (previous_status IN (
        'UNKNOWN', 'PERMANENT_FAILED', 'DLQ'
      )),
      reason                     TEXT,
      created_at                 INTEGER NOT NULL
    );

    CREATE INDEX idx_delivery_operator_actions_delivery
      ON delivery_operator_actions(delivery_id, created_at, id);
  `,
};
