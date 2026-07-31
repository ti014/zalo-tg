import path from 'node:path';

import { writeJsonAtomicSync } from '../infrastructure/files/atomic-file.js';

export type ComponentHealth = 'degraded' | 'ready' | 'starting' | 'stopped';

export interface RuntimeHealthSnapshot {
  version: 1;
  pid: number;
  startedAt: string;
  updatedAt: string;
  shuttingDown: boolean;
  components: {
    storage: ComponentHealth;
    telegram: ComponentHealth;
    zalo: ComponentHealth;
  };
}

class RuntimeHealthReporter {
  readonly #startedAt = new Date().toISOString();
  #filePath: string | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #shuttingDown = false;
  #components: RuntimeHealthSnapshot['components'] = {
    storage: 'starting',
    telegram: 'starting',
    zalo: 'starting',
  };

  start(dataDir: string, intervalMs = 5_000): void {
    if (this.#timer) return;
    this.#filePath = path.join(dataDir, 'health.json');
    this.#write();
    this.#timer = setInterval(() => this.#write(), intervalMs);
    this.#timer.unref();
  }

  set(component: keyof RuntimeHealthSnapshot['components'], health: ComponentHealth): void {
    this.#components = { ...this.#components, [component]: health };
    this.#write();
  }

  beginShutdown(): void {
    this.#shuttingDown = true;
    this.#components = { ...this.#components, telegram: 'stopped', zalo: 'stopped' };
    this.#write();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#write();
  }

  snapshot(): RuntimeHealthSnapshot {
    return {
      version: 1,
      pid: process.pid,
      startedAt: this.#startedAt,
      updatedAt: new Date().toISOString(),
      shuttingDown: this.#shuttingDown,
      components: { ...this.#components },
    };
  }

  #write(): void {
    if (!this.#filePath) return;
    try {
      writeJsonAtomicSync(this.#filePath, this.snapshot());
    } catch (error) {
      console.error('[Health] Failed to write heartbeat:', error);
    }
  }
}

export const runtimeHealth = new RuntimeHealthReporter();
