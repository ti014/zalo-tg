import type { ZaloAPI } from '../../zalo/types.js';
import { settingsStore, store } from '../../store/index.js';
import { getZaloRateLimitStatus } from '../../zalo/rate-limit.js';
import { menuKeyboard, settingsKeyboard, statusKeyboard, type InlineKeyboardMarkup } from './keyboards.js';
import { renderMenu, renderSettings, renderStatus, type MenuViewModel, type StatusViewModel } from './renderers.js';

const bridgeStartedAt = Date.now();
const ACCOUNT_CACHE_TTL_MS = 5_000;

let accountCache: { expiresAt: number; name?: string } | null = null;

export interface UiView {
  text: string;
  replyMarkup: InlineKeyboardMarkup;
}

function formatUptime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}g ${minutes}p ${seconds}s`;
}

function buildMenuModel(api: ZaloAPI | null): MenuViewModel {
  const topics = store.all();
  const groupCount = topics.filter(entry => entry.type === 1).length;
  const dmCount = topics.length - groupCount;
  const uiSettings = settingsStore.get().telegramUi;

  return {
    zaloConnected: api !== null,
    topicCount: topics.length,
    groupCount,
    dmCount,
    compactMode: uiSettings.compactMode,
  };
}

async function getAccountName(api: ZaloAPI | null, forceRefresh: boolean): Promise<string | undefined> {
  if (!api) return undefined;
  const now = Date.now();
  if (!forceRefresh && accountCache && accountCache.expiresAt > now) return accountCache.name;

  try {
    const info = await api.fetchAccountInfo() as {
      profile?: { displayName?: string; zaloName?: string };
    } | undefined;
    const name = info?.profile?.displayName ?? info?.profile?.zaloName;
    accountCache = { expiresAt: now + ACCOUNT_CACHE_TTL_MS, name };
    return name;
  } catch {
    accountCache = { expiresAt: now + ACCOUNT_CACHE_TTL_MS, name: undefined };
    return undefined;
  }
}

export function buildMenuView(getApi: () => ZaloAPI | null): UiView {
  const model = buildMenuModel(getApi());
  return { text: renderMenu(model), replyMarkup: menuKeyboard() };
}

export async function buildStatusView(
  getApi: () => ZaloAPI | null,
  options: { forceRefresh?: boolean; detailed?: boolean } = {},
): Promise<UiView> {
  const api = getApi();
  const uiSettings = settingsStore.get().telegramUi;
  const detailed = options.detailed ?? uiSettings.statusDetails;
  const menuModel = buildMenuModel(api);
  const accountName = detailed
    ? await getAccountName(api, options.forceRefresh ?? false)
    : undefined;
  let rateLimitLine: string | undefined;
  if (detailed) {
    const now = Date.now();
    const rl = getZaloRateLimitStatus(now);
    const parts: string[] = [];
    if (rl.queueLength > 0) parts.push(`queue: ${rl.queueLength}`);
    if (rl.cooldownUntil) parts.push(`cooldown: ${Math.ceil((rl.cooldownUntil - now) / 1000)}s`);
    if (rl.lastRateLimit) {
      const ago = Math.round((now - rl.lastRateLimit.at) / 1000);
      parts.push(`last 221: ${ago}s ago`);
    }
    if (parts.length > 0) rateLimitLine = parts.join(' | ');
  }

  const statusModel: StatusViewModel = {
    ...menuModel,
    uptime: formatUptime(Math.floor((Date.now() - bridgeStartedAt) / 1000)),
    accountName,
    detailed,
    generatedAt: new Date().toLocaleString('vi-VN'),
    rateLimitInfo: rateLimitLine,
  };

  return { text: renderStatus(statusModel), replyMarkup: statusKeyboard() };
}

export function buildSettingsView(): UiView {
  const settings = settingsStore.get().telegramUi;
  return { text: renderSettings(settings), replyMarkup: settingsKeyboard(settings) };
}
