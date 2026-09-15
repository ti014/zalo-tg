import test from 'node:test';
import assert from 'node:assert/strict';
import { ThreadType } from 'zca-js';
import {
  requestGroupHistory,
  requestRecentHistoryReplay,
  setHistoryReplayHandler,
} from '../src/zalo/history.js';

test('history coordinator requests old pages and returns them in chronological order', async () => {
  const listeners = new Map<string, (...args: any[]) => void>();
  const api = {
    listener: {
      on: (event: string, handler: (...args: any[]) => void) => listeners.set(event, handler),
      requestOldMessages: (type: unknown, before?: string) => {
        assert.equal(type, ThreadType.Group);
        const handler = listeners.get('old_messages');
        if (!before) {
          handler?.([
            { threadId: 'group-1', data: { msgId: 'new', ts: '20', msgType: 'webchat' } },
            { threadId: 'group-1', data: { msgId: 'old', ts: '10', msgType: 'webchat' } },
          ], ThreadType.Group);
        }
      },
    },
  };
  const result = await requestGroupHistory(api as never, 'group-1', 2);
  assert.deepEqual(result.map(message => message.data.msgId), ['old', 'new']);
  setHistoryReplayHandler(null);
});

test('reconnect recovery requests recent direct and group messages', () => {
  const requested: ThreadType[] = [];
  const api = {
    listener: {
      on: () => undefined,
      requestOldMessages: (type: ThreadType) => { requested.push(type); },
    },
  };
  requestRecentHistoryReplay(api as never);
  assert.deepEqual(requested, [ThreadType.User, ThreadType.Group]);
});
