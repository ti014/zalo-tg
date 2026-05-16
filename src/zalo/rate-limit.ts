export const ZALO_RATE_LIMIT_CODE = 221;

const DEFAULT_MIN_INTERVAL_MS = 1_200;
const DEFAULT_RETRY_DELAY_MS = 45_000;
const LOW_PRIORITY_MIN_INTERVAL_MS = 2_500;
const LOW_PRIORITY_RETRY_DELAY_MS = 120_000;

type ZaloRequestPriority = 'high' | 'low';

interface QueueItem<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

interface LaneState {
  queue: QueueItem<unknown>[];
  activeRequests: number;
  nextAllowedAt: number;
  concurrency: number;
}

const lanes: Record<ZaloRequestPriority, LaneState> = {
  high: { queue: [], activeRequests: 0, nextAllowedAt: 0, concurrency: 2 },
  low:  { queue: [], activeRequests: 0, nextAllowedAt: 0, concurrency: 1 },
};

let lastRateLimit: { at: number; label: string } | null = null;

export interface ZaloRequestOptions {
  label: string;
  priority?: ZaloRequestPriority;
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

function enqueue<T>(priority: ZaloRequestPriority, task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    lanes[priority].queue.push({ task, resolve: resolve as (value: unknown) => void, reject });
    scheduleLane(priority);
  });
}

function scheduleLane(priority: ZaloRequestPriority): void {
  const lane = lanes[priority];
  while (lane.activeRequests < lane.concurrency && lane.queue.length > 0) {
    const item = lane.queue.shift()!;
    lane.activeRequests += 1;
    void runLaneItem(priority, item);
  }
}

async function runLaneItem(priority: ZaloRequestPriority, item: QueueItem<unknown>): Promise<void> {
  try {
    item.resolve(await item.task());
  } catch (err) {
    item.reject(err);
  } finally {
    lanes[priority].activeRequests = Math.max(0, lanes[priority].activeRequests - 1);
    scheduleLane(priority);
  }
}

async function waitForTurn(lane: LaneState, minIntervalMs: number): Promise<void> {
  const waitMs = Math.max(0, lane.nextAllowedAt - Date.now());
  if (waitMs > 0) await sleep(waitMs);
  lane.nextAllowedAt = Date.now() + minIntervalMs;
}

export interface ZaloRateLimitStatus {
  queueLength: number;
  activeRequests: number;
  cooldownUntil: number | null;
  lastRateLimit: { at: number; label: string } | null;
}

export function getZaloRateLimitStatus(now = Date.now()): ZaloRateLimitStatus {
  const queueLength = lanes.high.queue.length + lanes.low.queue.length;
  const activeRequests = lanes.high.activeRequests + lanes.low.activeRequests;
  const cooldowns = [lanes.high.nextAllowedAt, lanes.low.nextAllowedAt].filter(t => t > now);
  return {
    queueLength,
    activeRequests,
    cooldownUntil: cooldowns.length > 0 ? Math.max(...cooldowns) : null,
    lastRateLimit,
  };
}

export async function runZaloRequest<T>(
  options: ZaloRequestOptions,
  request: () => Promise<T>,
): Promise<T> {
  const priority = options.priority ?? 'high';
  const lane = lanes[priority];
  const minIntervalMs = options.minIntervalMs ?? (
    priority === 'low' ? LOW_PRIORITY_MIN_INTERVAL_MS : DEFAULT_MIN_INTERVAL_MS
  );
  const retryDelayMs = options.retryDelayMs ?? (
    priority === 'low' ? LOW_PRIORITY_RETRY_DELAY_MS : DEFAULT_RETRY_DELAY_MS
  );
  const maxRetries = options.maxRetries ?? (priority === 'low' ? 0 : 2);

  return enqueue(priority, async () => {
    let attempt = 0;
    while (true) {
      await waitForTurn(lane, minIntervalMs);
      try {
        return await request();
      } catch (err) {
        if (!isZaloRateLimitError(err)) throw err;

        lastRateLimit = { at: Date.now(), label: options.label };
        lane.nextAllowedAt = Math.max(lane.nextAllowedAt, Date.now() + retryDelayMs);
        if (attempt >= maxRetries) throw err;

        attempt += 1;
        console.warn(
          `[Zalo] Rate limit for ${options.label}; retry ${attempt}/${maxRetries} after ${Math.round(retryDelayMs / 1000)}s.`,
        );
      }
    }
  });
}
