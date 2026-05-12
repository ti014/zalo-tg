import { ThreadType } from 'zca-js';
import { createReadStream } from 'fs';

import { store } from '../store/index.js';
import { config } from '../config.js';
import { downloadToTemp, cleanTemp } from '../utils/media.js';
import { topicName, escapeHtml } from '../utils/format.js';
import { tg } from './helpers.js';

const _pendingTopics = new Map<string, Promise<number>>();

function shouldReplaceStoredName(currentName: string, nextName: string, zaloId: string): boolean {
  const current = currentName.trim();
  const next = nextName.trim();
  if (!next || current === next) return false;
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
        if (entry && shouldReplaceStoredName(entry.name, displayName, zaloId)) {
          store.set({ ...entry, name: displayName });
          tg.editForumTopic(config.telegram.groupId, existing, { name: topicName(displayName, type) }).catch(() => undefined);
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
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('message thread not found') || msg.includes('TOPIC_CLOSED') || msg.includes('thread not found');
}

export async function sendWithTopicRecovery<T>(
  zaloId: string,
  type: 0 | 1,
  displayName: string,
  avatarUrl: string | undefined,
  sendFn: (topicId: number) => Promise<T>,
  currentTopicId: number,
): Promise<T> {
  try {
    return await sendFn(currentTopicId);
  } catch (err) {
    if (!isTopicDeletedError(err)) throw err;
    console.warn(`[Zalo→TG] Topic ${currentTopicId} deleted — removing mapping and recreating for ${zaloId}`);
    store.remove(currentTopicId);
    const newTopicId = await getOrCreateTopic(zaloId, type, displayName, avatarUrl, true);
    return sendFn(newTopicId);
  }
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
      console.error(`[Zalo→TG] Cannot create topic — bot lacks "Manage Topics" admin right. Falling back to General topic.`);
      const fallbackId = 1;
      store.set({ topicId: fallbackId, zaloId, type, name: displayName });
      return fallbackId;
    }
    throw err;
  }

  const topicId = topic.message_thread_id;
  store.set({ topicId, zaloId, type, name: displayName });
  console.log(`[Zalo→TG] New topic: "${name}" (topicId=${topicId})`);

  if (type === 1 && avatarUrl) {
    try {
      const localPath = await downloadToTemp(avatarUrl, `avatar_${Date.now()}.jpg`);
      const stream = createReadStream(localPath);
      const avatarMsg = await tg.sendPhoto(
        config.telegram.groupId,
        { source: stream },
        {
          message_thread_id: topicId,
          caption: `🖼 Ảnh đại diện nhóm <b>${escapeHtml(displayName)}</b>`,
          parse_mode: 'HTML',
        },
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
