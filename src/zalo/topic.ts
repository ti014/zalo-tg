import { ThreadType } from 'zca-js';

import { store } from '../store/index.js';
import { config } from '../config.js';
import { downloadToTemp, cleanTemp } from '../utils/media.js';
import { topicName, escapeHtml } from '../utils/format.js';
import { tg } from './helpers.js';
import { isTopicUnavailableError } from '../domain/topic-errors.js';
import { sendWithOneTopicRetry } from '../domain/topic-retry.js';
import { telegramMediaInput, withTelegramMediaFallback } from '../telegram/media-input.js';

const _pendingTopics = new Map<string, Promise<number>>();

export function shouldReplaceStoredName(
  currentName: string,
  nextName: string,
  zaloId: string,
  type: 0 | 1,
): boolean {
  const current = currentName.trim();
  const next = nextName.trim();
  if (!next || current === next) return false;
  if (type === ThreadType.User) return true;
  if (current === zaloId) return true;
  return /^\d{8,}$/.test(current) && !/^\d{8,}$/.test(next);
}

export async function getOrCreateTopic(
  zaloId: string,
  type: 0 | 1,
  displayName: string,
  avatarUrl?: string,
  forceRecreate = false,
): Promise<number> {
  if (!forceRecreate) {
    const existing = store.getTopicByZalo(zaloId, type);
    if (existing !== undefined) {
      if (existing > 1) {
        const entry = store.getEntryByTopic(existing);
        if (entry && shouldReplaceStoredName(entry.name, displayName, zaloId, type)) {
          try {
            await tg.editForumTopic(
              config.telegram.groupId,
              existing,
              { name: topicName(displayName, type) },
            );
            store.set({ ...entry, name: displayName });
          } catch (error) {
            if (isTopicDeletedError(error)) throw error;
            console.warn(`[Zalo→TG] Failed to refresh topic name for ${zaloId}:`, error);
          }
        }
        return existing;
      }
      console.warn(`[Zalo→TG] Topic ${existing} is not a usable forum topic — removing stale mapping for ${zaloId}`);
      store.remove(existing);
    }
  }

  const pendingKey = `${type}:${zaloId}`;
  const inFlight = _pendingTopics.get(pendingKey);
  if (inFlight) return inFlight;

  const promise = doCreateTopic(zaloId, type, displayName, avatarUrl)
    .finally(() => _pendingTopics.delete(pendingKey));
  _pendingTopics.set(pendingKey, promise);
  return promise;
}

export function isTopicDeletedError(err: unknown): boolean {
  return isTopicUnavailableError(err);
}

export async function sendWithTopicRecovery<T>(
  zaloId: string,
  type: 0 | 1,
  displayName: string,
  avatarUrl: string | undefined,
  sendFn: (topicId: number) => Promise<T>,
  currentTopicId: number,
  onRecovered?: (topicId: number) => void,
): Promise<T> {
  return sendWithOneTopicRetry({
    topicId: currentTopicId,
    send: sendFn,
    isUnavailable: isTopicDeletedError,
    recover: async staleTopicId => {
      console.warn(`[Zalo→TG] Topic ${staleTopicId} deleted — removing mapping and recreating for ${zaloId}`);
      store.remove(staleTopicId);
      return getOrCreateTopic(zaloId, type, displayName, avatarUrl, true);
    },
    onRecovered,
  });
}

async function doCreateTopic(
  zaloId: string,
  type: 0 | 1,
  displayName: string,
  avatarUrl?: string,
): Promise<number> {
  const existing = store.getTopicByZalo(zaloId, type);
  if (existing !== undefined) return existing;

  const name  = topicName(displayName, type);
  const color = type === ThreadType.Group ? 0xFF93B2 : 0x6FB9F0;

  let topic: { message_thread_id: number };
  try {
    topic = await tg.createForumTopic(
      config.telegram.groupId,
      name,
      { icon_color: color },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not enough rights') || msg.includes('TOPIC_') || msg.includes('rights to manage')) {
      throw Object.assign(
        new Error(
          'Telegram bot lacks the Manage Topics permission; refusing General-topic fallback.',
          { cause: err },
        ),
        { code: 'TELEGRAM_MANAGE_TOPICS_REQUIRED' },
      );
    }
    throw err;
  }

  const topicId = topic.message_thread_id;
  store.set({ topicId, zaloId, type, name: displayName });
  console.log(`[Zalo→TG] New topic: "${name}" (topicId=${topicId})`);

  if (type === 1 && avatarUrl) {
    try {
      const localPath = await downloadToTemp(avatarUrl, `avatar_${Date.now()}.jpg`);
      const avatarMsg = await withTelegramMediaFallback(
        forceMultipart => tg.sendPhoto(
          config.telegram.groupId,
          telegramMediaInput(localPath, forceMultipart),
          {
            message_thread_id: topicId,
            caption: `🖼 Ảnh đại diện nhóm <b>${escapeHtml(displayName)}</b>`,
            parse_mode: 'HTML',
          },
        ),
        'Group avatar upload',
      );
      await cleanTemp(localPath);
      try {
        await tg.pinChatMessage(config.telegram.groupId, avatarMsg.message_id, { disable_notification: true });
      } catch { /* pinning requires admin rights */ }
    } catch (avatarErr) {
      console.warn(`[Zalo→TG] Failed to pin group avatar for ${displayName}:`, avatarErr);
    }
  }

  return topicId;
}
