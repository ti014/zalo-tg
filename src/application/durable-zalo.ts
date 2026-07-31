import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

import { normalizeMessageId } from '../domain/message-id.js';
import type {
  DeliveryRecord,
  DeliveryRepository,
  ProviderReceiptInput,
  TelegramMultipartManifestInput,
  TelegramMultipartManifestRecord,
  TelegramMultipartPartRecord,
} from '../infrastructure/database/delivery-repository.js';
import type { MediaSpool } from '../infrastructure/media/media-spool.js';
import type { ZaloAPI, ZaloMessage } from '../zalo/types.js';

interface ZaloDeliveryExecutionState {
  deliveryId: string;
  handled: boolean;
  failure?: unknown;
  repository: DeliveryRepository;
  workerId: string;
  attemptNo: number;
  skipped?: {
    code: string;
    message: string;
  };
}

export interface DurableZaloRelayOptions {
  repository: DeliveryRepository;
  processMessage: (api: ZaloAPI, message: ZaloMessage) => Promise<void>;
  onFatal: (error: Error) => void;
  pollIntervalMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  stopTimeoutMs?: number;
  mediaSpool?: MediaSpool;
}

const executionStorage = new AsyncLocalStorage<ZaloDeliveryExecutionState>();

export function currentDurableZaloDeliveryId(): string | undefined {
  return executionStorage.getStore()?.deliveryId;
}

export function isDurableZaloDelivery(): boolean {
  return executionStorage.getStore() !== undefined;
}

export function markDurableZaloHandled(): void {
  const state = executionStorage.getStore();
  if (state) state.handled = true;
}

export function recordDurableZaloFailure(error: unknown): void {
  const state = executionStorage.getStore();
  if (state && state.failure === undefined) state.failure = error;
}

export function recordDurableZaloProviderMessageId(
  providerMessageId: string | number,
  options: Omit<ProviderReceiptInput, 'provider' | 'providerMessageId'> = {},
): void {
  const state = executionStorage.getStore();
  const normalized = String(providerMessageId).trim();
  if (!state || !normalized) return;
  try {
    state.repository.recordProviderReceipt(
      state.deliveryId,
      state.workerId,
      Date.now(),
      {
        ...options,
        provider: 'telegram',
        providerMessageId: normalized,
      },
    );
  } catch (error) {
    throw Object.assign(
      new Error('Could not persist the Telegram provider receipt.', { cause: error }),
      { code: 'RECEIPT_WRITE_FAILED' },
    );
  }
}

export function recordDurableZaloSkipped(code: string, message: string): void {
  const state = executionStorage.getStore();
  const normalizedCode = code.trim();
  const normalizedMessage = message.trim();
  if (state && normalizedCode && normalizedMessage && state.skipped === undefined) {
    state.skipped = {
      code: normalizedCode,
      message: normalizedMessage,
    };
  }
}

export function currentDurableZaloMultipartManifest():
TelegramMultipartManifestRecord | undefined {
  const state = executionStorage.getStore();
  return state?.repository.getTelegramMultipartManifest(state.deliveryId);
}

export function ensureDurableZaloMultipartManifest(
  input: TelegramMultipartManifestInput,
): TelegramMultipartManifestRecord {
  const state = executionStorage.getStore();
  if (!state) throw new Error('Multipart manifest requires a durable Zalo delivery.');
  return state.repository.ensureTelegramMultipartManifest(
    state.deliveryId,
    state.workerId,
    Date.now(),
    input,
  );
}

export function listDurableZaloMultipartParts(): TelegramMultipartPartRecord[] {
  const state = executionStorage.getStore();
  return state?.repository.listTelegramMultipartParts(state.deliveryId) ?? [];
}

export function markDurableZaloMultipartPartSending(
  partNo: number,
): TelegramMultipartPartRecord {
  const state = executionStorage.getStore();
  if (!state) throw new Error('Multipart part transition requires a durable Zalo delivery.');
  return state.repository.markTelegramMultipartPartSending(
    state.deliveryId,
    state.workerId,
    partNo,
    Date.now(),
  );
}

export function markDurableZaloMultipartPartFailure(
  partNo: number,
  outcome: 'PENDING' | 'UNKNOWN',
  error: unknown,
): TelegramMultipartPartRecord {
  const state = executionStorage.getStore();
  if (!state) throw new Error('Multipart part transition requires a durable Zalo delivery.');
  const details = errorDetails(error);
  return state.repository.markTelegramMultipartPartFailure(
    state.deliveryId,
    state.workerId,
    partNo,
    Date.now(),
    outcome,
    details,
  );
}

