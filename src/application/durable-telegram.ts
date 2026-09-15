import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type { Context, MiddlewareFn, Telegraf } from 'telegraf';

import type {
  DeliveryRecord,
  DeliveryRepository,
  ProviderReceiptInput,
} from '../infrastructure/database/delivery-repository.js';
import type { TopicEntry } from '../store/topics.js';
import type { ZaloAPI } from '../zalo/types.js';
import { isAnonymousAdminUpdate } from '../telegram/authorization-policy.js';

interface DeliveryExecutionState {
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

export interface TelegramDeliveryTarget {
  type: 0 | 1;
  zaloId: string;
}

interface TelegramPollingControl {
  skipOffsetSync: boolean;
}

export class DurableTelegramCaptureError extends Error {
  readonly code = 'DURABLE_CAPTURE_FAILED';
  readonly updateId: number;

  constructor(updateId: number, cause: unknown) {
    super(`Could not persist Telegram update ${updateId} before delivery.`, { cause });
    this.name = 'DurableTelegramCaptureError';
    this.updateId = updateId;
  }
}

/**
 * Prevents Telegraf from committing its in-memory polling offset, then rejects
 * the update so the process can fail fast. The update will be fetched again
 * after restart; already persisted updates are absorbed by inbox idempotency.
 */
export function abortTelegramPollingForCapture(
  bot: Telegraf,
  error: DurableTelegramCaptureError,
): never {
  const polling = (bot as unknown as { polling?: TelegramPollingControl }).polling;
  if (polling) polling.skipOffsetSync = true;
  throw error;
}

export interface DurableTelegramRelayOptions {
  repository: DeliveryRepository;
  bot: Telegraf;
  telegramChatId: number;
  getApi: () => ZaloAPI | null;
  getTopic: (topicId: number) => TopicEntry | undefined;
  onFatal: (error: Error) => void;
  replayUpdate?: (update: unknown, target: TelegramDeliveryTarget) => Promise<void>;
  pollIntervalMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  stopTimeoutMs?: number;
}

const executionStorage = new AsyncLocalStorage<DeliveryExecutionState>();

export function currentDurableTelegramDeliveryId(): string | undefined {
  return executionStorage.getStore()?.deliveryId;
}

export function isDurableTelegramDelivery(): boolean {
  return executionStorage.getStore() !== undefined;
}

export function markDurableTelegramHandled(): void {
  const state = executionStorage.getStore();
  if (state) state.handled = true;
}

export function recordDurableTelegramFailure(error: unknown): void {
  const state = executionStorage.getStore();
  if (state && state.failure === undefined) state.failure = error;
}

export function recordDurableTelegramSkipped(code: string, message: string): void {
  const state = executionStorage.getStore();
  const normalizedCode = code.trim();
  const normalizedMessage = message.trim();
  if (state && normalizedCode && normalizedMessage && state.skipped === undefined) {
    state.skipped = { code: normalizedCode, message: normalizedMessage };
  }
}

export function recordDurableTelegramProviderMessageId(
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
        provider: 'zalo',
        providerMessageId: normalized,
      },
    );
  } catch (error) {
    throw Object.assign(
      new Error('Could not persist the Zalo provider receipt.', { cause: error }),
      { code: 'RECEIPT_WRITE_FAILED' },
    );
  }
}

function messageEventType(message: Record<string, unknown>): string {
  const candidates = [
    'text', 'photo', 'video', 'animation', 'audio', 'voice', 'document',
    'sticker', 'poll', 'location', 'contact', 'venue', 'dice',
  ];
  return candidates.find(key => key in message) ?? 'message';
}

function errorDetails(error: unknown): { code: string; message: string } {
  const rawCode = (error as { code?: unknown })?.code;
  const code = rawCode === undefined ? 'DELIVERY_FAILED' : String(rawCode);
  const message = error instanceof Error ? error.message : String(error);
  return { code, message };
}

function looksUncertain(error: unknown): boolean {
  const { code, message } = errorDetails(error);
  return [
    'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'EPIPE', 'UND_ERR_HEADERS_TIMEOUT',
    'RECEIPT_WRITE_FAILED',
    'SHADOW_WRITE_FAILED',
  ].includes(code) || /timeout|timed out|socket hang up/i.test(message);
}

function isPermanent(error: unknown): boolean {
  const { code, message } = errorDetails(error);
  return code === '114'
    || code === 'TOPIC_MAPPING_MISSING'
    || code === 'POLL_REQUIRES_GROUP'
    || code === 'MESSAGE_TOO_LARGE'
    || code === 'MEDIA_TOO_LARGE'
    || code === 'INVALID_PAYLOAD'
    || code === 'INVALID_CONVERSATION_KEY'
    || code === 'UNSUPPORTED_MESSAGE'
    || /size exceed maximum size/i.test(message)
    || /vượt giới hạn|too (?:big|large)|unsupported|không thể tải xuống/i.test(message);
}

function deliveryTarget(conversationKey: string): TelegramDeliveryTarget {
  const separator = conversationKey.indexOf(':');
  const rawType = separator < 0 ? '' : conversationKey.slice(0, separator);
  const zaloId = separator < 0 ? '' : conversationKey.slice(separator + 1).trim();
  if ((rawType !== '0' && rawType !== '1') || !zaloId) {
    throw Object.assign(
      new Error(`Invalid Telegram delivery conversation key: ${conversationKey}`),
      { code: 'INVALID_CONVERSATION_KEY' },
    );
  }
  return { type: Number(rawType) as 0 | 1, zaloId };
}

