import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { config } from '../config.js';

export interface ZaloQuoteData {
  msgId:    string;
  cliMsgId: string;
  uidFrom:  string;
  ts:       string;
  msgType:  string;
  content:  string | Record<string, unknown>;
  ttl:      number;
  zaloId:   string;
  threadType: 0 | 1;
}

export interface SentMsgInfo {
  msgId:      string | number;
  cliMsgId?:  string | number;
  zaloId:     string;
  threadType: 0 | 1;
}

const MSG_CACHE_MAX = 2000;
const SENT_MAX = 300;

interface MsgMapData {
  pairs:  [string, number][];
  quotes: [number, ZaloQuoteData][];
  sent?:  [number, SentMsgInfo][];
}

const _msgMapFile = path.resolve(config.dataDir, 'msg-map.json');

const _zaloToTg = new Map<string, number>();
const _tgToQuote = new Map<number, ZaloQuoteData>();
const _msgKeyOrder: string[] = [];

interface PendingSendInfo {
  ts: number;
  tgMsgId?: number;
}

const PENDING_SEND_TTL_MS = 5_000;
const _sentMap = new Map<number, SentMsgInfo>();
const _sentByZaloId = new Map<string, number>();
const _sentOrder: number[] = [];
const _pendingSendConvos = new Map<string, PendingSendInfo>();

let _msgPersistTimer: ReturnType<typeof setTimeout> | null = null;

function _loadMsgMap(): MsgMapData {
  if (!existsSync(_msgMapFile)) return { pairs: [], quotes: [], sent: [] };
  try {
    return JSON.parse(readFileSync(_msgMapFile, 'utf8')) as MsgMapData;
  } catch { return { pairs: [], quotes: [], sent: [] }; }
}

function _indexSent(tgMsgId: number, info: SentMsgInfo): void {
  _sentByZaloId.set(String(info.msgId), tgMsgId);
  if (info.cliMsgId !== undefined) _sentByZaloId.set(String(info.cliMsgId), tgMsgId);
}

function _unindexSent(info: SentMsgInfo): void {
  _sentByZaloId.delete(String(info.msgId));
  if (info.cliMsgId !== undefined) _sentByZaloId.delete(String(info.cliMsgId));
}

function _pruneSent(): void {
  while (_sentOrder.length > SENT_MAX) {
    const old = _sentOrder.shift();
    if (old === undefined) break;
    const oldInfo = _sentMap.get(old);
    if (oldInfo) _unindexSent(oldInfo);
    _sentMap.delete(old);
  }
}

function _persistMsgMap(): void {
  try {
    mkdirSync(path.dirname(_msgMapFile), { recursive: true });
    const data: MsgMapData = {
      pairs:  _msgKeyOrder.map(k => [k, _zaloToTg.get(k)!] as [string, number]),
      quotes: [..._tgToQuote.entries()],
      sent:   _sentOrder.flatMap(tgMsgId => {
        const info = _sentMap.get(tgMsgId);
        return info ? [[tgMsgId, info] as [number, SentMsgInfo]] : [];
      }),
    };
    writeFileSync(_msgMapFile, JSON.stringify(data), 'utf8');
  } catch (e) {
    console.warn('[msgStore] Failed to persist msg-map:', e);
  }
}

function _scheduleMsgPersist(): void {
  if (_msgPersistTimer) return;
  _msgPersistTimer = setTimeout(() => {
    _msgPersistTimer = null;
    _persistMsgMap();
  }, 1000);
}

{
  const saved = _loadMsgMap();
  for (const [zaloId, tgId] of saved.pairs ?? []) {
    _zaloToTg.set(zaloId, tgId);
    _msgKeyOrder.push(zaloId);
  }
  for (const [tgId, quote] of saved.quotes ?? []) {
    _tgToQuote.set(tgId, quote);
  }
  while (_msgKeyOrder.length > MSG_CACHE_MAX) {
    const old = _msgKeyOrder.shift();
    if (!old) break;
    const oldTg = _zaloToTg.get(old);
    _zaloToTg.delete(old);
    if (oldTg !== undefined) _tgToQuote.delete(oldTg);
  }
  for (const [tgMsgId, info] of saved.sent ?? []) {
    _sentMap.set(tgMsgId, info);
    _sentOrder.push(tgMsgId);
    _indexSent(tgMsgId, info);
  }
  _pruneSent();
}

