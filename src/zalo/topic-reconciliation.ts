import { ThreadType } from 'zca-js';

import { config } from '../config.js';
import { store } from '../store/index.js';
import { topicName } from '../utils/format.js';
import type { ZaloAPI, ZaloGroupInfoResponse } from './types.js';
import { runZaloRequest } from './rate-limit.js';
import { tg } from './helpers.js';

const GROUP_INFO_BATCH_SIZE = 50;

type RequestRunner = <T>(label: string, request: () => Promise<T>) => Promise<T>;

export interface TopicReconciliationOptions {
  pruneMissing?: boolean;
  runRequest?: RequestRunner;
  editTopic?: (topicId: number, name: string) => Promise<void>;
}

export interface TopicReconciliationResult {
  activeGroups: number;
  mappedGroups: number;
  renamed: number;
  provenanceUpdated: number;
  missingMetadata: number;
  failed: number;
  pruned: number;
}

const defaultRequestRunner: RequestRunner = (label, request) => runZaloRequest(
  { label, priority: 'low', maxRetries: 0 },
  request,
);

async function defaultEditTopic(topicId: number, name: string): Promise<void> {
  await tg.editForumTopic(
    config.telegram.groupId,
    topicId,
    { name: topicName(name, ThreadType.Group) },
  );
}

function requireGroupIds(value: unknown): string[] {
  const gridVerMap = (value as { gridVerMap?: unknown } | null)?.gridVerMap;
  if (!gridVerMap || typeof gridVerMap !== 'object' || Array.isArray(gridVerMap)) {
    throw new Error('Zalo getAllGroups returned no valid gridVerMap; preserving topic mappings.');
  }
  return Object.keys(gridVerMap);
}

function isTopicNotModifiedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    response?: { error_code?: unknown; description?: unknown };
  };
  const code = candidate.code ?? candidate.response?.error_code;
  const descriptions = [candidate.message, candidate.response?.description]
    .filter((value): value is string => typeof value === 'string');
  return code === 400 && descriptions.some(description => (
    description.includes('TOPIC_NOT_MODIFIED')
    || description.toLowerCase().includes('topic is not modified')
  ));
}

export async function reconcileGroupTopics(
  api: ZaloAPI,
  options: TopicReconciliationOptions = {},
): Promise<TopicReconciliationResult> {
  const runRequest = options.runRequest ?? defaultRequestRunner;
  const editTopic = options.editTopic ?? defaultEditTopic;
  const groupIds = requireGroupIds(await runRequest(
    'getAllGroups(reconcileGroupTopics)',
    () => api.getAllGroups(),
  ));
  const activeGroupIds = new Set(groupIds);
  const mappedGroups = store.all().filter(entry => (
    entry.type === ThreadType.Group && activeGroupIds.has(entry.zaloId)
  ));
  const infoById = new Map<string, { name: string }>();
  let failed = 0;

  for (let index = 0; index < mappedGroups.length; index += GROUP_INFO_BATCH_SIZE) {
    const batch = mappedGroups
      .slice(index, index + GROUP_INFO_BATCH_SIZE)
      .map(entry => entry.zaloId);
    try {
      const response = await runRequest(
        `getGroupInfo(reconcileGroupTopics:${index / GROUP_INFO_BATCH_SIZE + 1})`,
        () => api.getGroupInfo(batch),
      ) as ZaloGroupInfoResponse | undefined;
      for (const [groupId, info] of Object.entries(response?.gridInfoMap ?? {})) {
        const name = info?.name?.trim();
        if (name) infoById.set(groupId, { name });
      }
    } catch (error) {
      failed += batch.length;
      console.warn(`[Topic reconciliation] Could not load ${batch.length} group name(s):`, error);
    }
  }

  let renamed = 0;
  let provenanceUpdated = 0;
  let missingMetadata = 0;
  for (const entry of mappedGroups) {
    const authoritative = infoById.get(entry.zaloId);
    if (!authoritative) {
      missingMetadata += 1;
      continue;
    }
    if (entry.name === authoritative.name) {
      if (entry.nameSource !== 'group_info') {
        store.set({ ...entry, nameSource: 'group_info' });
        provenanceUpdated += 1;
      }
      continue;
    }
    try {
      await editTopic(entry.topicId, authoritative.name);
    } catch (error) {
      // Telegram can already have the authoritative title while SQLite still
      // contains a stale name. TOPIC_NOT_MODIFIED confirms the provider state,
      // so persist the repaired shadow instead of retrying forever.
      if (isTopicNotModifiedError(error)) {
        store.set({
          ...entry,
          name: authoritative.name,
          nameSource: 'group_info',
        });
        renamed += 1;
        continue;
      }
      failed += 1;
      console.warn(
        `[Topic reconciliation] Failed to rename topic ${entry.topicId} for ${entry.zaloId}:`,
        error,
      );
      continue;
    }
    store.set({
      ...entry,
      name: authoritative.name,
      nameSource: 'group_info',
    });
    renamed += 1;
  }

  let pruned = 0;
  if (options.pruneMissing) {
    for (const entry of store.all()) {
      if (entry.type !== ThreadType.Group || activeGroupIds.has(entry.zaloId)) continue;
      store.remove(entry.topicId);
      pruned += 1;
    }
  }

  return {
    activeGroups: activeGroupIds.size,
    mappedGroups: mappedGroups.length,
    renamed,
    provenanceUpdated,
    missingMetadata,
    failed,
    pruned,
  };
}