export class DurableTelegramRelay {
  readonly #repository: DeliveryRepository;
  readonly #bot: Telegraf;
  readonly #telegramChatId: number;
  readonly #getApi: () => ZaloAPI | null;
  readonly #getTopic: (topicId: number) => TopicEntry | undefined;
  readonly #onFatal: (error: Error) => void;
  readonly #replayUpdate: (update: unknown, target: TelegramDeliveryTarget) => Promise<void>;
  readonly #workerId = `telegram-to-zalo:${randomUUID()}`;
  readonly #pollIntervalMs: number;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #stopTimeoutMs: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #wakeTimer: ReturnType<typeof setTimeout> | undefined;
  #draining: Promise<void> | undefined;
  #stopped = false;

  constructor(options: DurableTelegramRelayOptions) {
    this.#repository = options.repository;
    this.#bot = options.bot;
    this.#telegramChatId = options.telegramChatId;
    this.#getApi = options.getApi;
    this.#getTopic = options.getTopic;
    this.#onFatal = options.onFatal;
    this.#replayUpdate = options.replayUpdate
      ?? (update => this.#bot.handleUpdate(update as Parameters<Telegraf['handleUpdate']>[0]));
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#leaseMs = options.leaseMs ?? 60_000;
    this.#maxAttempts = options.maxAttempts ?? 8;
    this.#stopTimeoutMs = options.stopTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.#stopTimeoutMs) || this.#stopTimeoutMs <= 0) {
      throw new Error('stopTimeoutMs must be a positive safe integer.');
    }
  }

  middleware(): MiddlewareFn<Context> {
    return async (ctx, next) => {
      if (executionStorage.getStore()) {
        await next();
        return;
      }

      const message = ctx.message as unknown as (Record<string, unknown> & {
        message_id?: number;
        message_thread_id?: number;
        text?: string;
      }) | undefined;
      if (
        !message
        || (ctx.from?.is_bot && !isAnonymousAdminUpdate(ctx.update))
        || ctx.chat?.id !== this.#telegramChatId
        || message.text?.startsWith('/')
      ) {
        await next();
        return;
      }

      const topicId = message.message_thread_id;
      if (!Number.isSafeInteger(topicId) || !topicId) {
        await next();
        return;
      }
      const topic = this.#getTopic(topicId);
      if (!topic) {
        await next();
        return;
      }

      try {
        const result = this.#repository.ingestAndEnqueue({
          source: 'telegram',
          sourceEventKey: `update:${ctx.update.update_id}`,
          conversationKey: `${topic.type}:${topic.zaloId}`,
          eventType: messageEventType(message),
          payload: ctx.update,
          destination: 'zalo',
        });
        if (result.delivery.status === 'READY' || result.delivery.status === 'RETRY') {
          this.wake();
        }
      } catch (error) {
        const fatal = new DurableTelegramCaptureError(ctx.update.update_id, error);
        try {
          this.#onFatal(fatal);
        } catch (onFatalError) {
          console.error('[Telegram delivery] Fatal callback failed:', onFatalError);
        }
        throw fatal;
      }
    };
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
        .catch(error => this.#onFatal(new Error('Durable Telegram delivery worker failed.', { cause: error })))
        .finally(() => {
          this.#draining = undefined;
        });
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
            new Error(`Durable Telegram delivery worker stop timed out after ${this.#stopTimeoutMs} ms.`),
            { code: 'WORKER_STOP_TIMEOUT' },
          )), this.#stopTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async #drain(): Promise<void> {
    this.#repository.releaseExpired(Date.now(), 'zalo');
    while (!this.#stopped && this.#getApi()) {
      const delivery = this.#repository.leaseNext('zalo', this.#workerId, Date.now(), this.#leaseMs);
      if (!delivery) return;
      await this.#deliver(delivery);
    }
  }

  async #deliver(delivery: DeliveryRecord): Promise<void> {
    const state: DeliveryExecutionState = {
      deliveryId: delivery.id,
      handled: false,
      repository: this.#repository,
      workerId: this.#workerId,
      attemptNo: delivery.attempts,
    };
    try {
      const target = deliveryTarget(delivery.conversationKey);
      await executionStorage.run(state, async () => {
        await this.#replayUpdate(delivery.payload, target);
      });
    } catch (error) {
      state.failure ??= error;
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
      return;
    }

    const failure = state.failure ?? new Error('Telegram update was not handled by the Zalo relay.');
    const details = errorDetails(failure);
    if (this.#repository.hasProviderReceipts(delivery.id, delivery.attempts)) {
      this.#repository.markUnknown(delivery.id, this.#workerId, now, details);
    } else if (!state.handled || isPermanent(failure)) {
      this.#repository.markPermanentFailed(delivery.id, this.#workerId, now, details);
    } else if (looksUncertain(failure)) {
      this.#repository.markUnknown(delivery.id, this.#workerId, now, details);
    } else if (delivery.attempts >= this.#maxAttempts) {
      this.#repository.markDlq(delivery.id, this.#workerId, now, {
        code: 'MAX_ATTEMPTS',
        message: `${details.code}: ${details.message}`,
      });
    } else {
      this.#repository.markRetry(delivery.id, this.#workerId, now, details);
    }
  }
}
