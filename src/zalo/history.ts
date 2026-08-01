import { ThreadType } from 'zca-js';
import type { ZaloAPI, ZaloMessage } from './types.js';

interface PendingHistoryRequest {
  api: ZaloAPI;
  groupId: string;
  count: number;
  pages: number;
  messages: ZaloMessage[];
  seen: Set<string>;
  timer: ReturnType<typeof setTimeout>;
  resolve: (messages: ZaloMessage[]) => void;
  reject: (error: Error) => void;
}

let pending: PendingHistoryRequest | null = null;
let replayHandler: ((message: ZaloMessage) => Promise<void>) | null = null;
const registeredApis = new WeakSet<object>();

function finish(request: PendingHistoryRequest, error?: Error): void {
  if (pending !== request) return;
  clearTimeout(request.timer);
  pending = null;
  if (error) {
    request.reject(error);
    return;
  }
  const result = [...request.messages]
    .sort((a, b) => Number(b.data.ts ?? 0) - Number(a.data.ts ?? 0))
    .slice(0, request.count)
    .sort((a, b) => Number(a.data.ts ?? 0) - Number(b.data.ts ?? 0));
  request.resolve(result);
}

function handleOldMessages(api: ZaloAPI, messages: unknown, oldType: unknown): void {
  if (!Array.isArray(messages)) return;
  const request = pending;
  if (request && request.api === api && oldType === ThreadType.Group) {
    request.pages += 1;
    for (const value of messages) {
      const message = value as ZaloMessage;
      if (String(message?.threadId ?? '') !== request.groupId) continue;
      const id = String(message?.data?.msgId ?? `${message?.data?.ts}:${request.messages.length}`);
      if (request.seen.has(id)) continue;
      request.seen.add(id);
      request.messages.push(message);
    }
    if (request.messages.length >= request.count || request.pages >= 5) {
      finish(request);
      return;
    }
    const oldest = [...messages]
      .sort((a, b) => Number((a as ZaloMessage)?.data?.ts ?? 0) - Number((b as ZaloMessage)?.data?.ts ?? 0))[0] as ZaloMessage | undefined;
    const lastId = oldest?.data?.msgId ? String(oldest.data.msgId) : undefined;
    if (lastId) api.listener.requestOldMessages(ThreadType.Group, lastId);
    else finish(request);
    return;
  }

  const sorted = messages
    .filter((value): value is ZaloMessage => Boolean(value && typeof value === 'object'))
    .sort((a, b) => Number(a.data.ts ?? 0) - Number(b.data.ts ?? 0));
  if (!replayHandler) return;
  for (const message of sorted) void replayHandler(message);
}

export function registerHistoryListener(api: ZaloAPI): void {
  if (registeredApis.has(api as object)) return;
  registeredApis.add(api as object);
  api.listener.on('old_messages', (messages: unknown[], oldType: unknown) => {
    handleOldMessages(api, messages, oldType);
  });
}

export function setHistoryReplayHandler(handler: ((message: ZaloMessage) => Promise<void>) | null): void {
  replayHandler = handler;
}

export function requestGroupHistory(api: ZaloAPI, groupId: string, count: number): Promise<ZaloMessage[]> {
  if (pending) return Promise.reject(new Error('Đang có một yêu cầu /history khác chạy.'));
  registerHistoryListener(api);
  return new Promise((resolve, reject) => {
    const request: PendingHistoryRequest = {
      api,
      groupId,
      count,
      pages: 0,
      messages: [],
      seen: new Set(),
      timer: setTimeout(() => {
        if (request.messages.length > 0) finish(request);
        else finish(request, new Error('Zalo không trả dữ liệu lịch sử trong 20 giây.'));
      }, 20_000),
      resolve,
      reject,
    };
    request.timer.unref?.();
    pending = request;
    api.listener.requestOldMessages(ThreadType.Group);
  });
}

export async function replayHistoryMessages(messages: ZaloMessage[], gapMs = 250): Promise<number> {
  if (!replayHandler) return 0;
  let processed = 0;
  for (const message of messages) {
    try {
      await replayHandler(message);
      processed += 1;
    } catch (error) {
      console.warn('[History] Replay failed:', error);
    }
    if (gapMs > 0) await new Promise(resolve => setTimeout(resolve, gapMs));
  }
  return processed;
}
