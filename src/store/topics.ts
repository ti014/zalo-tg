import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { config } from '../config.js';
import { writeJsonAtomicSync } from '../infrastructure/files/atomic-file.js';
import { shadowTopicRemove, shadowTopicSet, shadowTopicsReplace } from '../infrastructure/database/shadow-state.js';

export const TOPIC_NAME_SOURCES = [
  'legacy',
  'placeholder',
  'contact',
  'group_info',
  'group_list',
  'group_event',
] as const;

export type TopicNameSource = typeof TOPIC_NAME_SOURCES[number];

export interface TopicEntry {
  topicId: number;
  zaloId:  string;
  type:    0 | 1;
  name:    string;
  nameSource?: TopicNameSource;
}

interface StoreData {
  topics:    Record<string, TopicEntry>;
  zaloIndex: Record<string, number>;
}

const filePath = path.resolve(config.dataDir, 'topics.json');
type LoadStatus = 'loaded' | 'missing' | 'invalid';
let loadStatus: LoadStatus = 'missing';
let loadFailure: Error | undefined;

function normalize(data: StoreData): StoreData {
  const topics: Record<string, TopicEntry> = {};
  const zaloIndex: Record<string, number> = {};

  for (const entry of Object.values(data.topics ?? {})) {
    const normalized = normalizeEntry(entry);
    topics[String(normalized.topicId)] = normalized;
    zaloIndex[zaloKey(normalized.zaloId, normalized.type)] = normalized.topicId;
  }

  return { topics, zaloIndex };
}

function normalizeNameSource(value: unknown): TopicNameSource {
  return TOPIC_NAME_SOURCES.includes(value as TopicNameSource)
    ? value as TopicNameSource
    : 'legacy';
}

function normalizeEntry(entry: TopicEntry): TopicEntry {
  return { ...entry, nameSource: normalizeNameSource(entry.nameSource) };
}

function load(): StoreData {
  loadFailure = undefined;
  if (!existsSync(filePath)) {
    loadStatus = 'missing';
    return { topics: {}, zaloIndex: {} };
  }
  try {
    const loaded = normalize(JSON.parse(readFileSync(filePath, 'utf8')) as StoreData);
    loadStatus = 'loaded';
    return loaded;
  } catch (error) {
    loadStatus = 'invalid';
    loadFailure = new Error(`Cannot load ${filePath}; SQLite recovery is required.`, { cause: error });
    console.error('[topicStore] Legacy topic file is invalid; deferring to SQLite recovery:', loadFailure);
    return { topics: {}, zaloIndex: {} };
  }
}

function persist(data: StoreData): void {
  writeJsonAtomicSync(filePath, data, 2);
}

function zaloKey(zaloId: string, type: 0 | 1): string {
  return `${type}:${zaloId}`;
}

let _data: StoreData = load();

export const store = {
  getTopicByZalo(zaloId: string, type: 0 | 1): number | undefined {
    return _data.zaloIndex[zaloKey(zaloId, type)];
  },

  getEntryByTopic(topicId: number): TopicEntry | undefined {
    return _data.topics[String(topicId)];
  },

  set(entry: TopicEntry): void {
    if (!Number.isSafeInteger(entry.topicId) || entry.topicId <= 1) {
      throw new Error(`Invalid Telegram forum topic ID: ${entry.topicId}`);
    }
    const normalized = normalizeEntry(entry);
    const key = zaloKey(normalized.zaloId, normalized.type);
    const previousTopicId = _data.zaloIndex[key];
    if (previousTopicId !== undefined && previousTopicId !== entry.topicId) {
      delete _data.topics[String(previousTopicId)];
    }
    const previousAtTopic = _data.topics[String(normalized.topicId)];
    if (previousAtTopic) {
      delete _data.zaloIndex[zaloKey(previousAtTopic.zaloId, previousAtTopic.type)];
    }
    _data.topics[String(normalized.topicId)] = normalized;
    _data.zaloIndex[key] = normalized.topicId;
    persist(_data);
    shadowTopicSet(normalized);
  },

  all(): TopicEntry[] {
    return Object.values(_data.topics);
  },

  replaceAll(
    entries: TopicEntry[],
    options: { synchronizeShadow?: boolean } = {},
  ): number {
    const topics: Record<string, TopicEntry> = {};
    for (const entry of entries) {
      if (!Number.isSafeInteger(entry.topicId) || entry.topicId <= 1) continue;
      if (entry.type !== 0 && entry.type !== 1) continue;
      if (!entry.zaloId?.trim() || !entry.name?.trim()) continue;
      topics[String(entry.topicId)] = normalizeEntry({
        topicId: entry.topicId,
        zaloId: String(entry.zaloId),
        type: entry.type,
        name: String(entry.name),
        nameSource: entry.nameSource,
      });
    }
    _data = normalize({ topics, zaloIndex: {} });
    persist(_data);
    loadStatus = 'loaded';
    loadFailure = undefined;
    if (options.synchronizeShadow !== false) {
      shadowTopicsReplace(Object.values(_data.topics));
    }
    return Object.keys(_data.topics).length;
  },

  remove(topicId: number): TopicEntry | undefined {
    const topicKey = String(topicId);
    const entry = _data.topics[topicKey];

    delete _data.topics[topicKey];
    for (const [key, indexedTopicId] of Object.entries(_data.zaloIndex)) {
      if (indexedTopicId === topicId) delete _data.zaloIndex[key];
    }

    persist(_data);
    shadowTopicRemove(topicId);
    return entry;
  },

  reload(): void {
    _data = load();
  },

  loadState(): { status: LoadStatus; error?: Error } {
    return { status: loadStatus, ...(loadFailure ? { error: loadFailure } : {}) };
  },

  stats(): { topics: number; groups: number; directMessages: number } {
    const entries = Object.values(_data.topics);
    const groups = entries.filter(entry => entry.type === 1).length;
    return {
      topics: entries.length,
      groups,
      directMessages: entries.length - groups,
    };
  },
};
