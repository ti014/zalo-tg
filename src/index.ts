import { CloseReason } from 'zca-js';
import { statfsSync } from 'node:fs';
import { getZaloApi, resetZaloApi } from './zalo/client.js';
import { setupZaloHandler } from './zalo/handler.js';
import type { ZaloAPI } from './zalo/types.js';
import { tgBot, syncTelegramCommands } from './telegram/bot.js';
import { setupTelegramHandler, type TelegramHandlerHandle } from './telegram/handler.js';
import { config } from './config.js';
import { startUpdateChecker, type UpdateCheckerHandle } from './updater.js';
import { store, flushMsgStore } from './store/index.js';
import { runZaloRequest } from './zalo/rate-limit.js';
import { runtimeHealth } from './runtime/health.js';
import {
  closeBridgeDatabase,
  openBridgeDatabase,
  type BridgeDatabase,
} from './infrastructure/database/database.js';
import {
  configureSqliteShadow,
  disableSqliteShadow,
} from './infrastructure/database/shadow-state.js';
import {
  acquireSqliteInstanceLease,
  type SqliteInstanceLease,
} from './runtime/sqlite-instance-lease.js';
import { importLegacyState } from './infrastructure/database/legacy-import.js';
import { DeliveryRepository } from './infrastructure/database/delivery-repository.js';
import { MediaSpool } from './infrastructure/media/media-spool.js';
import { DurableZaloRelay } from './application/durable-zalo.js';
import { handleZaloMessage } from './zalo/message-handler.js';
import {
  configureRuntimeMediaSpool,
  disableRuntimeMediaSpool,
} from './application/durable-media.js';
import { hydrateCompatibilityStores } from './bootstrap/hydrate-stores.js';
import { installConsoleRedaction } from './runtime/redacted-console.js';
import { verifyTelegramDeployment } from './telegram/deployment-preflight.js';
import { clearBridgeMappings } from './application/clear-mappings.js';
import type { MappingClearPreparation } from './telegram/types.js';

installConsoleRedaction([config.telegram.token]);

let setZaloApiRef: ((api: ZaloAPI) => void) | null = null;
let activeZaloApi: ZaloAPI | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnecting = false;
let shuttingDown = false;
let reconnectDelayMs = 5_000;
let updateChecker: UpdateCheckerHandle | null = null;
let activeDatabase: BridgeDatabase | null = null;
let instanceLease: SqliteInstanceLease | null = null;
let telegramHandler: TelegramHandlerHandle | null = null;
let durableZaloRelay: DurableZaloRelay | null = null;
let mediaMaintenanceTimer: ReturnType<typeof setInterval> | null = null;
let mappingClearReserved = false;

const MEDIA_MAINTENANCE_INTERVAL_MS = 60 * 60_000;

const startedZaloListeners = new WeakSet<object>();
const wiredDisconnectHandlers = new WeakSet<object>();

