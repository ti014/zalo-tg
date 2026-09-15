import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-topic-reconciliation-'));
process.env.TG_TOKEN ??= 'test-token';
process.env.TG_GROUP_ID ??= '-1001234567890';
process.env.TG_OWNER_IDS ??= '1';
process.env.DATA_DIR = directory;
process.env.DATABASE_PATH = path.join(directory, 'bridge.db');

const { store } = await import('../src/store/index.js');
const {
  groupTopicPlaceholder,
  resolveGroupTopicPresentation,
} = await import('../src/zalo/topic.js');
const { reconcileGroupTopics } = await import('../src/zalo/topic-reconciliation.js');

test.after(() => {
  rmSync(directory, { recursive: true, force: true });
});

test('missing group metadata uses a deterministic placeholder, never a sender name', async () => {
  store.replaceAll([]);
  const presentation = await resolveGroupTopicPresentation({
    getGroupInfo: async () => { throw new Error('group metadata unavailable'); },
  }, 'group-404');

  assert.deepEqual(presentation, {
    name: groupTopicPlaceholder('group-404'),
    nameSource: 'placeholder',
  });
});

test('existing authoritative group name survives a transient metadata failure', async () => {
  store.replaceAll([{
    topicId: 25,
    zaloId: 'group-existing',
    type: 1,
    name: 'Tên nhóm đã xác thực',
    nameSource: 'group_event',
  }]);
  const presentation = await resolveGroupTopicPresentation({
    getGroupInfo: async () => { throw new Error('temporary outage'); },
  }, 'group-existing');

  assert.equal(presentation.name, 'Tên nhóm đã xác thực');
  assert.equal(presentation.nameSource, 'group_event');
});

test('reconciliation repairs wrong names, upgrades provenance, and scopes pruning', async () => {
  store.replaceAll([
    {
      topicId: 31,
      zaloId: 'group-wrong',
      type: 1,
      name: 'Tên người gửi',
      nameSource: 'legacy',
    },
    {
      topicId: 32,
      zaloId: 'group-correct',
      type: 1,
      name: 'Nhóm đúng',
      nameSource: 'legacy',
    },
    {
      topicId: 33,
      zaloId: 'group-left',
      type: 1,
      name: 'Nhóm đã rời',
      nameSource: 'group_info',
    },
    {
      topicId: 34,
      zaloId: 'friend-a',
      type: 0,
      name: 'Bạn A',
      nameSource: 'contact',
    },
  ]);
  const edits: Array<{ topicId: number; name: string }> = [];
  const api = {
    getAllGroups: async () => ({
      gridVerMap: { 'group-wrong': '1', 'group-correct': '1' },
    }),
    getGroupInfo: async () => ({
      gridInfoMap: {
        'group-wrong': { name: 'Nhóm chính thức' },
        'group-correct': { name: 'Nhóm đúng' },
      },
    }),
  };

  const result = await reconcileGroupTopics(api, {
    pruneMissing: true,
    runRequest: async (_label, request) => request(),
    editTopic: async (topicId, name) => { edits.push({ topicId, name }); },
  });

  assert.deepEqual(edits, [{ topicId: 31, name: 'Nhóm chính thức' }]);
  assert.equal(result.renamed, 1);
  assert.equal(result.provenanceUpdated, 1);
  assert.equal(result.pruned, 1);
  assert.equal(store.getEntryByTopic(31)?.name, 'Nhóm chính thức');
  assert.equal(store.getEntryByTopic(31)?.nameSource, 'group_info');
  assert.equal(store.getEntryByTopic(32)?.nameSource, 'group_info');
  assert.equal(store.getEntryByTopic(33), undefined);
  assert.equal(store.getEntryByTopic(34)?.name, 'Bạn A');
});

test('invalid group-list response preserves every mapping', async () => {
  store.replaceAll([{
    topicId: 41,
    zaloId: 'group-safe',
    type: 1,
    name: 'Nhóm an toàn',
    nameSource: 'group_info',
  }]);

  await assert.rejects(
    reconcileGroupTopics(
      { getAllGroups: async () => ({}) },
      {
        pruneMissing: true,
        runRequest: async (_label, request) => request(),
        editTopic: async () => undefined,
      },
    ),
    /preserving topic mappings/,
  );
  assert.equal(store.getEntryByTopic(41)?.name, 'Nhóm an toàn');
});

test('TOPIC_NOT_MODIFIED confirms Telegram state and repairs the SQLite shadow', async () => {
  store.replaceAll([{
    topicId: 51,
    zaloId: 'group-shadow-stale',
    type: 1,
    name: 'Tên SQLite cũ',
    nameSource: 'legacy',
  }]);

  const result = await reconcileGroupTopics(
    {
      getAllGroups: async () => ({ gridVerMap: { 'group-shadow-stale': '1' } }),
      getGroupInfo: async () => ({
        gridInfoMap: { 'group-shadow-stale': { name: 'Tên Telegram và Zalo đúng' } },
      }),
    },
    {
      runRequest: async (_label, request) => request(),
      editTopic: async () => {
        throw Object.assign(new Error('400: Bad Request: TOPIC_NOT_MODIFIED'), { code: 400 });
      },
    },
  );

  assert.equal(result.renamed, 1);
  assert.equal(result.failed, 0);
  assert.equal(store.getEntryByTopic(51)?.name, 'Tên Telegram và Zalo đúng');
  assert.equal(store.getEntryByTopic(51)?.nameSource, 'group_info');
});
