import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { config } from '../config.js';

export interface TopicEntry {
  topicId: number;
  zaloId:  string;
  type:    0 | 1;
  name:    string;
}

interface StoreData {
  topics:    Record<string, TopicEntry>;
  zaloIndex: Record<string, number>;
}

const filePath = path.resolve(config.dataDir, 'topics.json');

function normalize(data: StoreData): StoreData {
  const topics = data.topics ?? {};
  const zaloIndex: Record<string, number> = {};

  for (const entry of Object.values(topics)) {
    zaloIndex[zaloKey(entry.zaloId, entry.type)] = entry.topicId;
  }

  return { topics, zaloIndex };
}

function load(): StoreData {
  if (!existsSync(filePath)) return { topics: {}, zaloIndex: {} };
  try {
    return normalize(JSON.parse(readFileSync(filePath, 'utf8')) as StoreData);
  } catch {
    return { topics: {}, zaloIndex: {} };
  }
}

function persist(data: StoreData): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
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
    _data.topics[String(entry.topicId)] = entry;
    _data.zaloIndex[zaloKey(entry.zaloId, entry.type)] = entry.topicId;
    persist(_data);
  },

  all(): TopicEntry[] {
    return Object.values(_data.topics);
  },

  replaceAll(entries: TopicEntry[]): number {
    const topics: Record<string, TopicEntry> = {};
    for (const entry of entries) {
      if (!Number.isFinite(entry.topicId)) continue;
      if (entry.type !== 0 && entry.type !== 1) continue;
      if (!entry.zaloId?.trim() || !entry.name?.trim()) continue;
      topics[String(entry.topicId)] = {
        topicId: entry.topicId,
        zaloId: String(entry.zaloId),
        type: entry.type,
        name: String(entry.name),
      };
    }
    _data = normalize({ topics, zaloIndex: {} });
    persist(_data);
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
    return entry;
  },

  reload(): void {
    _data = load();
  },
};
