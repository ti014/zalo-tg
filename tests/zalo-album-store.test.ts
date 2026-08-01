import assert from 'node:assert/strict';
import test from 'node:test';

import { zaloAlbumStore } from '../src/store/media.js';

test('Zalo album buffer keeps URL fallbacks, all aliases, and the first caption', async () => {
  const flushed = new Promise<{
    items: Array<{ urls: string[]; msgIds: string[] }>;
    caption?: string;
  }>(resolve => {
    const meta = {
      senderName: 'Người gửi',
      topicId: 7,
      tgBase: { message_thread_id: 7 },
      zaloQuote: undefined,
    };
    zaloAlbumStore.add(
      'conversation:sender',
      ['https://cdn/hd', 'https://cdn/normal'],
      ['global-1', 'client-1'],
      undefined,
      meta,
      resolve,
    );
    zaloAlbumStore.add(
      'conversation:sender',
      ['https://cdn/normal', 'https://cdn/thumb'],
      ['global-1', 'echo-1'],
      'Chú thích',
      meta,
      resolve,
    );
  });

  const result = await flushed;
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0]?.urls, [
    'https://cdn/hd',
    'https://cdn/normal',
    'https://cdn/thumb',
  ]);
  assert.deepEqual(result.items[0]?.msgIds, ['global-1', 'client-1', 'echo-1']);
  assert.equal(result.caption, 'Chú thích');
});