function errorDetails(error: unknown): { code: string; message: string } {
  const responseCode = (error as { response?: { error_code?: unknown } })?.response?.error_code;
  const rawCode = (error as { code?: unknown })?.code ?? responseCode;
  return {
    code: rawCode === undefined ? 'DELIVERY_FAILED' : String(rawCode),
    message: error instanceof Error ? error.message : String(error),
  };
}

function isUncertain(error: unknown): boolean {
  const { code, message } = errorDetails(error);
  return [
    'ETIMEDOUT',
    'ESOCKETTIMEDOUT',
    'ECONNRESET',
    'EPIPE',
    'PARTIAL_CHUNK_UPLOAD',
    'RECEIPT_WRITE_FAILED',
    'SHADOW_WRITE_FAILED',
  ].includes(code)
    || /timeout|timed out|socket hang up/i.test(message);
}

function isPermanent(error: unknown): boolean {
  const { code, message } = errorDetails(error);
  return [
    '400',
    '403',
    '413',
    'MEDIA_TOO_LARGE',
    'INVALID_PAYLOAD',
    'INVALID_SOURCE_PAYLOAD',
    'PART_MANIFEST_MISMATCH',
    'PART_RECEIPT_INVALID',
    'TELEGRAM_MANAGE_TOPICS_REQUIRED',
  ].includes(code)
    || /too large|unsupported|invalid (?:file|payload)|message is too long/i.test(message);
}

function messageIdentity(message: ZaloMessage): string {
  const primaryId = normalizeMessageId(message.data.msgId)
    ?? normalizeMessageId(message.data.realMsgId)
    ?? normalizeMessageId(message.data.cliMsgId);
  if (primaryId) return `${message.type}:${message.threadId}:${primaryId}`;
  return createHash('sha256')
    .update(JSON.stringify({
      type: message.type,
      threadId: message.threadId,
      sender: message.data.uidFrom,
      timestamp: message.data.ts,
      messageType: message.data.msgType,
      content: message.data.content,
    }))
    .digest('hex');
}

function isZaloMessage(value: unknown): value is ZaloMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<ZaloMessage>;
  return typeof message.threadId === 'string'
    && (message.type === 0 || message.type === 1)
    && typeof message.data === 'object'
    && message.data !== null;
}

function isEquivalentEnrichedReplay(storedPayload: unknown, incomingPayload: unknown): boolean {
  if (!isZaloMessage(storedPayload) || !isZaloMessage(incomingPayload)) return false;
  const withoutLateAliases = (message: ZaloMessage): unknown => {
    const data = { ...message.data } as Record<string, unknown>;
    delete data.realMsgId;
    delete data.cliMsgId;
    return { ...message, data };
  };
  return JSON.stringify(withoutLateAliases(storedPayload))
    === JSON.stringify(withoutLateAliases(incomingPayload));
}

export class DurableZaloRelay {
  readonly #repository: DeliveryRepository;
  readonly #processMessage: (api: ZaloAPI, message: ZaloMessage) => Promise<void>;
  readonly #onFatal: (error: Error) => void;
  readonly #workerId = `zalo-to-telegram:${randomUUID()}`;
  readonly #pollIntervalMs: number;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #stopTimeoutMs: number;
  readonly #mediaSpool: MediaSpool | undefined;
  #api: ZaloAPI | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #wakeTimer: ReturnType<typeof setTimeout> | undefined;
  #draining: Promise<void> | undefined;
  #stopped = false;

