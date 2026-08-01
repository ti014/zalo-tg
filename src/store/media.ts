import type { ZaloQuoteData } from './messages.js';

export interface MediaGroupItem {
  fileId:    string;
  fname:     string;
  fileSize?: number;
  caption?:  string;
  captionMentions?: Array<{ pos: number; uid: string; len: number }>;
}

interface MediaGroupBuffer {
  timer:      ReturnType<typeof setTimeout>;
  items:      MediaGroupItem[];
  topicId:    number;
  zaloId:     string;
  threadType: 0 | 1;
  replyToMsgId?: number;
}

const _mgBuffers = new Map<string, MediaGroupBuffer>();

function safeFlush(label: string, fn: () => unknown): void {
  try {
    Promise.resolve(fn()).catch(err => {
      console.error(`[${label}] flush failed:`, (err as Error)?.message ?? err);
    });
  } catch (err) {
    console.error(`[${label}] flush threw:`, (err as Error)?.message ?? err);
  }
}

export const mediaGroupStore = {
  add(
    groupId: string,
    item: MediaGroupItem,
    meta: Omit<MediaGroupBuffer, 'timer' | 'items'>,
    onFlush: (items: MediaGroupItem[], meta: Omit<MediaGroupBuffer, 'timer' | 'items'>) => void,
  ): void {
    const existing = _mgBuffers.get(groupId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.items.push(item);
      existing.timer = setTimeout(() => {
        _mgBuffers.delete(groupId);
        safeFlush('mediaGroupStore', () => onFlush(existing.items, existing));
      }, 500);
    } else {
      const buf: MediaGroupBuffer = {
        ...meta,
        items: [item],
        timer: setTimeout(() => {
          _mgBuffers.delete(groupId);
          safeFlush('mediaGroupStore', () => onFlush(buf.items, buf));
        }, 500),
      };
      _mgBuffers.set(groupId, buf);
    }
  },
};

interface ZaloAlbumItem {
  urls:      string[];
  msgIds:    string[];
  zaloQuote: ZaloQuoteData | undefined;
}

interface ZaloAlbumBuffer {
  timer:      ReturnType<typeof setTimeout>;
  items:      ZaloAlbumItem[];
  senderName: string;
  topicId:    number;
  tgBase:     {
    message_thread_id: number;
    disable_notification?: boolean;
    reply_parameters?: { message_id: number; allow_sending_without_reply: boolean };
  };
  caption?:   string;
}

const _zaloAlbumBuffers = new Map<string, ZaloAlbumBuffer>();

export const zaloAlbumStore = {
  add(
    key: string,
    urls: readonly string[],
    msgIds: readonly string[],
    caption: string | undefined,
    meta: Omit<ZaloAlbumBuffer, 'timer' | 'items' | 'caption'> & {
      zaloQuote: ZaloQuoteData | undefined;
    },
    onFlush: (buf: Omit<ZaloAlbumBuffer, 'timer'>) => void,
  ): void {
    const candidates = Array.from(new Set(urls.map(url => url.trim()).filter(Boolean)));
    if (candidates.length === 0) return;
    const { zaloQuote, ...bufferMeta } = meta;
    const item: ZaloAlbumItem = {
      urls: candidates,
      msgIds: Array.from(new Set(msgIds.map(String).map(id => id.trim()).filter(Boolean))),
      zaloQuote,
    };
    const flush = (buffer: ZaloAlbumBuffer): void => {
      _zaloAlbumBuffers.delete(key);
      safeFlush('zaloAlbumStore', () => onFlush({
        items: buffer.items,
        senderName: buffer.senderName,
        topicId: buffer.topicId,
        tgBase: buffer.tgBase,
        caption: buffer.caption,
      }));
    };
    const flushDelayMs = 600;
    const existing = _zaloAlbumBuffers.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      const incomingUrls = new Set(item.urls);
      const duplicate = existing.items.find(existingItem =>
        existingItem.urls.some(url => incomingUrls.has(url)));
      if (duplicate) {
        duplicate.urls = Array.from(new Set([...duplicate.urls, ...item.urls]));
        duplicate.msgIds = Array.from(new Set([...duplicate.msgIds, ...item.msgIds]));
      } else {
        existing.items.push(item);
      }
      if (!existing.caption && caption) existing.caption = caption;
      existing.timer = setTimeout(() => flush(existing), flushDelayMs);
    } else {
      const buf: ZaloAlbumBuffer = {
        ...bufferMeta,
        items: [item],
        caption,
        timer: setTimeout(() => flush(buf), flushDelayMs),
      };
      _zaloAlbumBuffers.set(key, buf);
    }
  },
};