export function flushMsgStore(): void {
  if (_msgPersistTimer) {
    clearTimeout(_msgPersistTimer);
    _msgPersistTimer = null;
  }
  _persistMsgMap();
}

export const msgStore = {
  save(tgMsgId: number, zaloMsgIds: string[], quote: ZaloQuoteData): void {
    while (_msgKeyOrder.length + zaloMsgIds.length > MSG_CACHE_MAX) {
      const old = _msgKeyOrder.shift();
      if (!old) break;
      const oldTg = _zaloToTg.get(old);
      _zaloToTg.delete(old);
      if (oldTg !== undefined) _tgToQuote.delete(oldTg);
    }
    for (const id of zaloMsgIds) {
      _zaloToTg.set(id, tgMsgId);
      _msgKeyOrder.push(id);
    }
    _tgToQuote.set(tgMsgId, quote);
    _scheduleMsgPersist();
  },

  getTgMsgId(zaloMsgId: string): number | undefined {
    return _zaloToTg.get(zaloMsgId);
  },

  getQuote(tgMsgId: number): ZaloQuoteData | undefined {
    return _tgToQuote.get(tgMsgId);
  },
};

export const sentMsgStore = {
  save(tgMsgId: number, info: SentMsgInfo): void {
    const oldInfo = _sentMap.get(tgMsgId);
    if (oldInfo) _unindexSent(oldInfo);
    if (!oldInfo) _sentOrder.push(tgMsgId);

    _sentMap.set(tgMsgId, info);
    _indexSent(tgMsgId, info);
    _pruneSent();
    _scheduleMsgPersist();
  },

  update(tgMsgId: number, patch: Partial<SentMsgInfo>): SentMsgInfo | undefined {
    const existing = _sentMap.get(tgMsgId);
    if (!existing) return undefined;

    _unindexSent(existing);
    const next = { ...existing, ...patch };
    _sentMap.set(tgMsgId, next);
    _indexSent(tgMsgId, next);
    _scheduleMsgPersist();
    return next;
  },

  updateByZaloMsgId(zaloMsgId: string, patch: Partial<SentMsgInfo>): SentMsgInfo | undefined {
    const tgMsgId = _sentByZaloId.get(zaloMsgId);
    return tgMsgId === undefined ? undefined : this.update(tgMsgId, patch);
  },

  get(tgMsgId: number): SentMsgInfo | undefined {
    return _sentMap.get(tgMsgId);
  },

  getByZaloMsgId(zaloMsgId: string): number | undefined {
    return _sentByZaloId.get(zaloMsgId);
  },

  markSending(zaloId: string, tgMsgId?: number): void {
    _pendingSendConvos.set(zaloId, { ts: Date.now(), tgMsgId });
  },

  unmarkSending(zaloId: string): void {
    const pending = _pendingSendConvos.get(zaloId);
    if (pending && Date.now() - pending.ts < PENDING_SEND_TTL_MS) return;
    _pendingSendConvos.delete(zaloId);
  },

  consumePendingTelegramMessage(zaloId: string): number | undefined {
    const pending = _pendingSendConvos.get(zaloId);
    if (!pending || Date.now() - pending.ts >= PENDING_SEND_TTL_MS) {
      _pendingSendConvos.delete(zaloId);
      return undefined;
    }
    _pendingSendConvos.delete(zaloId);
    return pending.tgMsgId;
  },

  isSendingTo(zaloId: string): boolean {
    const pending = _pendingSendConvos.get(zaloId);
    if (!pending) return false;
    if (Date.now() - pending.ts >= PENDING_SEND_TTL_MS) {
      _pendingSendConvos.delete(zaloId);
      return false;
    }
    return true;
  },
};