function clearReconnectTimer(): void {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function clearMediaMaintenanceTimer(): void {
  if (!mediaMaintenanceTimer) return;
  clearInterval(mediaMaintenanceTimer);
  mediaMaintenanceTimer = null;
}

function startMediaMaintenance(
  mediaSpool: MediaSpool,
  deliveryRepository: DeliveryRepository,
): void {
  clearMediaMaintenanceTimer();
  const runMaintenance = () => {
    try {
      const detached = mediaSpool.detachTerminalDeliveries();
      const cleanup = mediaSpool.cleanupExpired();
      const purged = deliveryRepository.purgeTerminalBefore(
        Date.now() - config.delivery.sentRetentionMs,
      );
      const filesystem = statfsSync(config.dataDir);
      const freeBytes = filesystem.bavail * filesystem.bsize;
      const storageHealth = freeBytes < config.storage.minFreeBytes
        ? 'degraded'
        : 'ready';
      runtimeHealth.set('storage', storageHealth);
      if (storageHealth === 'degraded') {
        console.error(
          `[Storage] Free space is below the configured floor: ${freeBytes} `
          + `< ${config.storage.minFreeBytes} bytes.`,
        );
      }
      if (
        detached > 0
        || cleanup.deleted > 0
        || cleanup.missing > 0
        || cleanup.failed > 0
        || purged.deliveriesDeleted > 0
        || purged.inboxEventsDeleted > 0
      ) {
        console.log(
          `[Storage] Media maintenance: ${detached} terminal link(s) detached, `
          + `${cleanup.deleted} expired object(s) deleted, ${cleanup.missing} already missing, `
          + `${cleanup.failed} failed; queue retention deleted `
          + `${purged.deliveriesDeleted} delivery row(s) and `
          + `${purged.inboxEventsDeleted} inbox row(s).`,
        );
      }
    } catch (error) {
      console.warn('[Storage] Media maintenance failed:', error);
      runtimeHealth.set('storage', 'degraded');
    }
  };
  runMaintenance();
  mediaMaintenanceTimer = setInterval(runMaintenance, MEDIA_MAINTENANCE_INTERVAL_MS);
  mediaMaintenanceTimer.unref();
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

async function shutdown(
  signal: string,
  exitCode = 0,
  maintenance?: () => void | Promise<void>,
): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  let finalExitCode = exitCode;
  runtimeHealth.beginShutdown();
  console.log(`\n[Boot] Received ${signal}, shutting down...`);
  clearReconnectTimer();
  clearMediaMaintenanceTimer();
  updateChecker?.stop();
  const apiAtShutdown = activeZaloApi;
  telegramHandler?.clearApi(apiAtShutdown ?? undefined);
  durableZaloRelay?.clearApi(apiAtShutdown ?? undefined);
  activeZaloApi = null;
  await stopZaloListener(apiAtShutdown);
  try { tgBot.stop(signal); } catch { /* ignore */ }
  const stopZaloDelivery = durableZaloRelay?.stop().catch(error => {
    console.warn('[Boot] Failed to stop Zalo delivery worker:', error);
  });
  const stopTelegramDelivery = telegramHandler?.stop().catch(error => {
    console.warn('[Boot] Failed to stop Telegram delivery worker:', error);
  });
  await Promise.all([stopZaloDelivery, stopTelegramDelivery]);
  durableZaloRelay = null;
  telegramHandler = null;
  if (maintenance) {
    try {
      await maintenance();
    } catch (error) {
      finalExitCode = 1;
      console.error('[Boot] Shutdown maintenance failed:', error);
    }
  }
  try { flushMsgStore(); } catch { /* ignore */ }
  instanceLease?.release();
  instanceLease = null;
  disableRuntimeMediaSpool();
  disableSqliteShadow();
  if (activeDatabase) {
    try {
      closeBridgeDatabase(activeDatabase);
    } catch (error) {
      console.warn('[Boot] Failed to close SQLite cleanly:', error);
    }
    activeDatabase = null;
  }
  runtimeHealth.set('storage', 'stopped');
  runtimeHealth.stop();
  process.exit(finalExitCode);
}

function activeDeliveryCount(repository: DeliveryRepository): number {
  return repository.statusCounts()
    .filter(row => row.status !== 'SENT' && row.status !== 'SKIPPED')
    .reduce((sum, row) => sum + row.count, 0);
}

function prepareMappingClear(repository: DeliveryRepository): MappingClearPreparation {
  if (shuttingDown) {
    return { accepted: false, activeDeliveries: 0, reason: 'shutting_down' };
  }
  if (mappingClearReserved) {
    return { accepted: false, activeDeliveries: 0, reason: 'already_scheduled' };
  }
  const activeDeliveries = activeDeliveryCount(repository);
  if (activeDeliveries > 0) {
    return { accepted: false, activeDeliveries, reason: 'active_deliveries' };
  }

  mappingClearReserved = true;
  let settled = false;
  return {
    accepted: true,
    activeDeliveries: 0,
    start(): void {
      if (settled) return;
      settled = true;
      void shutdown('mappingClear', 0, async () => {
        const activeAfterDrain = activeDeliveryCount(repository);
        if (activeAfterDrain > 0) {
          await tgBot.telegram.sendMessage(
            config.telegram.groupId,
            `Đã hủy clear vì phát hiện ${activeAfterDrain} delivery chưa kết thúc trong lúc dừng relay. `
            + 'Bridge sẽ khởi động lại mà không thay đổi mapping.',
          ).catch(() => undefined);
          return;
        }
        const cleared = clearBridgeMappings();
        await tgBot.telegram.sendMessage(
          config.telegram.groupId,
          `Đã xóa ${cleared.topics} topic mapping và toàn bộ message mapping của group hiện tại. `
          + 'Các Telegram topic cũ vẫn được giữ nguyên. Bridge đang khởi động lại.',
        ).catch(() => undefined);
      });
    },
    cancel(): void {
      if (settled) return;
      settled = true;
      mappingClearReserved = false;
    },
  };
}

process.on('unhandledRejection', (reason) => {
  console.error('[Boot] Unhandled rejection — exiting:', reason);
  void shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  console.error('[Boot] Uncaught exception — exiting:', err);
  void shutdown('uncaughtException', 1);
});
process.once('SIGINT',  () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

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

function scheduleZaloReconnect(delayMs = reconnectDelayMs, notifyTelegram = true): void {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void reconnectZalo(notifyTelegram);
  }, delayMs);
}

