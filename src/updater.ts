import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Telegraf } from 'telegraf';

import { config } from './config.js';
import { escapeHtml } from './utils/format.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPDATE_STATE_FILE = path.resolve(PROJECT_ROOT, 'data', 'update-checker.json');

function loadNotifiedCommit(): string | null {
  if (!existsSync(UPDATE_STATE_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(UPDATE_STATE_FILE, 'utf8')) as { notifiedCommit?: string };
    return data.notifiedCommit ?? null;
  } catch {
    return null;
  }
}

function saveNotifiedCommit(commit: string | null): void {
  mkdirSync(path.dirname(UPDATE_STATE_FILE), { recursive: true });
  writeFileSync(UPDATE_STATE_FILE, JSON.stringify({ notifiedCommit: commit }, null, 2), 'utf8');
}

// Hash of the commit we already sent a notification for (avoid spam)
let _notifiedCommit: string | null = loadNotifiedCommit();

function gitExec(cmd: string): string {
  return execSync(cmd, { cwd: PROJECT_ROOT, stdio: 'pipe' }).toString().trim();
}

/** Returns the short hash of origin/main if it's ahead of HEAD, else null. */
function getNewCommit(): string | null {
  try {
    gitExec('git fetch origin main --quiet');
    const behind = gitExec('git log HEAD..origin/main --oneline');
    if (!behind) return null;
    return gitExec('git rev-parse --short origin/main');
  } catch {
    return null;
  }
}

/** Human-readable list of new commits (max 10 lines). */
function getChangelog(): string {
  try {
    return gitExec('git log HEAD..origin/main --oneline --no-merges');
  } catch {
    return '';
  }
}

export interface UpdateCheckerHandle {
  stop(): void;
}

export function startUpdateChecker(bot: Telegraf): UpdateCheckerHandle {
  const timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];

  // ── Periodic check mỗi 10 phút ───────────────────────────────────────────
  const check = async () => {
    const commit = getNewCommit();
    if (!commit) return;                    // không có gì mới
    if (_notifiedCommit === commit) return; // đã nhắn rồi

    _notifiedCommit = commit;
    saveNotifiedCommit(commit);
    const changelog = getChangelog();

    try {
      await bot.telegram.sendMessage(
        config.telegram.groupId,
        `🔔 <b>Có bản cập nhật mới!</b> (<code>${commit}</code>)\n\n${
          changelog
            ? changelog.split('\n').slice(0, 10).map(l => `• ${escapeHtml(l)}`).join('\n')
            : ''
        }`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      console.error('[Updater] Failed to send notification:', err);
      _notifiedCommit = null;
      saveNotifiedCommit(null);
    }
  };

  // Kiểm tra 1 phút sau khi khởi động, sau đó mỗi 10 phút
  timers.push(setTimeout(check, 60_000));
  timers.push(setInterval(check, 10 * 60_000));

  return {
    stop(): void {
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
    },
  };
}
