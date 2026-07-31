import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DurableTelegramRelay,
  markDurableTelegramHandled,
} from '../src/application/durable-telegram.js';
import {
  closeBridgeDatabase,
  openBridgeDatabase,
} from '../src/infrastructure/database/database.js';
import { DeliveryRepository } from '../src/infrastructure/database/delivery-repository.js';
import { MediaSpool } from '../src/infrastructure/media/media-spool.js';
import type { TopicEntry } from '../src/store/topics.js';
import type { ZaloAPI } from '../src/zalo/types.js';
import type { Telegraf } from 'telegraf';

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for delivery.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('Telegram media retry reuses persistent spool without resolving provider URL', async () => {
  process.env.TG_TOKEN ??= 'test-token';
  process.env.TG_GROUP_ID ??= '-100123';
  process.env.TG_OWNER_IDS ??= '123';
  const {
    disableRuntimeMediaSpool,
    configureRuntimeMediaSpool,
    downloadTelegramMediaDurably,
  } = await import('../src/application/durable-media.js');
  const { cleanTemp } = await import('../src/utils/media.js');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'zalo-tg-media-retry-'));
  const db = openBridgeDatabase(path.join(directory, 'bridge.db'));
  const repository = new DeliveryRepository(db);
  const spool = new MediaSpool(db, directory);
  configureRuntimeMediaSpool(spool);
  let relay: DurableTelegramRelay | undefined;
  try {
    const queued = repository.ingestAndEnqueue({
      source: 'telegram',
      sourceEventKey: 'update:media-retry',
      conversationKey: '0:zalo-user',
      eventType: 'photo',
      payload: { update_id: 1, message: { message_id: 1 } },
      destination: 'zalo',
      receivedAt: 100,
    });
    const staged = spool.stageBuffer(Buffer.from('persistent-telegram-media'), {
      expiresAt: Date.now() + 60_000,
    });
    spool.attachToDelivery(
      queued.delivery.id,
      staged.media.id,
      0,
      'photo.jpg',
    );

    let resolverCalled = false;
    relay = new DurableTelegramRelay({
      repository,
      bot: {} as Telegraf,
      telegramChatId: -100123,
      getApi: () => ({}) as ZaloAPI,
      getTopic: () => ({
        topicId: 42,
        zaloId: 'zalo-user',
        type: 0,
        name: 'User',
      } satisfies TopicEntry),
      onFatal: error => assert.fail(error),
      replayUpdate: async () => {
        const localPath = await downloadTelegramMediaDurably(
          async () => {
            resolverCalled = true;
            throw new Error('provider URL should not be requested');
          },
          'photo.jpg',
        );
        try {
          assert.equal(readFileSync(localPath, 'utf8'), 'persistent-telegram-media');
          assert.equal(path.extname(localPath), '.jpg');
          assert.notEqual(localPath, staged.media.absolutePath);
        } finally {
          await cleanTemp(localPath);
        }
        assert.equal(existsSync(staged.media.absolutePath), true);
        assert.equal(readFileSync(staged.media.absolutePath, 'utf8'), 'persistent-telegram-media');
        markDurableTelegramHandled();
      },
      pollIntervalMs: 5,
    });
    relay.start();
    await waitFor(() => repository.getById(queued.delivery.id)?.status === 'SENT');
    assert.equal(resolverCalled, false);
    assert.equal(spool.getForDelivery(queued.delivery.id, 0), undefined);
  } finally {
    await relay?.stop();
    disableRuntimeMediaSpool();
    closeBridgeDatabase(db);
    rmSync(directory, { recursive: true, force: true });
  }
});
