import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Telegraf, Telegram } from 'telegraf';

import { config } from './config.js';
import { escapeHtml } from './utils/format.js';
import { writeJsonAtomicSync } from './infrastructure/files/atomic-file.js';

const UPDATE_STATE_FILE = path.resolve(config.dataDir, 'update-checker.json');
const DEFAULT_UPDATE_REPOSITORY = 'williamcachamwri/zalo-tg';
const DEFAULT_UPSTREAM_BASE_REVISION = '155b6cc';

function updateRepository(): string {
  const value = process.env.UPDATE_REPOSITORY?.trim() || DEFAULT_UPDATE_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('UPDATE_REPOSITORY must use the owner/repository format.');
  }
  return value;
}

function upstreamBaseRevision(): string {
  const value = process.env.UPSTREAM_BASE_REVISION?.trim()
    || DEFAULT_UPSTREAM_BASE_REVISION;
  if (!/^[0-9a-f]{7,40}$/i.test(value)) {
    throw new Error('UPSTREAM_BASE_REVISION must be a 7-40 character Git commit SHA.');
  }
  return value;
}

function loadNotifiedCommit(): string | null {
  if (!existsSync(UPDATE_STATE_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(UPDATE_STATE_FILE, 'utf8')) as {
      notifiedCommit?: string;
    };
    return data.notifiedCommit ?? null;
  } catch {
    return null;
  }
}

function saveNotifiedCommit(commit: string | null): void {
  writeJsonAtomicSync(UPDATE_STATE_FILE, { notifiedCommit: commit }, 2);
}

let notifiedCommit: string | null = loadNotifiedCommit();

export interface UpstreamUpdate {
  commit: string;
  changelog: string;
}

export function parseGitHubCommit(payload: unknown): string {
  const sha = payload && typeof payload === 'object'
    ? (payload as { sha?: unknown }).sha
    : undefined;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error('GitHub commit response has no valid SHA.');
  }
  return sha;
}

/** Validate and reduce GitHub's compare response to the operator-facing update. */
export function parseUpstreamComparison(
  payload: unknown,
  expectedHeadSha?: string,
): UpstreamUpdate | null {
  if (!payload || typeof payload !== 'object') {
    throw new Error('GitHub compare response is invalid.');
  }
  const data = payload as {
    ahead_by?: unknown;
    commits?: Array<{ sha?: unknown; commit?: { message?: unknown } }>;
  };
  const aheadBy = Number(data.ahead_by);
  if (!Number.isSafeInteger(aheadBy) || aheadBy < 0) {
    throw new Error('GitHub compare response has an invalid ahead_by value.');
  }
  if (aheadBy === 0) return null;

  const headSha = expectedHeadSha
    ?? (typeof data.commits?.at(-1)?.sha === 'string' ? data.commits.at(-1)!.sha as string : '');
  if (!/^[0-9a-f]{7,40}$/i.test(headSha)) {
    throw new Error('GitHub compare response has no valid head commit.');
  }
  const changelog = (data.commits ?? [])
    .flatMap(entry => {
      const sha = typeof entry.sha === 'string' ? entry.sha.slice(0, 7) : '';
      const message = typeof entry.commit?.message === 'string'
        ? entry.commit.message.split('\n')[0]?.trim() ?? ''
        : '';
      return sha && message ? [`${sha} ${message}`] : [];
    })
    .slice(-10)
    .reverse()
    .join('\n');
  return { commit: headSha.slice(0, 7), changelog };
}

/** Check the audited upstream baseline without mutating the deployed source tree. */
export async function checkUpstreamUpdate(
  fetchImpl: typeof fetch = fetch,
): Promise<UpstreamUpdate | null> {
  const repository = updateRepository();
  const baseline = upstreamBaseRevision();
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'zalo-tg-update-checker',
  };
  const headResponse = await fetchImpl(
    `https://api.github.com/repos/${repository}/commits/main`,
    { headers, signal: AbortSignal.timeout(15_000) },
  );
  if (!headResponse.ok) {
    throw new Error(`GitHub head check returned HTTP ${headResponse.status}.`);
  }
  const headSha = parseGitHubCommit(await headResponse.json());
  if (headSha.startsWith(baseline)) return null;

  const compareResponse = await fetchImpl(
    `https://api.github.com/repos/${repository}/compare/${baseline}...main`,
    {
      headers,
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!compareResponse.ok) {
    throw new Error(`GitHub update comparison returned HTTP ${compareResponse.status}.`);
  }
  return parseUpstreamComparison(await compareResponse.json(), headSha);
}

export function formatUpdateNotification(commit: string, changelog: string): string {
  const entries = changelog
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map(line => `• ${escapeHtml(line)}`);
  return `<b>Có bản cập nhật upstream mới</b> (<code>${escapeHtml(commit)}</code>)`
    + (entries.length > 0 ? `\n\n${entries.join('\n')}` : '');
}

async function sendUpdateNotification(
  telegram: Telegram,
  update: UpstreamUpdate,
): Promise<void> {
  await telegram.sendMessage(
    config.telegram.groupId,
    formatUpdateNotification(update.commit, update.changelog),
    { parse_mode: 'HTML' },
  );
}

/** Manual, read-only upstream check used by the /update command. */
export async function triggerUpdateCheck(telegram: Telegram): Promise<boolean> {
  const update = await checkUpstreamUpdate();
  if (!update) return false;
  await sendUpdateNotification(telegram, update);
  notifiedCommit = update.commit;
  saveNotifiedCommit(update.commit);
  return true;
}

export interface UpdateCheckerHandle {
  stop(): void;
}

export function startUpdateChecker(bot: Telegraf): UpdateCheckerHandle {
  const timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];
  const check = async (): Promise<void> => {
    try {
      const update = await checkUpstreamUpdate();
      if (!update || notifiedCommit === update.commit) return;
      await sendUpdateNotification(bot.telegram, update);
      notifiedCommit = update.commit;
      saveNotifiedCommit(update.commit);
    } catch (error) {
      console.error('[Updater] Upstream check or notification failed:', error);
    }
  };

  // A current baseline costs two requests per hour; a newer upstream costs
  // four. Both remain comfortably below GitHub's unauthenticated public limit.
  timers.push(setTimeout(check, 60_000));
  timers.push(setInterval(check, 30 * 60_000));

  return {
    stop(): void {
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
    },
  };
}