  constructor(options: DurableZaloRelayOptions) {
    this.#repository = options.repository;
    this.#processMessage = options.processMessage;
    this.#onFatal = options.onFatal;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#leaseMs = options.leaseMs ?? 120_000;
    this.#maxAttempts = options.maxAttempts ?? 8;
    this.#stopTimeoutMs = options.stopTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.#stopTimeoutMs) || this.#stopTimeoutMs <= 0) {
      throw new Error('stopTimeoutMs must be a positive safe integer.');
    }
    this.#mediaSpool = options.mediaSpool;
  }

  setApi(api: ZaloAPI): void {
    this.#api = api;
    this.wake();
  }

  clearApi(api?: ZaloAPI): void {
    if (api === undefined || this.#api === api) this.#api = null;
  }

  enqueue(message: ZaloMessage): void {
    try {
      const result = this.#repository.ingestAndEnqueue(
        {
          source: 'zalo',
          sourceEventKey: messageIdentity(message),
          conversationKey: `${message.type}:${message.threadId}`,
          eventType: message.data.msgType ?? 'message',
          payload: message,
          destination: 'telegram',
        },
        { equivalentReplay: isEquivalentEnrichedReplay },
      );
      if (result.delivery.status === 'READY' || result.delivery.status === 'RETRY') this.wake();
    } catch (error) {
      this.#onFatal(new Error('Could not persist Zalo message before Telegram delivery.', { cause: error }));
    }
  }

  start(): void {
    if (this.#timer || this.#stopped) return;
    this.#timer = setInterval(() => this.wake(), this.#pollIntervalMs);
    this.#timer.unref();
    this.wake();
  }

  wake(): void {
    if (this.#stopped || this.#wakeTimer || this.#draining) return;
    this.#wakeTimer = setTimeout(() => {
      this.#wakeTimer = undefined;
      if (this.#stopped || this.#draining) return;
      this.#draining = this.#drain()
        .catch(error => this.#onFatal(new Error('Durable Zalo delivery worker failed.', { cause: error })))
        .finally(() => { this.#draining = undefined; });
    }, 0);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#wakeTimer) clearTimeout(this.#wakeTimer);
    this.#timer = undefined;
    this.#wakeTimer = undefined;
    const draining = this.#draining;
    if (!draining) return;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        draining,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(Object.assign(
            new Error(`Durable Zalo delivery worker stop timed out after ${this.#stopTimeoutMs} ms.`),
            { code: 'WORKER_STOP_TIMEOUT' },
          )), this.#stopTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async #drain(): Promise<void> {
    this.#repository.releaseExpired(Date.now(), 'telegram');
    while (!this.#stopped && this.#api) {
      const delivery = this.#repository.leaseNext('telegram', this.#workerId, Date.now(), this.#leaseMs);
      if (!delivery) return;
      await this.#deliver(delivery, this.#api);
    }
  }

  async #deliver(delivery: DeliveryRecord, api: ZaloAPI): Promise<void> {
    const state: ZaloDeliveryExecutionState = {
      deliveryId: delivery.id,
      handled: false,
      repository: this.#repository,
      workerId: this.#workerId,
      attemptNo: delivery.attempts,
    };
    if (!isZaloMessage(delivery.payload)) {
      state.failure = Object.assign(new Error('Stored Zalo payload is invalid.'), { code: 'INVALID_PAYLOAD' });
    } else {
      try {
        await executionStorage.run(state, () => this.#processMessage(api, delivery.payload as ZaloMessage));
      } catch (error) {
        state.failure ??= error;
      }
    }

    const now = Date.now();
    if (!state.failure && state.handled) {
      if (state.skipped) {
        this.#repository.markSkipped(
          delivery.id,
          this.#workerId,
          now,
          state.skipped,
        );
      } else {
        this.#repository.markSent(delivery.id, this.#workerId, now);
      }
      this.#mediaSpool?.detachAllFromDelivery(delivery.id);
      return;
    }
    const failure = state.failure ?? new Error('Zalo message was not handled by the Telegram relay.');
    const details = errorDetails(failure);
    if (this.#repository.hasProviderReceipts(delivery.id, delivery.attempts)) {
      this.#repository.markUnknown(delivery.id, this.#workerId, now, details);
    } else if (!state.handled || isPermanent(failure)) {
      this.#repository.markPermanentFailed(delivery.id, this.#workerId, now, details);
      this.#mediaSpool?.detachAllFromDelivery(delivery.id);
    } else if (isUncertain(failure)) {
      this.#repository.markUnknown(delivery.id, this.#workerId, now, details);
    } else if (delivery.attempts >= this.#maxAttempts) {
      this.#repository.markDlq(delivery.id, this.#workerId, now, {
        code: 'MAX_ATTEMPTS',
        message: `${details.code}: ${details.message}`,
      });
      this.#mediaSpool?.detachAllFromDelivery(delivery.id);
    } else {
      this.#repository.markRetry(delivery.id, this.#workerId, now, details);
    }
  }
}
