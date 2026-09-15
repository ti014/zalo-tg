import type { ZaloAPI } from './types.js';

export const ZALO_CONNECT_TIMEOUT_MS = 30_000;

/** Resolve only after the provider WebSocket is open, not merely after start(). */
export function waitForZaloListenerConnection(
  api: ZaloAPI,
  timeoutMs = ZALO_CONNECT_TIMEOUT_MS,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error('Zalo connection timeout must be a positive safe integer.'));
  }
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      api.listener.off?.('connected', onConnected);
      api.listener.off?.('disconnected', onDisconnected);
    };
    const onConnected = () => {
      cleanup();
      resolve();
    };
    const onDisconnected = (code: unknown, reason: unknown) => {
      cleanup();
      reject(Object.assign(
        new Error(`Zalo disconnected before becoming ready (code=${String(code)}, reason=${String(reason)}).`),
        { code: 'ZALO_CONNECT_DISCONNECTED' },
      ));
    };
    api.listener.once('connected', onConnected);
    api.listener.once('disconnected', onDisconnected);
    timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(
        new Error(`Zalo listener did not connect within ${Math.round(timeoutMs / 1_000)} seconds.`),
        { code: 'ZALO_CONNECT_TIMEOUT' },
      ));
    }, timeoutMs);
    timer.unref?.();
  });
}
