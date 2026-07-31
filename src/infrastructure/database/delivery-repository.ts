import { randomUUID } from 'node:crypto';

import type { BridgeDatabase } from './database.js';

export type DeliverySource = 'telegram' | 'zalo';
export type DeliveryDestination = 'telegram' | 'zalo';
export type DeliveryStatus =
  | 'READY'
  | 'SENDING'
  | 'SENT'
  | 'SKIPPED'
  | 'RETRY'
  | 'UNKNOWN'
  | 'PERMANENT_FAILED'
  | 'DLQ';

export interface IngestAndEnqueueInput {
  source: DeliverySource;
  sourceEventKey: string;
  conversationKey: string;
  eventType: string;
  payload: unknown;
  destination: DeliveryDestination;
  receivedAt?: number;
  inboxEventId?: string;
  deliveryId?: string;
}

export interface IngestAndEnqueueOptions {
  equivalentReplay?: (storedPayload: unknown, incomingPayload: unknown) => boolean;
}

export interface DeliveryRecord {
  id: string;
  inboxEventId: string;
  source: DeliverySource;
  sourceEventKey: string;
  destination: DeliveryDestination;
  conversationKey: string;
  eventType: string;
  payload: unknown;
  sequenceNo: number;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  providerMessageId: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  receivedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface EnqueueResult {
  inboxEventId: string;
  delivery: DeliveryRecord;
  deduplicated: boolean;
}

export interface DeliveryFailure {
  code?: string;
  message?: string;
}

export interface DeliverySkip {
  code: string;
  message: string;
}

export interface ProviderReceiptInput {
  provider: DeliveryDestination;
  providerMessageId: string;
  receiptKind?: 'primary' | 'attachment' | 'part' | 'poll' | 'edit' | 'auxiliary';
  ordinal?: number;
  isPrimary?: boolean;
  providerConversationId?: string;
  providerThreadId?: string;
}

export interface ProviderReceiptRecord {
  id: number;
  deliveryId: string;
  attemptNo: number;
  provider: DeliveryDestination;
  providerMessageId: string;
  receiptKind: 'primary' | 'attachment' | 'part' | 'poll' | 'edit' | 'auxiliary';
  ordinal: number;
  isPrimary: boolean;
  providerConversationId: string | null;
  providerThreadId: string | null;
  receivedAt: number;
}

export interface DeliverySkipAuditRecord {
  deliveryId: string;
  attemptNo: number;
  reasonCode: string;
  reason: string;
  createdAt: number;
}

export interface TelegramMultipartPartInput {
  partNo: number;
  byteOffset: number;
  byteSize: number;
  sha256: string;
  providerFilename: string;
}

export interface TelegramMultipartManifestInput {
  sourceMediaId?: string;
  sourceSha256: string;
  sourceByteSize: number;
  originalFilename: string;
  partSizeBytes: number;
  telegramChatId: string;
  telegramThreadId?: number;
  disableNotification: boolean;
  replyToMessageId?: number;
  parts: TelegramMultipartPartInput[];
}

export interface TelegramMultipartManifestRecord {
  deliveryId: string;
  sourceMediaId: string | null;
  sourceSha256: string;
  sourceByteSize: number;
  originalFilename: string;
  partSizeBytes: number;
  partCount: number;
  telegramChatId: string;
  telegramThreadId: number | null;
  disableNotification: boolean;
  replyToMessageId: number | null;
  createdAt: number;
  updatedAt: number;
}

export type TelegramMultipartPartStatus = 'PENDING' | 'SENDING' | 'SENT' | 'UNKNOWN';

export interface TelegramMultipartPartRecord extends TelegramMultipartPartInput {
  deliveryId: string;
  status: TelegramMultipartPartStatus;
  attempts: number;
  providerMessageId: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  sentAt: number | null;
  updatedAt: number;
}

export interface TelegramMultipartPartResolution {
  actorTelegramUserId: number;
  reason?: string;
  providerMessageId?: string;
}

export interface RetryBackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
}

export interface MarkRetryOptions extends DeliveryFailure {
  retryAfterMs?: number;
  backoff?: RetryBackoffOptions;
}

export interface DeliveryStatusCount {
  status: DeliveryStatus;
  count: number;
}

export interface DeliveryAttemptRecord {
  attemptNo: number;
  startedAt: number;
  finishedAt: number | null;
  outcome: Exclude<DeliveryStatus, 'READY'>;
  providerMessageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface DeliveryOperatorResolution {
  actorTelegramUserId: number;
  reason?: string;
}

export interface DeliveryOperatorActionRecord {
  action: 'retry' | 'sent' | 'dlq';
  previousStatus: 'UNKNOWN' | 'PERMANENT_FAILED' | 'DLQ';
  actorTelegramUserId: number;
  reason: string | null;
  createdAt: number;
}

interface RawInboxRow {
  id: string;
  conversation_key: string;
  event_type: string;
  payload_json: string;
}

interface RawDeliveryRow {
  id: string;
  inbox_event_id: string;
  source: DeliverySource;
  source_event_key: string;
  destination: DeliveryDestination;
  conversation_key: string;
  event_type: string;
  payload_json: string;
  sequence_no: number;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  provider_message_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  received_at: number;
  created_at: number;
  updated_at: number;
}

interface ActiveLeaseRow {
  id: string;
  attempts: number;
  destination: DeliveryDestination;
  provider_message_id: string | null;
}

interface TransitionOptions {
  status: Exclude<DeliveryStatus, 'READY' | 'SENDING'>;
  providerMessageId?: string;
  error?: DeliveryFailure;
  skip?: DeliverySkip;
  nextAttemptAt: number | ((attempt: number) => number);
}

interface RawProviderReceiptRow {
  id: number;
  delivery_id: string;
  attempt_no: number;
  provider: DeliveryDestination;
  provider_message_id: string;
  receipt_kind: ProviderReceiptRecord['receiptKind'];
  ordinal: number;
  is_primary: 0 | 1;
  provider_conversation_id: string | null;
  provider_thread_id: string | null;
  received_at: number;
}

interface RawTelegramMultipartManifestRow {
  delivery_id: string;
  source_media_id: string | null;
  source_sha256: string;
  source_byte_size: number;
  original_filename: string;
  part_size_bytes: number;
  part_count: number;
  telegram_chat_id: string;
  telegram_thread_id: number | null;
  disable_notification: 0 | 1;
  reply_to_message_id: number | null;
  created_at: number;
  updated_at: number;
}

interface RawTelegramMultipartPartRow {
  delivery_id: string;
  part_no: number;
  byte_offset: number;
  byte_size: number;
  sha256: string;
  provider_filename: string;
  status: TelegramMultipartPartStatus;
  attempts: number;
  provider_message_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  sent_at: number | null;
  updated_at: number;
}

const DELIVERY_SELECT = `
  SELECT
    d.id,
    d.inbox_event_id,
    i.source,
    i.source_event_key,
    d.destination,
    d.conversation_key,
    i.event_type,
    i.payload_json,
    d.sequence_no,
    d.status,
    d.attempts,
    d.next_attempt_at,
    d.lease_owner,
    d.lease_expires_at,
    d.provider_message_id,
    d.last_error_code,
    d.last_error_message,
    i.received_at,
    d.created_at,
    d.updated_at
  FROM deliveries d
  JOIN inbox_events i ON i.id = d.inbox_event_id
`;

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  return normalized;
}

function requireTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requireNonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function requireSha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a lowercase SHA-256 hex digest.`);
  }
  return normalized;
}

function optionalNonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  return requireNonEmpty(value, 'optional value');
}

function toProviderReceipt(row: RawProviderReceiptRow): ProviderReceiptRecord {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    attemptNo: row.attempt_no,
    provider: row.provider,
    providerMessageId: row.provider_message_id,
    receiptKind: row.receipt_kind,
    ordinal: row.ordinal,
    isPrimary: row.is_primary === 1,
    providerConversationId: row.provider_conversation_id,
    providerThreadId: row.provider_thread_id,
    receivedAt: row.received_at,
  };
}

function toTelegramMultipartManifest(
  row: RawTelegramMultipartManifestRow,
): TelegramMultipartManifestRecord {
  return {
    deliveryId: row.delivery_id,
    sourceMediaId: row.source_media_id,
    sourceSha256: row.source_sha256,
    sourceByteSize: row.source_byte_size,
    originalFilename: row.original_filename,
    partSizeBytes: row.part_size_bytes,
    partCount: row.part_count,
    telegramChatId: row.telegram_chat_id,
    telegramThreadId: row.telegram_thread_id,
    disableNotification: row.disable_notification === 1,
    replyToMessageId: row.reply_to_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTelegramMultipartPart(
  row: RawTelegramMultipartPartRow,
): TelegramMultipartPartRecord {
  return {
    deliveryId: row.delivery_id,
    partNo: row.part_no,
    byteOffset: row.byte_offset,
    byteSize: row.byte_size,
    sha256: row.sha256,
    providerFilename: row.provider_filename,
    status: row.status,
    attempts: row.attempts,
    providerMessageId: row.provider_message_id,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    sentAt: row.sent_at,
    updatedAt: row.updated_at,
  };
}

function serializePayload(payload: unknown): string {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) {
    throw new Error('payload must be JSON-serializable.');
  }
  return serialized;
}

function parsePayload(payloadJson: string): unknown {
  try {
    return JSON.parse(payloadJson) as unknown;
  } catch (error) {
    throw new Error(`Stored delivery payload is invalid JSON: ${(error as Error).message}`);
  }
}

function toDeliveryRecord(row: RawDeliveryRow): DeliveryRecord {
  return {
    id: row.id,
    inboxEventId: row.inbox_event_id,
    source: row.source,
    sourceEventKey: row.source_event_key,
    destination: row.destination,
    conversationKey: row.conversation_key,
    eventType: row.event_type,
    payload: parsePayload(row.payload_json),
    sequenceNo: row.sequence_no,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    providerMessageId: row.provider_message_id,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    receivedAt: row.received_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Calculates bounded exponential backoff with symmetric jitter.
 *
 * Attempt one waits `baseDelayMs`; each following attempt doubles the delay
 * until `maxDelayMs`. A `random` callback can be injected for deterministic
 * tests.
 */
export function computeRetryDelayMs(
  attempt: number,
  options: RetryBackoffOptions = {},
): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error('attempt must be a positive safe integer.');
  }

  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 5 * 60_000;
  const jitterRatio = options.jitterRatio ?? 0.2;
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new Error('baseDelayMs must be a non-negative finite number.');
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < baseDelayMs) {
    throw new Error('maxDelayMs must be finite and at least baseDelayMs.');
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error('jitterRatio must be between 0 and 1.');
  }

  const exponent = Math.min(attempt - 1, 52);
  const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** exponent));
  const randomValue = (options.random ?? Math.random)();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue > 1) {
    throw new Error('random must return a value between 0 and 1.');
  }

  const jitter = exponentialDelay * jitterRatio;
  return Math.round(exponentialDelay - jitter + (2 * jitter * randomValue));
}

export class DeliveryRepository {
  constructor(
    private readonly db: BridgeDatabase,
    private readonly createId: () => string = randomUUID,
  ) {}

  ingestAndEnqueue(
    input: IngestAndEnqueueInput,
    options: IngestAndEnqueueOptions = {},
  ): EnqueueResult {
    const sourceEventKey = requireNonEmpty(input.sourceEventKey, 'sourceEventKey');
    const conversationKey = requireNonEmpty(input.conversationKey, 'conversationKey');
    const eventType = requireNonEmpty(input.eventType, 'eventType');
    const payloadJson = serializePayload(input.payload);
    const receivedAt = requireTimestamp(input.receivedAt ?? Date.now(), 'receivedAt');

    const run = this.db.transaction((): EnqueueResult => {
      let inbox = this.db.prepare(`
        SELECT id, conversation_key, event_type, payload_json
        FROM inbox_events
        WHERE source = ? AND source_event_key = ?
      `).get(input.source, sourceEventKey) as RawInboxRow | undefined;

      if (inbox) {
        const sameMetadata = inbox.conversation_key === conversationKey
          && inbox.event_type === eventType;
        const equivalentPayload = inbox.payload_json === payloadJson
          || (sameMetadata
            && options.equivalentReplay?.(parsePayload(inbox.payload_json), input.payload) === true);
        if (!sameMetadata || !equivalentPayload) {
          throw new Error(
            `Idempotency conflict for ${input.source}:${sourceEventKey}; stored event differs from input.`,
          );
        }

        const existing = this.getByInboxAndDestination(inbox.id, input.destination);
        if (existing) {
          return {
            inboxEventId: inbox.id,
            delivery: existing,
            deduplicated: true,
          };
        }
      } else {
        const inboxEventId = requireNonEmpty(input.inboxEventId ?? this.createId(), 'inboxEventId');
        this.db.prepare(`
          INSERT INTO inbox_events(
            id, source, source_event_key, conversation_key, event_type, payload_json, received_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          inboxEventId,
          input.source,
          sourceEventKey,
          conversationKey,
          eventType,
          payloadJson,
          receivedAt,
        );
        inbox = {
          id: inboxEventId,
          conversation_key: conversationKey,
          event_type: eventType,
          payload_json: payloadJson,
        };
      }

      const sequenceRow = this.db.prepare(`
        SELECT next_sequence
        FROM conversation_sequences
        WHERE destination = ? AND conversation_key = ?
      `).get(input.destination, conversationKey) as { next_sequence: number } | undefined;

      const sequenceNo = sequenceRow?.next_sequence ?? 1;
      if (sequenceRow) {
        this.db.prepare(`
          UPDATE conversation_sequences
          SET next_sequence = ?
          WHERE destination = ? AND conversation_key = ?
        `).run(sequenceNo + 1, input.destination, conversationKey);
      } else {
        this.db.prepare(`
          INSERT INTO conversation_sequences(destination, conversation_key, next_sequence)
          VALUES (?, ?, ?)
        `).run(input.destination, conversationKey, 2);
      }

      const deliveryId = requireNonEmpty(input.deliveryId ?? this.createId(), 'deliveryId');
      this.db.prepare(`
        INSERT INTO deliveries(
          id, inbox_event_id, destination, conversation_key, sequence_no,
          status, attempts, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'READY', 0, ?, ?, ?)
      `).run(
        deliveryId,
        inbox.id,
        input.destination,
        conversationKey,
        sequenceNo,
        receivedAt,
        receivedAt,
        receivedAt,
      );

      return {
        inboxEventId: inbox.id,
        delivery: this.requireById(deliveryId),
        deduplicated: false,
      };
    });

    return run.immediate();
  }

  getTelegramMultipartManifest(
    deliveryId: string,
  ): TelegramMultipartManifestRecord | undefined {
    const normalizedDeliveryId = requireNonEmpty(deliveryId, 'deliveryId');
    const row = this.db.prepare(`
      SELECT *
      FROM telegram_multipart_manifests
      WHERE delivery_id = ?
    `).get(normalizedDeliveryId) as RawTelegramMultipartManifestRow | undefined;
    return row ? toTelegramMultipartManifest(row) : undefined;
  }

  listTelegramMultipartParts(deliveryId: string): TelegramMultipartPartRecord[] {
    const normalizedDeliveryId = requireNonEmpty(deliveryId, 'deliveryId');
    const rows = this.db.prepare(`
      SELECT *
      FROM telegram_multipart_parts
      WHERE delivery_id = ?
      ORDER BY part_no
    `).all(normalizedDeliveryId) as RawTelegramMultipartPartRow[];
    return rows.map(toTelegramMultipartPart);
  }

  ensureTelegramMultipartManifest(
    deliveryId: string,
    owner: string,
    now: number,
    input: TelegramMultipartManifestInput,
  ): TelegramMultipartManifestRecord {
    const normalizedDeliveryId = requireNonEmpty(deliveryId, 'deliveryId');
    const leaseOwner = requireNonEmpty(owner, 'owner');
    requireTimestamp(now, 'now');
    const sourceSha256 = requireSha256(input.sourceSha256, 'sourceSha256');
    const sourceByteSize = requirePositiveSafeInteger(
      input.sourceByteSize,
      'sourceByteSize',
    );
    const originalFilename = requireNonEmpty(
      input.originalFilename,
      'originalFilename',
    );
    const partSizeBytes = requirePositiveSafeInteger(
      input.partSizeBytes,
      'partSizeBytes',
    );
    const telegramChatId = requireNonEmpty(input.telegramChatId, 'telegramChatId');
    const telegramThreadId = input.telegramThreadId === undefined
      ? null
      : requirePositiveSafeInteger(input.telegramThreadId, 'telegramThreadId');
    const replyToMessageId = input.replyToMessageId === undefined
      ? null
      : requirePositiveSafeInteger(input.replyToMessageId, 'replyToMessageId');
    const sourceMediaId = input.sourceMediaId === undefined
      ? null
      : requireNonEmpty(input.sourceMediaId, 'sourceMediaId');
    if (input.parts.length < 2) {
      throw new Error('A Telegram multipart manifest requires at least two parts.');
    }
    const expectedPartCount = Math.ceil(sourceByteSize / partSizeBytes);
    if (input.parts.length !== expectedPartCount) {
      throw new Error('Multipart part count does not match source size and part size.');
    }
    const parts = input.parts.map((part, index): TelegramMultipartPartInput => {
      const partNo = requirePositiveSafeInteger(part.partNo, 'partNo');
      const byteOffset = requireNonNegativeSafeInteger(part.byteOffset, 'byteOffset');
      const byteSize = requirePositiveSafeInteger(part.byteSize, 'byteSize');
      if (partNo !== index + 1) {
        throw new Error('Multipart parts must be ordered and contiguous from part 1.');
      }
      const expectedOffset = index * partSizeBytes;
      const expectedSize = Math.min(partSizeBytes, sourceByteSize - expectedOffset);
      if (byteOffset !== expectedOffset || byteSize !== expectedSize) {
        throw new Error(`Multipart byte range is invalid for part ${partNo}.`);
      }
      return {
        partNo,
        byteOffset,
        byteSize,
        sha256: requireSha256(part.sha256, `parts[${index}].sha256`),
        providerFilename: requireNonEmpty(
          part.providerFilename,
          `parts[${index}].providerFilename`,
        ),
      };
    });

    const run = this.db.transaction((): TelegramMultipartManifestRecord => {
      const active = this.db.prepare(`
        SELECT id
        FROM deliveries
        WHERE id = ? AND status = 'SENDING' AND lease_owner = ?
      `).get(normalizedDeliveryId, leaseOwner) as { id: string } | undefined;
      if (!active) {
        throw new Error(
          `Delivery ${normalizedDeliveryId} is not leased by ${leaseOwner}.`,
        );
      }

      const existing = this.getTelegramMultipartManifest(normalizedDeliveryId);
      if (existing) {
        const existingParts = this.listTelegramMultipartParts(normalizedDeliveryId);
        const sameManifest = existing.sourceMediaId === sourceMediaId
          && existing.sourceSha256 === sourceSha256
          && existing.sourceByteSize === sourceByteSize
          && existing.originalFilename === originalFilename
          && existing.partSizeBytes === partSizeBytes
          && existing.partCount === parts.length
          && existing.telegramChatId === telegramChatId
          && existing.telegramThreadId === telegramThreadId
          && existing.disableNotification === input.disableNotification
          && existing.replyToMessageId === replyToMessageId;
        const sameParts = existingParts.length === parts.length
          && existingParts.every((existingPart, index) => {
            const expected = parts[index]!;
            return existingPart.partNo === expected.partNo
              && existingPart.byteOffset === expected.byteOffset
              && existingPart.byteSize === expected.byteSize
              && existingPart.sha256 === expected.sha256
              && existingPart.providerFilename === expected.providerFilename;
          });
        if (!sameManifest || !sameParts) {
          throw Object.assign(
            new Error('Multipart manifest differs from the durable delivery plan.'),
            { code: 'PART_MANIFEST_MISMATCH' },
          );
        }
        return existing;
      }

      this.db.prepare(`
        INSERT INTO telegram_multipart_manifests(
          delivery_id, source_media_id, source_sha256, source_byte_size,
          original_filename, part_size_bytes, part_count,
          telegram_chat_id, telegram_thread_id, disable_notification,
          reply_to_message_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalizedDeliveryId,
        sourceMediaId,
        sourceSha256,
        sourceByteSize,
        originalFilename,
        partSizeBytes,
        parts.length,
        telegramChatId,
        telegramThreadId,
        input.disableNotification ? 1 : 0,
        replyToMessageId,
        now,
        now,
      );
      const insertPart = this.db.prepare(`
        INSERT INTO telegram_multipart_parts(
          delivery_id, part_no, byte_offset, byte_size, sha256,
          provider_filename, status, attempts, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, ?)
      `);
      for (const part of parts) {
        insertPart.run(
          normalizedDeliveryId,
          part.partNo,
          part.byteOffset,
          part.byteSize,
          part.sha256,
          part.providerFilename,
          now,
        );
      }
      const created = this.getTelegramMultipartManifest(normalizedDeliveryId);
      if (!created) throw new Error('Multipart manifest disappeared after insert.');
      return created;
    });
    return run.immediate();
  }

  markTelegramMultipartPartSending(
    deliveryId: string,
    owner: string,
    partNo: number,
    now: number,
  ): TelegramMultipartPartRecord {
    const normalizedDeliveryId = requireNonEmpty(deliveryId, 'deliveryId');
    const leaseOwner = requireNonEmpty(owner, 'owner');
    requirePositiveSafeInteger(partNo, 'partNo');
    requireTimestamp(now, 'now');
    const run = this.db.transaction((): TelegramMultipartPartRecord => {
      const active = this.db.prepare(`
        SELECT id FROM deliveries
        WHERE id = ? AND status = 'SENDING' AND lease_owner = ?
      `).get(normalizedDeliveryId, leaseOwner);
      if (!active) {
        throw new Error(
          `Delivery ${normalizedDeliveryId} is not leased by ${leaseOwner}.`,
        );
      }
      const update = this.db.prepare(`
        UPDATE telegram_multipart_parts
        SET status = 'SENDING',
            attempts = attempts + 1,
            last_error_code = NULL,
            last_error_message = NULL,
            updated_at = ?
        WHERE delivery_id = ? AND part_no = ? AND status = 'PENDING'
      `).run(now, normalizedDeliveryId, partNo);
      if (update.changes !== 1) {
        throw new Error(
          `Multipart part ${partNo} is not PENDING for delivery ${normalizedDeliveryId}.`,
        );
      }
      return this.requireTelegramMultipartPart(normalizedDeliveryId, partNo);
    });
    return run.immediate();
  }

  markTelegramMultipartPartFailure(
    deliveryId: string,
    owner: string,
    partNo: number,
    now: number,
    outcome: 'PENDING' | 'UNKNOWN',
    error: DeliveryFailure,
  ): TelegramMultipartPartRecord {
    const normalizedDeliveryId = requireNonEmpty(deliveryId, 'deliveryId');
    const leaseOwner = requireNonEmpty(owner, 'owner');
    requirePositiveSafeInteger(partNo, 'partNo');
    requireTimestamp(now, 'now');
    const run = this.db.transaction((): TelegramMultipartPartRecord => {
      const active = this.db.prepare(`
        SELECT id FROM deliveries
        WHERE id = ? AND status = 'SENDING' AND lease_owner = ?
      `).get(normalizedDeliveryId, leaseOwner);
      if (!active) {
        throw new Error(
          `Delivery ${normalizedDeliveryId} is not leased by ${leaseOwner}.`,
        );
      }
      const update = this.db.prepare(`
        UPDATE telegram_multipart_parts
        SET status = ?,
            last_error_code = ?,
            last_error_message = ?,
            updated_at = ?
        WHERE delivery_id = ? AND part_no = ? AND status = 'SENDING'
      `).run(
        outcome,
        error.code ?? null,
        error.message ?? null,
        now,
        normalizedDeliveryId,
        partNo,
      );
      if (update.changes !== 1) {
        throw new Error(
          `Multipart part ${partNo} is not SENDING for delivery ${normalizedDeliveryId}.`,
        );
      }
      return this.requireTelegramMultipartPart(normalizedDeliveryId, partNo);
    });
    return run.immediate();
  }

  leaseNext(
    destination: DeliveryDestination,
    owner: string,
    now: number,
    leaseMs: number,
  ): DeliveryRecord | undefined {
    const leaseOwner = requireNonEmpty(owner, 'owner');
    requireTimestamp(now, 'now');
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
      throw new Error('leaseMs must be a positive safe integer.');
    }
    const leaseExpiresAt = requireTimestamp(now + leaseMs, 'leaseExpiresAt');

    const run = this.db.transaction((): DeliveryRecord | undefined => {
      const candidate = this.db.prepare(`
        SELECT d.id
        FROM deliveries d
        WHERE d.destination = ?
          AND d.status IN ('READY', 'RETRY')
          AND d.next_attempt_at <= ?
          AND NOT EXISTS (
            SELECT 1
            FROM deliveries prior
            WHERE prior.destination = d.destination
              AND prior.conversation_key = d.conversation_key
              AND prior.sequence_no < d.sequence_no
              AND prior.status NOT IN ('SENT', 'SKIPPED', 'PERMANENT_FAILED', 'DLQ')
          )
        ORDER BY d.next_attempt_at, d.created_at, d.conversation_key, d.sequence_no
        LIMIT 1
      `).get(destination, now) as { id: string } | undefined;
      if (!candidate) return undefined;

      const update = this.db.prepare(`
        UPDATE deliveries
        SET status = 'SENDING',
            attempts = attempts + 1,
            lease_owner = ?,
            lease_expires_at = ?,
            updated_at = ?
        WHERE id = ?
          AND status IN ('READY', 'RETRY')
          AND next_attempt_at <= ?
      `).run(leaseOwner, leaseExpiresAt, now, candidate.id, now);
      if (update.changes !== 1) return undefined;

      const leased = this.requireById(candidate.id);
      this.db.prepare(`
        INSERT INTO delivery_attempts(
          delivery_id, attempt_no, started_at, outcome
        ) VALUES (?, ?, ?, 'SENDING')
      `).run(leased.id, leased.attempts, now);
      return leased;
    });

    return run.immediate();
  }

  recordProviderReceipt(
    deliveryId: string,
    owner: string,
    now: number,
    input: ProviderReceiptInput,
  ): ProviderReceiptRecord {
    const normalizedDeliveryId = requireNonEmpty(deliveryId, 'deliveryId');
    const leaseOwner = requireNonEmpty(owner, 'owner');
    requireTimestamp(now, 'now');
    const providerMessageId = requireNonEmpty(
      input.providerMessageId,
      'providerMessageId',
    );
    const receiptKind = input.receiptKind ?? 'primary';
    const ordinal = input.ordinal ?? 0;
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
      throw new Error('receipt ordinal must be a non-negative safe integer.');
    }
    const isPrimary = input.isPrimary ?? receiptKind === 'primary';
    const providerConversationId = input.providerConversationId === undefined
      ? null
      : requireNonEmpty(input.providerConversationId, 'providerConversationId');
    const providerThreadId = input.providerThreadId === undefined
      ? null
      : requireNonEmpty(input.providerThreadId, 'providerThreadId');

    const run = this.db.transaction((): ProviderReceiptRecord => {
      const active = this.db.prepare(`
        SELECT id, attempts, destination, provider_message_id
        FROM deliveries
        WHERE id = ? AND status = 'SENDING' AND lease_owner = ?
      `).get(normalizedDeliveryId, leaseOwner) as ActiveLeaseRow | undefined;
      if (!active) {
        throw new Error(
          `Delivery ${normalizedDeliveryId} is not leased by ${leaseOwner}.`,
        );
      }
      if (active.destination !== input.provider) {
        throw new Error(
          `Receipt provider ${input.provider} does not match destination ${active.destination}.`,
        );
      }

      const existing = this.db.prepare(`
        SELECT *
        FROM delivery_receipts
        WHERE delivery_id = ?
          AND attempt_no = ?
          AND receipt_kind = ?
          AND ordinal = ?
      `).get(
        normalizedDeliveryId,
        active.attempts,
        receiptKind,
        ordinal,
      ) as RawProviderReceiptRow | undefined;
      if (existing) {
        const same = existing.provider === input.provider
          && existing.provider_message_id === providerMessageId
          && existing.is_primary === (isPrimary ? 1 : 0)
          && existing.provider_conversation_id === providerConversationId
          && existing.provider_thread_id === providerThreadId;
        if (!same) {
          throw new Error(
            `Receipt conflict for delivery ${normalizedDeliveryId} attempt `
            + `${active.attempts} ${receiptKind}:${ordinal}.`,
          );
        }
        return toProviderReceipt(existing);
      }

      if (
        isPrimary
        && active.provider_message_id !== null
        && active.provider_message_id !== providerMessageId
      ) {
        throw new Error(
          `Primary provider receipt conflicts for delivery ${normalizedDeliveryId}.`,
        );
      }
      if (receiptKind === 'part') {
        const part = this.requireTelegramMultipartPart(
          normalizedDeliveryId,
          ordinal + 1,
        );
        if (part.status !== 'SENDING') {
          throw new Error(
            `Multipart part ${part.partNo} is not SENDING for receipt recording.`,
          );
        }
      }

      const inserted = this.db.prepare(`
        INSERT INTO delivery_receipts(
          delivery_id, attempt_no, provider, provider_message_id,
          receipt_kind, ordinal, is_primary,
          provider_conversation_id, provider_thread_id, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalizedDeliveryId,
        active.attempts,
        input.provider,
        providerMessageId,
        receiptKind,
        ordinal,
        isPrimary ? 1 : 0,
        providerConversationId,
        providerThreadId,
        now,
      );

      if (receiptKind === 'part') {
        const partUpdate = this.db.prepare(`
          UPDATE telegram_multipart_parts
          SET status = 'SENT',
              provider_message_id = ?,
              last_error_code = NULL,
              last_error_message = NULL,
              sent_at = ?,
              updated_at = ?
          WHERE delivery_id = ? AND part_no = ? AND status = 'SENDING'
        `).run(
          providerMessageId,
          now,
          now,
          normalizedDeliveryId,
          ordinal + 1,
        );
        if (partUpdate.changes !== 1) {
          throw new Error(
            `Multipart part ${ordinal + 1} changed while recording its receipt.`,
          );
        }
      }

      if (isPrimary) {
        this.db.prepare(`
          UPDATE deliveries
          SET provider_message_id = COALESCE(provider_message_id, ?),
              updated_at = ?
          WHERE id = ? AND status = 'SENDING' AND lease_owner = ?
        `).run(providerMessageId, now, normalizedDeliveryId, leaseOwner);
        this.db.prepare(`
          UPDATE delivery_attempts
          SET provider_message_id = COALESCE(provider_message_id, ?)
          WHERE delivery_id = ? AND attempt_no = ? AND outcome = 'SENDING'
        `).run(providerMessageId, normalizedDeliveryId, active.attempts);
      }

      const row = this.db.prepare(`
        SELECT * FROM delivery_receipts WHERE id = ?
      `).get(Number(inserted.lastInsertRowid)) as RawProviderReceiptRow | undefined;
      if (!row) throw new Error('Provider receipt disappeared after insert.');
      return toProviderReceipt(row);
    });

    return run.immediate();
  }

  hasProviderReceipts(deliveryId: string, attemptNo?: number): boolean {
    const normalizedDeliveryId = requireNonEmpty(deliveryId, 'deliveryId');
    if (attemptNo !== undefined && (!Number.isSafeInteger(attemptNo) || attemptNo < 1)) {
      throw new Error('attemptNo must be a positive safe integer.');
    }
    const row = attemptNo === undefined
      ? this.db.prepare(`
        SELECT count(*) AS count FROM delivery_receipts WHERE delivery_id = ?
      `).get(normalizedDeliveryId)
      : this.db.prepare(`
        SELECT count(*) AS count
        FROM delivery_receipts
        WHERE delivery_id = ? AND attempt_no = ?
      `).get(normalizedDeliveryId, attemptNo);
    return Number((row as { count: number }).count) > 0;
  }

  listProviderReceipts(deliveryId: string, limit = 100): ProviderReceiptRecord[] {
    const normalizedDeliveryId = requireNonEmpty(deliveryId, 'deliveryId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('receipt limit must be between 1 and 1000.');
    }
    const rows = this.db.prepare(`
      SELECT *
      FROM delivery_receipts
      WHERE delivery_id = ?
      ORDER BY attempt_no, ordinal, id
      LIMIT ?
    `).all(normalizedDeliveryId, limit) as RawProviderReceiptRow[];
    return rows.map(toProviderReceipt);
  }

  getSkipAudit(deliveryId: string): DeliverySkipAuditRecord | undefined {
    const normalizedDeliveryId = requireNonEmpty(deliveryId, 'deliveryId');
    const row = this.db.prepare(`
      SELECT delivery_id, attempt_no, reason_code, reason, created_at
      FROM delivery_skip_audits
      WHERE delivery_id = ?
    `).get(normalizedDeliveryId) as {
      delivery_id: string;
      attempt_no: number;
      reason_code: string;
      reason: string;
      created_at: number;
    } | undefined;
    return row ? {
      deliveryId: row.delivery_id,
      attemptNo: row.attempt_no,
      reasonCode: row.reason_code,
      reason: row.reason,
      createdAt: row.created_at,
    } : undefined;
  }

  markSent(
    deliveryId: string,
    owner: string,
    now: number,
    providerMessageId?: string,
  ): DeliveryRecord {
    return this.transitionLeased(deliveryId, owner, now, {
      status: 'SENT',
      providerMessageId,
      nextAttemptAt: now,
    });
  }

  markSkipped(
    deliveryId: string,
    owner: string,
    now: number,
    skip: DeliverySkip,
  ): DeliveryRecord {
    return this.transitionLeased(deliveryId, owner, now, {
      status: 'SKIPPED',
      skip,
      nextAttemptAt: now,
    });
  }

  markRetry(
    deliveryId: string,
    owner: string,
    now: number,
    options: MarkRetryOptions = {},
  ): DeliveryRecord {
    if (
      options.retryAfterMs !== undefined
      && (!Number.isSafeInteger(options.retryAfterMs) || options.retryAfterMs < 0)
    ) {
      throw new Error('retryAfterMs must be a non-negative safe integer.');
    }

    return this.transitionLeased(deliveryId, owner, now, {
      status: 'RETRY',
      error: options,
      nextAttemptAt: attempt => requireTimestamp(
        now + (
          options.retryAfterMs
          ?? computeRetryDelayMs(attempt, options.backoff)
        ),
        'nextAttemptAt',
      ),
    });
  }

  markUnknown(
    deliveryId: string,
    owner: string,
    now: number,
    error: DeliveryFailure = {},
  ): DeliveryRecord {
    return this.transitionLeased(deliveryId, owner, now, {
      status: 'UNKNOWN',
      error,
      nextAttemptAt: now,
    });
  }

  markPermanentFailed(
    deliveryId: string,
    owner: string,
    now: number,
    error: DeliveryFailure = {},
  ): DeliveryRecord {
    return this.transitionLeased(deliveryId, owner, now, {
      status: 'PERMANENT_FAILED',
      error,
      nextAttemptAt: now,
    });
  }

  markDlq(
    deliveryId: string,
    owner: string,
    now: number,
    error: DeliveryFailure = {},
  ): DeliveryRecord {
    return this.transitionLeased(deliveryId, owner, now, {
      status: 'DLQ',
      error,
      nextAttemptAt: now,
    });
  }

  markDLQ(
    deliveryId: string,
    owner: string,
    now: number,
    error: DeliveryFailure = {},
  ): DeliveryRecord {
    return this.markDlq(deliveryId, owner, now, error);
  }

  releaseExpired(now: number, destination?: DeliveryDestination): number {
    requireTimestamp(now, 'now');

    const run = this.db.transaction((): number => {
      const expired = destination
        ? this.db.prepare(`
          SELECT id, attempts
          FROM deliveries
          WHERE destination = ?
            AND status = 'SENDING'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ?
          ORDER BY id
        `).all(destination, now) as ActiveLeaseRow[]
        : this.db.prepare(`
        SELECT id, attempts
        FROM deliveries
        WHERE status = 'SENDING'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?
        ORDER BY id
        `).all(now) as ActiveLeaseRow[];

      const releaseDelivery = this.db.prepare(`
        UPDATE deliveries
        SET status = 'UNKNOWN',
            next_attempt_at = ?,
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = 'LEASE_EXPIRED',
            last_error_message = 'Delivery lease expired; provider acceptance is unknown.',
            updated_at = ?
        WHERE id = ? AND status = 'SENDING'
      `);
      const finishAttempt = this.db.prepare(`
        UPDATE delivery_attempts
        SET finished_at = ?,
            outcome = 'UNKNOWN',
            error_code = 'LEASE_EXPIRED',
            error_message = 'Delivery lease expired; provider acceptance is unknown.'
        WHERE delivery_id = ? AND attempt_no = ? AND outcome = 'SENDING'
      `);
      const expireMultipartParts = this.db.prepare(`
        UPDATE telegram_multipart_parts
        SET status = 'UNKNOWN',
            last_error_code = 'LEASE_EXPIRED',
            last_error_message = 'Multipart part was SENDING when the delivery lease expired.',
            updated_at = ?
        WHERE delivery_id = ? AND status = 'SENDING'
      `);

      let released = 0;
      for (const delivery of expired) {
        const update = releaseDelivery.run(now, now, delivery.id);
        if (update.changes !== 1) continue;
        const attempt = finishAttempt.run(now, delivery.id, delivery.attempts);
        if (attempt.changes !== 1) {
          throw new Error(`Active attempt missing for expired delivery ${delivery.id}.`);
        }
        expireMultipartParts.run(now, delivery.id);
        released += 1;
      }
      return released;
    });

    return run.immediate();
  }

  getById(deliveryId: string): DeliveryRecord | undefined {
    const row = this.db.prepare(`${DELIVERY_SELECT} WHERE d.id = ?`)
      .get(deliveryId) as RawDeliveryRow | undefined;
    return row ? toDeliveryRecord(row) : undefined;
  }

  statusCounts(): DeliveryStatusCount[] {
    return this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM deliveries
      GROUP BY status
      ORDER BY status
    `).all() as DeliveryStatusCount[];
  }

  listProblems(limit = 10, offset = 0): DeliveryRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('limit must be a safe integer between 1 and 100.');
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('offset must be a non-negative safe integer.');
    }
    const rows = this.db.prepare(`
      ${DELIVERY_SELECT}
      WHERE d.status IN ('UNKNOWN', 'PERMANENT_FAILED', 'DLQ')
      ORDER BY d.updated_at, d.id
      LIMIT ? OFFSET ?
    `).all(limit, offset) as RawDeliveryRow[];
    return rows.map(toDeliveryRecord);
  }

  problemCount(): number {
    const row = this.db.prepare(`
      SELECT count(*) AS count
      FROM deliveries
      WHERE status IN ('UNKNOWN', 'PERMANENT_FAILED', 'DLQ')
    `).get() as { count: number };
    return row.count;
  }

  purgeTerminalBefore(
    cutoff: number,
    limit = 500,
  ): { deliveriesDeleted: number; inboxEventsDeleted: number } {
    requireTimestamp(cutoff, 'cutoff');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error('purge limit must be between 1 and 10000.');
    }
    const run = this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT id
        FROM deliveries
        WHERE status IN ('SENT', 'SKIPPED')
          AND updated_at < ?
        ORDER BY updated_at, id
        LIMIT ?
      `).all(cutoff, limit) as Array<{ id: string }>;
      const deleteDelivery = this.db.prepare('DELETE FROM deliveries WHERE id = ?');
      let deliveriesDeleted = 0;
      for (const row of rows) {
        deliveriesDeleted += deleteDelivery.run(row.id).changes;
      }
      const inboxDelete = this.db.prepare(`
        DELETE FROM inbox_events
        WHERE received_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM deliveries WHERE deliveries.inbox_event_id = inbox_events.id
          )
      `).run(cutoff);
      return {
        deliveriesDeleted,
        inboxEventsDeleted: inboxDelete.changes,
      };
    });
    return run.immediate();
  }

  listAttempts(deliveryId: string, limit = 20): DeliveryAttemptRecord[] {
    const normalizedDeliveryId = requireNonEmpty(deliveryId, 'deliveryId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('limit must be a safe integer between 1 and 100.');
    }
    const rows = this.db.prepare(`
      SELECT
        attempt_no, started_at, finished_at, outcome,
        provider_message_id, error_code, error_message
      FROM delivery_attempts
      WHERE delivery_id = ?
      ORDER BY attempt_no DESC
      LIMIT ?
    `).all(normalizedDeliveryId, limit) as Array<{
      attempt_no: number;
      started_at: number;
      finished_at: number | null;
      outcome: Exclude<DeliveryStatus, 'READY'>;
      provider_message_id: string | null;
      error_code: string | null;
      error_message: string | null;
    }>;
    return rows.map(row => ({
      attemptNo: row.attempt_no,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      outcome: row.outcome,
      providerMessageId: row.provider_message_id,
      errorCode: row.error_code,
      errorMessage: row.error_message,
    }));
  }

  listOperatorActions(deliveryId: string, limit = 20): DeliveryOperatorActionRecord[] {
    const normalizedDeliveryId = requireNonEmpty(deliveryId, 'deliveryId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('limit must be a safe integer between 1 and 100.');
    }
    const rows = this.db.prepare(`
      SELECT action, previous_status, actor_telegram_user_id, reason, created_at
      FROM delivery_operator_actions
      WHERE delivery_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(normalizedDeliveryId, limit) as Array<{
      action: 'retry' | 'sent' | 'dlq';
      previous_status: 'UNKNOWN' | 'PERMANENT_FAILED' | 'DLQ';
      actor_telegram_user_id: number;
      reason: string | null;
      created_at: number;
    }>;
    return rows.map(row => ({
      action: row.action,
      previousStatus: row.previous_status,
      actorTelegramUserId: row.actor_telegram_user_id,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  resolveTelegramMultipartPart(
    deliveryId: string,
    partNo: number,
    now: number,
    action: 'sent' | 'retry',
    resolution: TelegramMultipartPartResolution,
  ): TelegramMultipartPartRecord {
    const normalizedDeliveryId = requireNonEmpty(deliveryId, 'deliveryId');
    requirePositiveSafeInteger(partNo, 'partNo');
    requireTimestamp(now, 'now');
    if (
      !Number.isSafeInteger(resolution.actorTelegramUserId)
      || resolution.actorTelegramUserId <= 0
    ) {
      throw new Error('actorTelegramUserId must be a positive safe integer.');
    }
    const reason = resolution.reason?.trim() || null;
    if (reason && reason.length > 500) {
      throw new Error('operator reason must not exceed 500 characters.');
    }
    const providerMessageId = action === 'sent'
      ? requireNonEmpty(
        resolution.providerMessageId ?? '',
        'providerMessageId',
      )
      : null;

    const run = this.db.transaction((): TelegramMultipartPartRecord => {
      const delivery = this.db.prepare(`
        SELECT attempts, destination, status, provider_message_id
        FROM deliveries
        WHERE id = ? AND status IN ('UNKNOWN', 'PERMANENT_FAILED', 'DLQ')
      `).get(normalizedDeliveryId) as {
        attempts: number;
        destination: DeliveryDestination;
        status: 'UNKNOWN' | 'PERMANENT_FAILED' | 'DLQ';
        provider_message_id: string | null;
      } | undefined;
      if (!delivery || delivery.destination !== 'telegram') {
        throw new Error(
          `Delivery ${normalizedDeliveryId} is not a resolvable Telegram delivery.`,
        );
      }
      const part = this.requireTelegramMultipartPart(normalizedDeliveryId, partNo);
      if (part.status !== 'UNKNOWN') {
        throw new Error(`Multipart part ${partNo} is not UNKNOWN.`);
      }

      if (action === 'sent') {
        this.db.prepare(`
          INSERT INTO delivery_receipts(
            delivery_id, attempt_no, provider, provider_message_id,
            receipt_kind, ordinal, is_primary, received_at
          ) VALUES (?, ?, 'telegram', ?, 'part', ?, ?, ?)
        `).run(
          normalizedDeliveryId,
          delivery.attempts,
          providerMessageId,
          partNo - 1,
          partNo === 1 ? 1 : 0,
          now,
        );
        if (partNo === 1) {
          if (
            delivery.provider_message_id !== null
            && delivery.provider_message_id !== providerMessageId
          ) {
            throw new Error('Operator-confirmed primary receipt conflicts with delivery receipt.');
          }
          this.db.prepare(`
            UPDATE deliveries
            SET provider_message_id = COALESCE(provider_message_id, ?),
                updated_at = ?
            WHERE id = ?
          `).run(providerMessageId, now, normalizedDeliveryId);
          this.db.prepare(`
            UPDATE delivery_attempts
            SET provider_message_id = COALESCE(provider_message_id, ?)
            WHERE delivery_id = ? AND attempt_no = ?
          `).run(providerMessageId, normalizedDeliveryId, delivery.attempts);
        }
      }

      const update = this.db.prepare(`
        UPDATE telegram_multipart_parts
        SET status = ?,
            provider_message_id = ?,
            last_error_code = NULL,
            last_error_message = NULL,
            sent_at = ?,
            updated_at = ?
        WHERE delivery_id = ? AND part_no = ? AND status = 'UNKNOWN'
      `).run(
        action === 'sent' ? 'SENT' : 'PENDING',
        providerMessageId,
        action === 'sent' ? now : null,
        now,
        normalizedDeliveryId,
        partNo,
      );
      if (update.changes !== 1) {
        throw new Error(`Multipart part ${partNo} changed during operator resolution.`);
      }
      this.db.prepare(`
        INSERT INTO telegram_multipart_part_actions(
          delivery_id, part_no, actor_telegram_user_id, action,
          previous_status, provider_message_id, reason, created_at
        ) VALUES (?, ?, ?, ?, 'UNKNOWN', ?, ?, ?)
      `).run(
        normalizedDeliveryId,
        partNo,
        resolution.actorTelegramUserId,
        action,
        providerMessageId,
        reason,
        now,
      );
      return this.requireTelegramMultipartPart(normalizedDeliveryId, partNo);
    });
    return run.immediate();
  }

  requeueProblem(
    deliveryId: string,
    now = Date.now(),
    operator?: DeliveryOperatorResolution,
  ): DeliveryRecord {
    return this.resolveProblem(deliveryId, now, 'RETRY', operator);
  }

  resolveProblemAsSent(
    deliveryId: string,
    now = Date.now(),
    operator?: DeliveryOperatorResolution,
  ): DeliveryRecord {
    return this.resolveProblem(deliveryId, now, 'SENT', operator);
  }

  resolveProblemAsDlq(
    deliveryId: string,
    now = Date.now(),
    operator?: DeliveryOperatorResolution,
  ): DeliveryRecord {
    return this.resolveProblem(deliveryId, now, 'DLQ', operator);
  }

  private getByInboxAndDestination(
    inboxEventId: string,
    destination: DeliveryDestination,
  ): DeliveryRecord | undefined {
    const row = this.db.prepare(`
      ${DELIVERY_SELECT}
      WHERE d.inbox_event_id = ? AND d.destination = ?
    `).get(inboxEventId, destination) as RawDeliveryRow | undefined;
    return row ? toDeliveryRecord(row) : undefined;
  }

  private resolveProblem(
    deliveryId: string,
    now: number,
    status: 'RETRY' | 'SENT' | 'DLQ',
    operator?: DeliveryOperatorResolution,
  ): DeliveryRecord {
    const normalizedDeliveryId = requireNonEmpty(deliveryId, 'deliveryId');
    requireTimestamp(now, 'now');
    let operatorReason: string | null = null;
    if (operator) {
      if (!Number.isSafeInteger(operator.actorTelegramUserId) || operator.actorTelegramUserId <= 0) {
        throw new Error('actorTelegramUserId must be a positive safe integer.');
      }
      operatorReason = operator.reason?.trim() || null;
      if (operatorReason && operatorReason.length > 500) {
        throw new Error('operator reason must not exceed 500 characters.');
      }
    }
    const run = this.db.transaction(() => {
      const current = this.db.prepare(`
        SELECT status
        FROM deliveries
        WHERE id = ? AND status IN ('UNKNOWN', 'PERMANENT_FAILED', 'DLQ')
      `).get(normalizedDeliveryId) as {
        status: 'UNKNOWN' | 'PERMANENT_FAILED' | 'DLQ';
      } | undefined;
      if (!current) {
        throw new Error(`Delivery ${normalizedDeliveryId} is not in a resolvable problem state.`);
      }
      const multipartUnknown = this.db.prepare(`
        SELECT count(*) AS count
        FROM telegram_multipart_parts
        WHERE delivery_id = ? AND status = 'UNKNOWN'
      `).get(normalizedDeliveryId) as { count: number };
      if (status === 'RETRY' && multipartUnknown.count > 0) {
        throw new Error(
          'Resolve every UNKNOWN multipart part before requeueing this delivery.',
        );
      }
      if (status === 'SENT') {
        const multipartIncomplete = this.db.prepare(`
          SELECT count(*) AS count
          FROM telegram_multipart_parts
          WHERE delivery_id = ? AND status <> 'SENT'
        `).get(normalizedDeliveryId) as { count: number };
        if (multipartIncomplete.count > 0) {
          throw new Error(
            'Every multipart part must be SENT before confirming the delivery as sent.',
          );
        }
      }
      const result = this.db.prepare(`
        UPDATE deliveries
        SET status = ?,
            next_attempt_at = ?,
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error_code = CASE
              WHEN ? = 'RETRY' THEN 'OPERATOR_RETRY'
              WHEN ? = 'SENT' THEN 'OPERATOR_CONFIRMED_SENT'
              ELSE 'OPERATOR_DLQ'
            END,
            updated_at = ?
        WHERE id = ?
          AND status IN ('UNKNOWN', 'PERMANENT_FAILED', 'DLQ')
      `).run(status, now, status, status, now, normalizedDeliveryId);
      if (result.changes !== 1) {
        throw new Error(`Delivery ${normalizedDeliveryId} is not in a resolvable problem state.`);
      }
      if (status === 'SENT' || status === 'DLQ') {
        this.db.prepare('DELETE FROM delivery_media WHERE delivery_id = ?')
          .run(normalizedDeliveryId);
      }
      if (operator) {
        const action = status === 'RETRY' ? 'retry' : status === 'SENT' ? 'sent' : 'dlq';
        this.db.prepare(`
          INSERT INTO delivery_operator_actions(
            delivery_id, actor_telegram_user_id, action,
            previous_status, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          normalizedDeliveryId,
          operator.actorTelegramUserId,
          action,
          current.status,
          operatorReason,
          now,
        );
      }
      return this.requireById(normalizedDeliveryId);
    });
    return run.immediate();
  }

  private requireById(deliveryId: string): DeliveryRecord {
    const delivery = this.getById(deliveryId);
    if (!delivery) throw new Error(`Delivery ${deliveryId} does not exist.`);
    return delivery;
  }

  private requireTelegramMultipartPart(
    deliveryId: string,
    partNo: number,
  ): TelegramMultipartPartRecord {
    const row = this.db.prepare(`
      SELECT *
      FROM telegram_multipart_parts
      WHERE delivery_id = ? AND part_no = ?
    `).get(deliveryId, partNo) as RawTelegramMultipartPartRow | undefined;
    if (!row) {
      throw new Error(
        `Multipart part ${partNo} does not exist for delivery ${deliveryId}.`,
      );
    }
    return toTelegramMultipartPart(row);
  }

  private transitionLeased(
    deliveryId: string,
    owner: string,
    now: number,
    options: TransitionOptions,
  ): DeliveryRecord {
    const normalizedDeliveryId = requireNonEmpty(deliveryId, 'deliveryId');
    const leaseOwner = requireNonEmpty(owner, 'owner');
    requireTimestamp(now, 'now');
    const skip = options.skip === undefined ? undefined : {
      code: requireNonEmpty(options.skip.code, 'skip.code'),
      message: requireNonEmpty(options.skip.message, 'skip.message'),
    };
    if ((options.status === 'SKIPPED') !== (skip !== undefined)) {
      throw new Error('SKIPPED transitions require skip audit details only.');
    }

    const run = this.db.transaction((): DeliveryRecord => {
      const active = this.db.prepare(`
        SELECT id, attempts, destination, provider_message_id
        FROM deliveries
        WHERE id = ? AND status = 'SENDING' AND lease_owner = ?
      `).get(normalizedDeliveryId, leaseOwner) as ActiveLeaseRow | undefined;
      if (!active) {
        throw new Error(
          `Delivery ${normalizedDeliveryId} is not leased by ${leaseOwner}.`,
        );
      }

      const nextAttemptAt = typeof options.nextAttemptAt === 'function'
        ? options.nextAttemptAt(active.attempts)
        : options.nextAttemptAt;
      requireTimestamp(nextAttemptAt, 'nextAttemptAt');

      const providerMessageId = options.providerMessageId === undefined
        ? null
        : requireNonEmpty(options.providerMessageId, 'providerMessageId');
      if (
        providerMessageId !== null
        && active.provider_message_id !== null
        && active.provider_message_id !== providerMessageId
      ) {
        throw new Error(
          `Primary provider receipt conflicts for delivery ${normalizedDeliveryId}.`,
        );
      }
      if (options.status === 'RETRY' && this.hasProviderReceipts(
        normalizedDeliveryId,
        active.attempts,
      )) {
        throw new Error(
          `Delivery ${normalizedDeliveryId} has provider receipts and cannot auto-retry.`,
        );
      }
      const errorCode = options.error?.code ?? null;
      const errorMessage = options.error?.message ?? null;

      const update = this.db.prepare(`
        UPDATE deliveries
        SET status = ?,
            next_attempt_at = ?,
            lease_owner = NULL,
            lease_expires_at = NULL,
            provider_message_id = COALESCE(?, provider_message_id),
            last_error_code = ?,
            last_error_message = ?,
            updated_at = ?
        WHERE id = ? AND status = 'SENDING' AND lease_owner = ?
      `).run(
        options.status,
        nextAttemptAt,
        providerMessageId,
        errorCode,
        errorMessage,
        now,
        normalizedDeliveryId,
        leaseOwner,
      );
      if (update.changes !== 1) {
        throw new Error(`Delivery ${normalizedDeliveryId} lease changed concurrently.`);
      }

      const attempt = this.db.prepare(`
        UPDATE delivery_attempts
        SET finished_at = ?,
            outcome = ?,
            provider_message_id = COALESCE(?, provider_message_id),
            error_code = ?,
            error_message = ?
        WHERE delivery_id = ? AND attempt_no = ? AND outcome = 'SENDING'
      `).run(
        now,
        options.status,
        providerMessageId,
        errorCode,
        errorMessage,
        normalizedDeliveryId,
        active.attempts,
      );
      if (attempt.changes !== 1) {
        throw new Error(`Active attempt missing for delivery ${normalizedDeliveryId}.`);
      }

      if (skip) {
        this.db.prepare(`
          INSERT INTO delivery_skip_audits(
            delivery_id, attempt_no, reason_code, reason, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `).run(
          normalizedDeliveryId,
          active.attempts,
          skip.code,
          skip.message,
          now,
        );
      }

      if (['SENT', 'SKIPPED', 'DLQ'].includes(options.status)) {
        this.db.prepare('DELETE FROM delivery_media WHERE delivery_id = ?')
          .run(normalizedDeliveryId);
      }

      return this.requireById(normalizedDeliveryId);
    });

    return run.immediate();
  }
}
