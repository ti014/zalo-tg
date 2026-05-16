import { CloseReason } from 'zca-js';
import { getZaloApi, resetZaloApi } from './zalo/client.js';
import { setupZaloHandler } from './zalo/handler.js';
import type { ZaloAPI } from './zalo/types.js';
import { tgBot, syncTelegramCommands } from './telegram/bot.js';
import { setupTelegramHandler } from './telegram/handler.js';
import { config } from './config.js';
import { startUpdateChecker, type UpdateCheckerHandle } from './updater.js';
import { store, flushMsgStore } from './store/index.js';
import { acquireInstanceLock, type InstanceLock } from './runtime/single-instance.js';
import { runZaloRequest } from './zalo/rate-limit.js';

let setZaloApiRef: ((api: ZaloAPI) => void) | null = null;
let activeZaloApi: ZaloAPI | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnecting = false;
let shuttingDown = false;
let reconnectDelayMs = 5_000;
let lastZaloEventAt = Date.now();
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let updateChecker: UpdateCheckerHandle | null = null;
let instanceLock: InstanceLock | null = null;

const startedZaloListeners = new WeakSet<object>();
const wiredDisconnectHandlers = new WeakSet<object>();

function clearReconnectTimer(): void {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function stopZaloWatchdog(): void {
  if (!watchdogTimer) return;
  clearInterval(watchdogTimer);
  watchdogTimer = null;
}

function touchZaloEvent(): void {
  lastZaloEventAt = Date.now();
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout after ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function stopZaloListener(api: ZaloAPI | null): Promise<void> {
  if (!api) return;
  try {
    await withTimeout(api.listener.stop(), 10_000, 'Zalo listener stop');
  } catch (err) {
    console.warn('[Boot] Failed to stop Zalo listener:', err);
  }
}

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Boot] Received ${signal}, shutting down...`);
  clearReconnectTimer();
  updateChecker?.stop();
  stopZaloWatchdog();
  await stopZaloListener(activeZaloApi);
  try { tgBot.stop(signal); } catch { /* ignore */ }
  try { flushMsgStore(); } catch { /* ignore */ }
  instanceLock?.release();
  process.exit(exitCode);
}

process.on('unhandledRejection', (reason) => {
  console.error('[Boot] Unhandled rejection — exiting:', reason);
  void shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  console.error('[Boot] Uncaught exception — exiting:', err);
  void shutdown('uncaughtException', 1);
});

async function pruneLeftGroupTopics(api: ZaloAPI): Promise<void> {
  try {
    const groups = await runZaloRequest(
      { label: 'getAllGroups(pruneLeftGroupTopics)', priority: 'low', maxRetries: 0 },
      () => api.getAllGroups(),
    ) as { gridVerMap?: Record<string, string> } | undefined;
    const activeGroupIds = new Set(Object.keys(groups?.gridVerMap ?? {}));
    const removed: string[] = [];

    for (const entry of store.all()) {
      if (entry.type === 1 && !activeGroupIds.has(entry.zaloId)) {
        store.remove(entry.topicId);
        removed.push(`${entry.name} (${entry.zaloId})`);
      }
    }

    if (removed.length > 0) {
      console.log(`[Boot] Pruned ${removed.length} stale group topic(s): ${removed.join(', ')}`);
    }
  } catch (err) {
    console.warn('[Boot] Could not prune stale group topics:', err);
  }
}

function scheduleZaloReconnect(delayMs = reconnectDelayMs): void {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void reconnectZalo();
  }, delayMs);
}

async function reconnectZalo(): Promise<void> {
  if (shuttingDown || reconnecting) return;
  stopZaloWatchdog();
  reconnecting = true;
  try {
    await stopZaloListener(activeZaloApi);
    resetZaloApi();
    const newApi = await getZaloApi();
    await startZalo(newApi, true);
    reconnectDelayMs = 5_000;
    tgBot.telegram.sendMessage(config.telegram.groupId, 'Zalo đã kết nối lại.').catch(() => undefined);
    console.log('[Boot] Zalo reconnected ✓');
  } catch (err) {
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60_000);
    console.error('[Boot] Zalo reconnect failed:', err);
    tgBot.telegram.sendMessage(
      config.telegram.groupId,
      `Kết nối lại Zalo thất bại. Sẽ thử lại sau ${Math.round(reconnectDelayMs / 1000)} giây. Dùng <b>/login</b> nếu phiên đã hết hạn.`,
      { parse_mode: 'HTML' },
    ).catch(() => undefined);
    scheduleZaloReconnect(reconnectDelayMs);
  } finally {
    reconnecting = false;
  }
}

function startZaloWatchdog(api: ZaloAPI): void {
  stopZaloWatchdog();
  lastZaloEventAt = Date.now();

  const eventNames = ['message', 'undo', 'reaction', 'group_event', 'friend_event'];
  for (const eventName of eventNames) {
    api.listener.on(eventName, touchZaloEvent);
  }

  watchdogTimer = setInterval(() => {
    if (shuttingDown || reconnecting || api !== activeZaloApi) return;
    const idleMs = Date.now() - lastZaloEventAt;
    if (idleMs < 5 * 60_000) return;
    console.warn(`[Boot] Zalo listener idle for ${Math.round(idleMs / 1000)}s, reconnecting...`);
    void reconnectZalo();
  }, 60_000);
}

async function startZalo(api: ZaloAPI, isReconnect = false): Promise<void> {
  if (shuttingDown) return;
  clearReconnectTimer();

  if (activeZaloApi && activeZaloApi !== api) {
    await stopZaloListener(activeZaloApi);
  }

  activeZaloApi = api;
  setZaloApiRef?.(api);

  if (!isReconnect) void pruneLeftGroupTopics(api);
  await setupZaloHandler(api);

  if (!startedZaloListeners.has(api as object)) {
    api.listener.start();
    startedZaloListeners.add(api as object);
  }
  console.log(`[Boot] Zalo listener ${isReconnect ? 're' : ''}started ✓`);
  startZaloWatchdog(api);

  if (!wiredDisconnectHandlers.has(api as object)) {
    wiredDisconnectHandlers.add(api as object);
    api.listener.once('disconnected', (code: CloseReason) => {
      if (api !== activeZaloApi || shuttingDown || (code as number) === 1000) return;

      console.warn(`[Boot] Zalo disconnected (code=${code}), reconnecting in ${Math.round(reconnectDelayMs / 1000)} s...`);
      tgBot.telegram.sendMessage(
        config.telegram.groupId,
        'Zalo bị ngắt kết nối, đang thử kết nối lại...',
      ).catch(() => undefined);

      scheduleZaloReconnect();
    });
  }
}

async function main(): Promise<void> {
  instanceLock = acquireInstanceLock();

  console.log('╔══════════════════════════════════════╗');
  console.log('║   Zalo ↔ Telegram Bridge  v1.0.0    ║');
  console.log('╚══════════════════════════════════════╝');

  updateChecker = startUpdateChecker(tgBot);

  const setZaloApi = setupTelegramHandler(null, async (newApi) => {
    await startZalo(newApi, true);
  });
  setZaloApiRef = setZaloApi;

  tgBot.launch({ allowedUpdates: ['message', 'callback_query', 'message_reaction', 'poll_answer', 'poll'] }, () => {
    console.log('[Boot] Telegram bot started ✓');

    syncTelegramCommands()
      .then(() => console.log('[Boot] Telegram command menu synced ✓'))
      .catch((err: unknown) => console.warn('[Boot] Failed to sync Telegram commands:', err));

    getZaloApi()
      .then(async (api) => {
        await startZalo(api);
      })
      .catch((err: unknown) => {
        console.warn('[Boot] Zalo auto-login failed:', err);
        tgBot.telegram
          .sendMessage(
            config.telegram.groupId,
            '⚠️ Chưa đăng nhập Zalo. Gửi <b>/login</b> để đăng nhập.',
            { parse_mode: 'HTML' },
          )
          .catch(() => undefined);
      });
  });

  console.log('[Boot] Bridge is running 🚀  (Ctrl+C to stop)');

  process.once('SIGINT',  () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

main().catch((err: unknown) => {
  console.error('[Boot] Fatal error:', err);
  instanceLock?.release();
  process.exit(1);
});
