import { coreStateMigration } from './001-core-state.js';
import { legacyImportMigration } from './002-legacy-import.js';
import { durableDeliveryMigration } from './003-durable-delivery.js';
import { mediaSpoolMigration } from './004-media-spool.js';
import { deliveryOperationsMigration } from './005-delivery-operations.js';
import { deliveryReceiptsMigration } from './006-delivery-receipts.js';
import { telegramMultipartMigration } from './007-telegram-multipart.js';
import { topicNameProvenanceMigration } from './008-topic-name-provenance.js';
import type { Migration } from './types.js';

export const migrations: readonly Migration[] = [
  coreStateMigration,
  legacyImportMigration,
  durableDeliveryMigration,
  mediaSpoolMigration,
  deliveryOperationsMigration,
  deliveryReceiptsMigration,
  telegramMultipartMigration,
  topicNameProvenanceMigration,
];