async function reconnectZalo(notifyTelegram = true): Promise<void> {
  if (shuttingDown || reconnecting) return;
  reconnecting = true;
  runtimeHealth.set('zalo', 'starting');
  try {
    const previousApi = activeZaloApi;
    telegramHandler?.clearApi(previousApi ?? undefined);
    durableZaloRelay?.clearApi(previousApi ?? undefined);
    activeZaloApi = null;
    await stopZaloListener(previousApi);
    resetZaloApi();
    const newApi = await getZaloApi();
    await startZalo(newApi, true);
    reconnectDelayMs = 5_000;
    runtimeHealth.set('zalo', 'ready');
    if (notifyTelegram) {
      tgBot.telegram.sendMessage(config.telegram.groupId, 'Zalo đã kết nối lại.').catch(() => undefined);
    }
    console.log('[Boot] Zalo reconnected ✓');
  } catch (err) {
    const failedApi = activeZaloApi;
    telegramHandler?.clearApi(failedApi ?? undefined);
    durableZaloRelay?.clearApi(failedApi ?? undefined);
    activeZaloApi = null;
    await stopZaloListener(failedApi);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 60_000);
    console.error('[Boot] Zalo reconnect failed:', err);
    runtimeHealth.set('zalo', 'degraded');
    if (notifyTelegram) {
      tgBot.telegram.sendMessage(
        config.telegram.groupId,
        `Kết nối lại Zalo thất bại. Sẽ thử lại sau ${Math.round(reconnectDelayMs / 1000)} giây. Dùng <b>/login</b> nếu phiên đã hết hạn.`,
        { parse_mode: 'HTML' },
      ).catch(() => undefined);
    }
    scheduleZaloReconnect(reconnectDelayMs, notifyTelegram);
  } finally {
    reconnecting = false;
  }
}

