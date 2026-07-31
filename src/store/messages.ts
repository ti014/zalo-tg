import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { config } from '../config.js';
import { MessageLinkCache } from '../domain/message-links.js';
import { normalizeMessageId } from '../domain/message-id.js';
import {
  PendingSendRegistry,
  type PendingEchoInput,
  type PendingSendInput,
} from '../domain/pending-sends.js';
import { writeJsonAtomicSync } from '../infrastructure/files/atomic-file.js';
import {
  lookupShadowIncomingQuote,
  lookupShadowIncomingTelegramId,
  lookupShadowSentInfo,
  lookupShadowSentTelegramIdByAlias,
  shadowIncomingMessage,
  shadowMessagesReplace,
  shadowSentMessage,
} from '../infrastructure/database/shadow-state.js';

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
type LoadStatus = 'loaded' | 'missing' | 'invalid';
let _loadStatus: LoadStatus = 'missing';
let _loadFailure: Error | undefined;

const _messageLinks = new MessageLinkCache<ZaloQuoteData>(MSG_CACHE_MAX);

const _sentMap = new Map<number, SentMsgInfo>();
const _sentByZaloId = new Map<string, number>();
const _sentOrder: number[] = [];
const _pendingSends = new PendingSendRegistry();

let _msgPersistTimer: ReturnType<typeof setTimeout> | null = null;

function _loadMsgMap(): MsgMapData {
  _loadFailure = undefined;
  if (!existsSync(_msgMapFile)) {
    _loadStatus = 'missing';
    return { pairs: [], quotes: [], sent: [] };
  }
  try {
    const loaded = _parseMsgMap(readFileSync(_msgMapFile, 'utf8'));
    _loadStatus = 'loaded';
    return loaded;
  } catch (error) {
    _loadStatus = 'invalid';
    _loadFailure = new Error(`Cannot load ${_msgMapFile}; SQLite recovery is required.`, {
      cause: error,
    });
    console.error('[msgStore] Legacy message map is invalid; deferring to SQLite recovery:', _loadFailure);
    return { pairs: [], quotes: [], sent: [] };
  }
}

function _parseMsgMap(content: string): MsgMapData {
  const raw = JSON.parse(content) as Partial<MsgMapData> | null;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.pairs) || !Array.isArray(raw.quotes)) {
    throw new Error('msg-map.json must contain pairs and quotes arrays');
  }
  if (raw.sent !== undefined && !Array.isArray(raw.sent)) {
    throw new Error('msg-map.json sent must be an array');
  }
  return raw as MsgMapData;
}

function _indexSent(tgMsgId: number, info: SentMsgInfo): void {
  const msgId = normalizeMessageId(info.msgId);
  const cliMsgId = normalizeMessageId(info.cliMsgId);
  if (msgId) _sentByZaloId.set(msgId, tgMsgId);
  if (cliMsgId) _sentByZaloId.set(cliMsgId, tgMsgId);
}

function _unindexSent(tgMsgId: number, info: SentMsgInfo): void {
  for (const alias of [normalizeMessageId(info.msgId), normalizeMessageId(info.cliMsgId)]) {
    if (alias && _sentByZaloId.get(alias) === tgMsgId) _sentByZaloId.delete(alias);
  }
}

function _pruneSent(): void {
  while (_sentOrder.length > SENT_MAX) {
    const old = _sentOrder.shift();
    if (old === undefined) break;
    const oldInfo = _sentMap.get(old);
    if (oldInfo) _unindexSent(old, oldInfo);
    _sentMap.delete(old);
  }
}

function _normalizeMsgMap(saved: MsgMapData): { data: MsgMapData; normalized: boolean } {
  const links = new MessageLinkCache<ZaloQuoteData>(MSG_CACHE_MAX);
  const linkResult = links.load({ pairs: saved.pairs, quotes: saved.quotes });
  let normalized = linkResult.normalized;

  const sentByTelegram = new Map<number, SentMsgInfo>();
  const sentOrder: number[] = [];
  for (const entry of saved.sent ?? []) {
    if (!Array.isArray(entry) || entry.length !== 2 || !Number.isSafeInteger(entry[0])) {
      normalized = true;
      continue;
    }
    const [telegramId, rawInfo] = entry;
    const info = rawInfo as Partial<SentMsgInfo> | undefined;
    const msgId = normalizeMessageId(info?.msgId) ?? normalizeMessageId(info?.cliMsgId);
    const cliMsgId = normalizeMessageId(info?.cliMsgId);
    if (!info || !msgId || typeof info.zaloId !== 'string' || (info.threadType !== 0 && info.threadType !== 1)) {
      normalized = true;
      continue;
    }
    if (sentByTelegram.has(telegramId)) {
      normalized = true;
      const previousIndex = sentOrder.indexOf(telegramId);
      if (previousIndex >= 0) sentOrder.splice(previousIndex, 1);
    }
    sentByTelegram.set(telegramId, {
      msgId,
      ...(cliMsgId ? { cliMsgId } : {}),
      zaloId: info.zaloId,
      threadType: info.threadType,
    });
    sentOrder.push(telegramId);
  }
  while (sentOrder.length > SENT_MAX) {
    const telegramId = sentOrder.shift();
    if (telegramId !== undefined) sentByTelegram.delete(telegramId);
    normalized = true;
  }

  const snapshot = links.snapshot();
  return {
    data: {
      pairs: snapshot.pairs,
      quotes: snapshot.quotes,
      sent: sentOrder.flatMap(telegramId => {
        const info = sentByTelegram.get(telegramId);
        return info ? [[telegramId, info] as [number, SentMsgInfo]] : [];
      }),
    },
    normalized,
  };
}

