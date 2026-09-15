import { ThreadType } from 'zca-js';

import {
  groupsCache,
  store,
  type TopicNameSource,
} from '../store/index.js';
import { config } from '../config.js';
import { downloadToTemp, cleanTemp } from '../utils/media.js';
import { topicName, escapeHtml } from '../utils/format.js';
import { getCachedGroupInfo, refreshCachedGroupInfo, tg } from './helpers.js';
import { isTopicUnavailableError } from '../domain/topic-errors.js';
import { sendWithOneTopicRetry } from '../domain/topic-retry.js';
import { telegramMediaInput, withTelegramMediaFallback } from '../telegram/media-input.js';
import type { ZaloAPI } from './types.js';

const _pendingTopics = new Map<string, Promise<number>>();

const AUTHORITATIVE_GROUP_NAME_SOURCES = new Set<TopicNameSource>([
  'group_info',
  'group_list',
  'group_event',
]);

export interface TopicPresentation {
  name: string;
  nameSource: TopicNameSource;
  avatarUrl?: string;
}

export function groupTopicPlaceholder(zaloId: string): string {
  return `Nhóm Zalo ${zaloId}`;
}

function isAuthoritativeGroupName(source: TopicNameSource | undefined): boolean {
  return source !== undefined && AUTHORITATIVE_GROUP_NAME_SOURCES.has(source);
}

export async function resolveGroupTopicPresentation(
  api: ZaloAPI,
  zaloId: string,
): Promise<TopicPresentation> {
  const cached = getCachedGroupInfo(zaloId);
  if (cached?.name?.trim()) {
    return {
      name: cached.name.trim(),
      nameSource: 'group_info',
      ...(cached.avt ? { avatarUrl: cached.avt } : {}),
    };
  }

  const refreshed = await refreshCachedGroupInfo(api, zaloId);
  if (refreshed.name?.trim()) {
    return {
      name: refreshed.name.trim(),
      nameSource: 'group_info',
      ...(refreshed.avt ? { avatarUrl: refreshed.avt } : {}),
    };
  }

  const existingTopicId = store.getTopicByZalo(zaloId, ThreadType.Group);
  const existing = existingTopicId === undefined
    ? undefined
    : store.getEntryByTopic(existingTopicId);
  if (existing?.name.trim() && isAuthoritativeGroupName(existing.nameSource)) {
    return {
      name: existing.name.trim(),
      nameSource: existing.nameSource!,
    };
  }

  const listed = groupsCache.get(zaloId);
  if (listed?.name.trim()) {
    return { name: listed.name.trim(), nameSource: 'group_list' };
  }

  if (existing?.name.trim() && existing.nameSource !== 'placeholder') {
    return {
      name: existing.name.trim(),
      nameSource: existing.nameSource ?? 'legacy',
    };
  }

  return {
    name: groupTopicPlaceholder(zaloId),
    nameSource: 'placeholder',
  };
}

export function shouldReplaceStoredName(
  currentName: string,
  nextName: string,
  zaloId: string,
  type: 0 | 1,
  currentSource?: TopicNameSource,
  nextSource?: TopicNameSource,
): boolean {
  const current = currentName.trim();
  const next = nextName.trim();
  if (!next || current === next) return false;
  if (type === ThreadType.User) return true;
  if (nextSource === 'placeholder') return false;
  if (isAuthoritativeGroupName(nextSource)) return true;
  if (currentSource === 'placeholder' && nextSource !== undefined) return true;
  if (current === zaloId) return true;
  return /^\d{8,}$/.test(current) && !/^\d{8,}$/.test(next);
}

export async function getOrCreateTopic(
  zaloId: string,
  type: 0 | 1,
  presentation: TopicPresentation,
  forceRecreate = false,
): Promise<number> {
  if (!forceRecreate) {
    const existing = store.getTopicByZalo(zaloId, type);
    if (existing !== undefined) {
      if (existing > 1) {
        const entry = store.getEntryByTopic(existing);
        if (entry && shouldReplaceStoredName(
          entry.name,
          presentation.name,
          zaloId,
          type,
          entry.nameSource,
          presentation.nameSource,
        )) {
          try {
            await tg.editForumTopic(
              config.telegram.groupId,
              existing,
              { name: topicName(presentation.name, type) },
            );
            store.set({
              ...entry,
              name: presentation.name,
              nameSource: presentation.nameSource,
            });
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

  const promise = doCreateTopic(zaloId, type, presentation)
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
  presentation: TopicPresentation,
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
      return getOrCreateTopic(zaloId, type, presentation, true);
    },
    onRecovered,
  });
}

async function doCreateTopic(
  zaloId: string,
  type: 0 | 1,
  presentation: TopicPresentation,
): Promise<number> {
  const existing = store.getTopicByZalo(zaloId, type);
  if (existing !== undefined) return existing;

  const name  = topicName(presentation.name, type);
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
  store.set({
    topicId,
    zaloId,
    type,
    name: presentation.name,
    nameSource: presentation.nameSource,
  });
  console.log(`[Zalo→TG] New topic: "${name}" (topicId=${topicId})`);

  if (type === 1 && presentation.avatarUrl) {
    try {
      const localPath = await downloadToTemp(presentation.avatarUrl, `avatar_${Date.now()}.jpg`);
      const avatarMsg = await withTelegramMediaFallback(
        forceMultipart => tg.sendPhoto(
          config.telegram.groupId,
          telegramMediaInput(localPath, forceMultipart),
          {
            message_thread_id: topicId,
            caption: `🖼 Ảnh đại diện nhóm <b>${escapeHtml(presentation.name)}</b>`,
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
      console.warn(`[Zalo→TG] Failed to pin group avatar for ${presentation.name}:`, avatarErr);
    }
  }

  return topicId;
}
