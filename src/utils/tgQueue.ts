/**
 * Rate-limit-aware concurrent queue for Telegram API calls.
 *
 * Allows up to CONCURRENCY calls in-flight simultaneously for low latency.
 * On 429 Too Many Requests: the failing call is re-queued after retry_after,
 * and all subsequent calls wait out the same pause window.
 */

interface QueueItem {
  fn: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject:  (e: unknown) => void;
  retries: number;
  timeoutMs: number;
}

const MAX_RETRIES  = 5;
const CONCURRENCY  = 5;   // max simultaneous in-flight TG calls
const DEFAULT_TG_CALL_TIMEOUT_MS = 45_000;
const _queue: QueueItem[] = [];
let   _active    = 0;
let   _pauseUntil = 0; // epoch ms — global back-off on 429

function retryAfterSeconds(err: unknown): number | null {
  const response = (err as { response?: {
    error_code?: number;
    description?: string;
    parameters?: { retry_after?: number };
  } })?.response;
  // Telegram sometimes wraps flood control in HTTP 400 instead of 429.
  const wrapped = response?.error_code === 400
    ? response.description?.match(/too many requests:\s*retry after (\d+)/i)
    : undefined;
  if (response?.error_code !== 429 && !wrapped) return null;
  const seconds = response?.parameters?.retry_after ?? (wrapped ? Number(wrapped[1]) : 30);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : 30;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(
        new Error(`Telegram API timeout after ${Math.round(timeoutMs / 1000)}s`),
        { code: 'ETIMEDOUT' },
      )), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function scheduleNext(): void {
  while (_active < CONCURRENCY && _queue.length > 0) {
    const item = _queue.shift()!;
    _active++;
    void runOne(item);
  }
}

async function runOne(item: QueueItem): Promise<void> {
  try {
    // Honour the global pause window before firing
    const wait = _pauseUntil - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));

    const result = await withTimeout(item.fn(), item.timeoutMs);
    item.resolve(result);
  } catch (err) {
    const retryAfter = retryAfterSeconds(err);
    if (retryAfter !== null && item.retries < MAX_RETRIES) {
      const delay = (retryAfter + 1) * 1000;
      console.warn(`[TGQueue] 429 — retry #${item.retries + 1} after ${retryAfter}s`);
      _pauseUntil = Math.max(_pauseUntil, Date.now() + delay);
      // Re-queue at the front so it goes next once the pause expires
      _queue.unshift({ ...item, retries: item.retries + 1 });
    } else {
      item.reject(err);
    }
  } finally {
    _active--;
    scheduleNext();
  }
}

/** Enqueue a Telegram API call. Returns a promise that resolves/rejects when done. */
export function tgQueue<T>(
  fn: () => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TG_CALL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Telegram queue timeoutMs must be a positive safe integer.');
  }
  return new Promise<T>((resolve, reject) => {
    _queue.push({
      fn: fn as () => Promise<unknown>,
      resolve: resolve as (v: unknown) => void,
      reject,
      retries: 0,
      timeoutMs,
    });
    scheduleNext();
  });
}