function _applyMsgMap(saved: MsgMapData): void {
  _messageLinks.load({ pairs: saved.pairs, quotes: saved.quotes });
  _sentMap.clear();
  _sentByZaloId.clear();
  _sentOrder.splice(0);
  for (const [tgMsgId, info] of saved.sent ?? []) {
    _sentMap.set(tgMsgId, info);
    _sentOrder.push(tgMsgId);
    _indexSent(tgMsgId, info);
  }
}

function _currentMsgMap(): MsgMapData {
  const links = _messageLinks.snapshot();
  return {
    pairs: links.pairs,
    quotes: links.quotes,
    sent: _sentOrder.flatMap(tgMsgId => {
      const info = _sentMap.get(tgMsgId);
      return info ? [[tgMsgId, info] as [number, SentMsgInfo]] : [];
    }),
  };
}

function _persistMsgMap(): void {
  try {
    writeJsonAtomicSync(_msgMapFile, _currentMsgMap());
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
  const { data, normalized } = _normalizeMsgMap(_loadMsgMap());
  _applyMsgMap(data);
  if (normalized) {
    console.warn('[msgStore] Invalid or duplicate aliases were removed from msg-map.json');
    _scheduleMsgPersist();
  }
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
    if (_messageLinks.save(tgMsgId, zaloMsgIds, quote)) {
      _scheduleMsgPersist();
      shadowIncomingMessage(tgMsgId, zaloMsgIds, quote);
    }
  },

  getTgMsgId(zaloMsgId: string): number | undefined {
    return _messageLinks.getTelegramId(zaloMsgId)
      ?? lookupShadowIncomingTelegramId(zaloMsgId);
  },

  getQuote(tgMsgId: number): ZaloQuoteData | undefined {
    return _messageLinks.getQuote(tgMsgId)
      ?? lookupShadowIncomingQuote(tgMsgId);
  },

  replaceFromJson(
    content: string,
    options: { synchronizeShadow?: boolean } = {},
  ): { aliases: number; sent: number } {
    const { data } = _normalizeMsgMap(_parseMsgMap(content));
    writeJsonAtomicSync(_msgMapFile, data);
    _loadStatus = 'loaded';
    _loadFailure = undefined;
    if (_msgPersistTimer) {
      clearTimeout(_msgPersistTimer);
      _msgPersistTimer = null;
    }
    _applyMsgMap(data);
    const aliasesByTelegram = new Map<number, string[]>();
    for (const [alias, telegramMessageId] of data.pairs) {
      const aliases = aliasesByTelegram.get(telegramMessageId) ?? [];
      aliases.push(alias);
      aliasesByTelegram.set(telegramMessageId, aliases);
    }
    if (options.synchronizeShadow !== false) {
      shadowMessagesReplace(
        data.quotes.map(([telegramMessageId, quote]) => ({
          telegramMessageId,
          aliases: aliasesByTelegram.get(telegramMessageId) ?? [],
          quote,
        })),
        (data.sent ?? []).map(([telegramMessageId, info]) => ({ telegramMessageId, info })),
      );
    }
    return { aliases: data.pairs.length, sent: data.sent?.length ?? 0 };
  },

  loadState(): { status: LoadStatus; error?: Error } {
    return { status: _loadStatus, ...(_loadFailure ? { error: _loadFailure } : {}) };
  },
};

export const sentMsgStore = {
  save(tgMsgId: number, info: SentMsgInfo): void {
    const oldInfo = _sentMap.get(tgMsgId);
    if (oldInfo) _unindexSent(tgMsgId, oldInfo);
    if (!oldInfo) _sentOrder.push(tgMsgId);

    _sentMap.set(tgMsgId, info);
    _indexSent(tgMsgId, info);
    _pendingSends.bindAliasesByTelegramMessage(tgMsgId, [info.msgId, info.cliMsgId]);
    _pruneSent();
    _scheduleMsgPersist();
    shadowSentMessage(tgMsgId, info);
  },

  update(tgMsgId: number, patch: Partial<SentMsgInfo>): SentMsgInfo | undefined {
    const existing = _sentMap.get(tgMsgId);
    if (!existing) return undefined;

    _unindexSent(tgMsgId, existing);
    const next = { ...existing, ...patch };
    _sentMap.set(tgMsgId, next);
    _indexSent(tgMsgId, next);
    _pendingSends.bindAliasesByTelegramMessage(tgMsgId, [next.msgId, next.cliMsgId]);
    _scheduleMsgPersist();
    shadowSentMessage(tgMsgId, next);
    return next;
  },

  updateByZaloMsgId(zaloMsgId: string, patch: Partial<SentMsgInfo>): SentMsgInfo | undefined {
    const tgMsgId = _sentByZaloId.get(zaloMsgId);
    return tgMsgId === undefined ? undefined : this.update(tgMsgId, patch);
  },

  get(tgMsgId: number): SentMsgInfo | undefined {
    return _sentMap.get(tgMsgId)
      ?? lookupShadowSentInfo(tgMsgId);
  },

  getByZaloMsgId(zaloMsgId: string): number | undefined {
    return _sentByZaloId.get(zaloMsgId)
      ?? lookupShadowSentTelegramIdByAlias(zaloMsgId);
  },

};

export const pendingSendStore = {
  begin(input: PendingSendInput): string {
    return _pendingSends.begin(input);
  },

  complete(token: string): void {
    _pendingSends.complete(token);
  },

  cancel(token: string): void {
    _pendingSends.cancel(token);
  },

  consume(input: PendingEchoInput): number | undefined {
    return _pendingSends.consume(input);
  },
};
