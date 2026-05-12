export const ZALO_RATE_LIMIT_CODE = 221;

const DEFAULT_MIN_INTERVAL_MS = 1_200;
const DEFAULT_RETRY_DELAY_MS = 45_000;
const LOW_PRIORITY_MIN_INTERVAL_MS = 2_500;
const LOW_PRIORITY_RETRY_DELAY_MS = 120_000;

let queue: Promise<void> = Promise.resolve();
let nextAllowedAt = 0;

export interface ZaloRequestOptions {
  label: string;
  priority?: 'high' | 'low';
  maxRetries?: number;
  minIntervalMs?: number;
  retryDelayMs?: number;
}

export function isZaloRateLimitError(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === ZALO_RATE_LIMIT_CODE;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

async function waitForTurn(minIntervalMs: number): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, nextAllowedAt - now);
  if (waitMs > 0) await sleep(waitMs);
  nextAllowedAt = Date.now() + minIntervalMs;
}

export async function runZaloRequest<T>(
  options: ZaloRequestOptions,
  request: () => Promise<T>,
): Promise<T> {
  const priority = options.priority ?? 'high';
  const minIntervalMs = options.minIntervalMs ?? (
    priority === 'low' ? LOW_PRIORITY_MIN_INTERVAL_MS : DEFAULT_MIN_INTERVAL_MS
  );
  const retryDelayMs = options.retryDelayMs ?? (
    priority === 'low' ? LOW_PRIORITY_RETRY_DELAY_MS : DEFAULT_RETRY_DELAY_MS
  );
  const maxRetries = options.maxRetries ?? (priority === 'low' ? 0 : 2);

  return enqueue(async () => {
    let attempt = 0;
    while (true) {
      await waitForTurn(minIntervalMs);
      try {
        return await request();
      } catch (err) {
        if (!isZaloRateLimitError(err)) throw err;

        nextAllowedAt = Math.max(nextAllowedAt, Date.now() + retryDelayMs);
        if (attempt >= maxRetries) throw err;

        attempt += 1;
        console.warn(
          `[Zalo] Rate limit for ${options.label}; retry ${attempt}/${maxRetries} after ${Math.round(retryDelayMs / 1000)}s.`,
        );
      }
    }
  });
}
