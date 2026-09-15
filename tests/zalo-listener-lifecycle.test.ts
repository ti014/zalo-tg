import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { waitForZaloListenerConnection } from '../src/zalo/listener-lifecycle.js';

test('Zalo readiness waits for the listener connected event', async () => {
  const listener = new EventEmitter();
  const connected = waitForZaloListenerConnection({ listener } as never, 1_000);
  listener.emit('connected');
  await connected;
});

test('Zalo readiness rejects a disconnect before connection', async () => {
  const listener = new EventEmitter();
  const connected = waitForZaloListenerConnection({ listener } as never, 1_000);
  listener.emit('disconnected', 1006, 'network');
  await assert.rejects(
    connected,
    error => (error as { code?: string }).code === 'ZALO_CONNECT_DISCONNECTED',
  );
});

test('Zalo readiness rejects a connection timeout', async () => {
  const listener = new EventEmitter();
  await assert.rejects(
    waitForZaloListenerConnection({ listener } as never, 10),
    error => (error as { code?: string }).code === 'ZALO_CONNECT_TIMEOUT',
  );
});
