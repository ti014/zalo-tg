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
        onFlush(existing.items, existing);
      }, 500);
    } else {
      const buf: MediaGroupBuffer = {
        ...meta,
        items: [item],
        timer: setTimeout(() => {
          _mgBuffers.delete(groupId);
          onFlush(buf.items, buf);
        }, 500),
      };
      _mgBuffers.set(groupId, buf);
    }
  },
};

interface ZaloAlbumBuffer {
  timer:      ReturnType<typeof setTimeout>;
  urls:       string[];
  senderName: string;
  topicId:    number;
  tgBase:     { message_thread_id: number; reply_parameters?: { message_id: number; allow_sending_without_reply: boolean } };
  zaloMsgIds: string[];
  zaloQuote:  ZaloQuoteData | undefined;
}

const _zaloAlbumBuffers = new Map<string, ZaloAlbumBuffer>();

export const zaloAlbumStore = {
  add(
    key: string,
    url: string,
    msgId: string,
    meta: Omit<ZaloAlbumBuffer, 'timer' | 'urls' | 'zaloMsgIds'>,
    onFlush: (buf: Omit<ZaloAlbumBuffer, 'timer'>) => void,
  ): void {
    const existing = _zaloAlbumBuffers.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.urls.push(url);
      existing.zaloMsgIds.push(msgId);
      existing.timer = setTimeout(() => {
        _zaloAlbumBuffers.delete(key);
        onFlush({ urls: existing.urls, zaloMsgIds: existing.zaloMsgIds, ...meta });
      }, 200);
    } else {
      const buf: ZaloAlbumBuffer = {
        ...meta,
        urls: [url],
        zaloMsgIds: [msgId],
        timer: setTimeout(() => {
          _zaloAlbumBuffers.delete(key);
          onFlush({ urls: buf.urls, zaloMsgIds: buf.zaloMsgIds, ...meta });
        }, 200),
      };
      _zaloAlbumBuffers.set(key, buf);
    }
  },
};