async function startZalo(api: ZaloAPI, isReconnect = false): Promise<void> {
  if (shuttingDown) return;
  clearReconnectTimer();

  if (activeZaloApi && activeZaloApi !== api) {
    const previousApi = activeZaloApi;
    telegramHandler?.clearApi(previousApi);
    durableZaloRelay?.clearApi(previousApi);
    activeZaloApi = null;
    await stopZaloListener(previousApi);
  }

  activeZaloApi = api;
  durableZaloRelay?.setApi(api);
  setZaloApiRef?.(api);

  if (!isReconnect) void pruneLeftGroupTopics(api);
  await setupZaloHandler(api, durableZaloRelay ?? undefined);

  if (!startedZaloListeners.has(api as object)) {
    api.listener.start();
    startedZaloListeners.add(api as object);
  }
  console.log(`[Boot] Zalo listener ${isReconnect ? 're' : ''}started ✓`);
  runtimeHealth.set('zalo', 'ready');

  if (!wiredDisconnectHandlers.has(api as object)) {
    wiredDisconnectHandlers.add(api as object);
    api.listener.on('connected', () => {
      if (api === activeZaloApi) reconnectDelayMs = 5_000;
    });
    api.listener.on('error', (err: unknown) => {
      if (api === activeZaloApi && !shuttingDown) {
        console.error('[Boot] Zalo listener error:', err);
      }
    });
    api.listener.once('disconnected', (code: CloseReason) => {
      if (api !== activeZaloApi || shuttingDown) return;

      runtimeHealth.set('zalo', 'degraded');
      durableZaloRelay?.clearApi(api);
      telegramHandler?.clearApi(api);
      activeZaloApi = null;
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
  process.umask(0o077);
  runtimeHealth.start(config.runtime.healthDir);
  activeDatabase = openBridgeDatabase(config.databasePath);
  instanceLease = acquireSqliteInstanceLease(activeDatabase, {
    onLost: error => {
      console.error('[Boot] SQLite instance lease lost:', error);
      void shutdown('instanceLeaseLost', 1);
    },
  });
  const legacyImport = importLegacyState(
    activeDatabase,
    config.dataDir,
    config.telegram.groupId,
  );
  console.log(
    `[Storage] Legacy import: ${legacyImport.recordsImported} imported, `
    + `${legacyImport.recordsQuarantined} quarantined, `
    + `${legacyImport.files.filter(file => file.status === 'skipped').length} unchanged file(s).`,
  );
  configureSqliteShadow(activeDatabase, config.telegram.groupId);
  const hydration = hydrateCompatibilityStores(activeDatabase, config.telegram.groupId);
  console.log(
    `[Storage] SQLite hydration: ${hydration.topics} topic(s), `
    + `${hydration.incomingMessageLinks} incoming link(s), `
    + `${hydration.sentMessageLinks} sent link(s), ${hydration.aliases} alias(es), `
    + `settings=${hydration.settings ? 'restored' : 'default'}.`,
  );
  const mediaSpool = new MediaSpool(activeDatabase, config.dataDir, {
    maxObjectBytes: config.media.maxObjectBytes,
    maxTotalBytes: config.media.maxSpoolBytes,
  });
  configureRuntimeMediaSpool(mediaSpool);
  const mediaRecovery = mediaSpool.recoverStaleDownloads();
  const detachedTerminalMedia = mediaSpool.detachTerminalDeliveries();
  const mediaCleanup = mediaSpool.cleanupExpired();
  console.log(
    `[Storage] Media spool: ${mediaRecovery.recovered} recovered, `
    + `${mediaRecovery.failed} failed, ${detachedTerminalMedia} terminal link(s) detached, `
    + `${mediaCleanup.deleted} expired object(s) deleted.`,
  );
  const deliveryRepository = new DeliveryRepository(activeDatabase);
  startMediaMaintenance(mediaSpool, deliveryRepository);
  durableZaloRelay = new DurableZaloRelay({
    repository: deliveryRepository,
    processMessage: handleZaloMessage,
    mediaSpool,
    onFatal: error => {
      console.error('[Boot] Durable Zalo delivery fatal error:', error);
      void shutdown('durableZaloDeliveryFatal', 1);
    },
  });
  durableZaloRelay.start();

  console.log('╔══════════════════════════════════════╗');
  console.log('║   Zalo ↔ Telegram Bridge  v1.0.0    ║');
  console.log('╚══════════════════════════════════════╝');

  telegramHandler = setupTelegramHandler(null, async (newApi) => {
    try {
      await startZalo(newApi, true);
    } catch (error) {
      telegramHandler?.clearApi(newApi);
      durableZaloRelay?.clearApi(newApi);
      if (activeZaloApi === newApi) activeZaloApi = null;
      await stopZaloListener(newApi);
      throw error;
    }
  }, {
    deliveryRepository,
    prepareMappingClear: () => prepareMappingClear(deliveryRepository),
    onFatal: error => {
      console.error('[Boot] Durable delivery fatal error:', error);
      void shutdown('durableDeliveryFatal', 1);
    },
  });
  setZaloApiRef = telegramHandler.setApi;

  let resolveTelegramReady!: () => void;
  let rejectTelegramReady!: (reason: unknown) => void;
  const telegramReady = new Promise<void>((resolve, reject) => {
    resolveTelegramReady = resolve;
    rejectTelegramReady = reject;
  });

  const pollingPromise = tgBot.launch(
    { allowedUpdates: ['message', 'callback_query', 'message_reaction', 'poll_answer', 'poll'] },
    resolveTelegramReady,
  );
  void pollingPromise.catch(rejectTelegramReady);
  await telegramReady;
  await verifyTelegramDeployment(tgBot, config.telegram.groupId);

  console.log('[Boot] Telegram deployment preflight ✓');
  console.log('[Boot] Telegram bot started ✓');
  await syncTelegramCommands();
  runtimeHealth.set('telegram', 'ready');
  console.log('[Boot] Telegram command menu synced ✓');
  console.log('[Boot] Bridge is running (Ctrl+C to stop)');
  if (config.runtime.updateCheckerEnabled) updateChecker = startUpdateChecker(tgBot);

  void getZaloApi()
    .then(startZalo)
    .catch(async (err: unknown) => {
      const failedApi = activeZaloApi;
      telegramHandler?.clearApi(failedApi ?? undefined);
      durableZaloRelay?.clearApi(failedApi ?? undefined);
      activeZaloApi = null;
      await stopZaloListener(failedApi);
      console.warn('[Boot] Zalo auto-login failed:', err);
      runtimeHealth.set('zalo', 'degraded');
      return tgBot.telegram.sendMessage(
        config.telegram.groupId,
        'Chưa đăng nhập Zalo. Gửi <b>/login</b> để đăng nhập.',
        { parse_mode: 'HTML' },
      ).catch(() => undefined);
    });

  await pollingPromise;
  if (!shuttingDown) throw new Error('Telegram polling stopped unexpectedly');
}

main().catch((err: unknown) => {
  console.error('[Boot] Fatal error:', err);
  void shutdown('fatalError', 1);
});
