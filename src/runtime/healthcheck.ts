#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { RuntimeHealthSnapshot } from './health.js';

const maxAgeMs = Number(process.env.HEALTH_MAX_AGE_MS ?? 45_000);
const healthDir = path.resolve(process.env.HEALTH_DIR ?? process.env.DATA_DIR ?? '/app/data');
const healthPath = path.join(healthDir, 'health.json');
const readiness = process.argv.includes('--readiness');

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

try {
  const snapshot = JSON.parse(readFileSync(healthPath, 'utf8')) as RuntimeHealthSnapshot;
  const updatedAt = Date.parse(snapshot.updatedAt);
  if (snapshot.version !== 1 || !Number.isSafeInteger(snapshot.pid) || !Number.isFinite(updatedAt)) {
    fail('Invalid health snapshot');
  }
  if (Date.now() - updatedAt > maxAgeMs) fail('Health heartbeat is stale');
  if (snapshot.shuttingDown) fail('Bridge is shutting down');
  try { process.kill(snapshot.pid, 0); } catch { fail('Bridge process is not alive'); }

  if (readiness) {
    const { storage, telegram, zalo } = snapshot.components;
    if (storage !== 'ready' || telegram !== 'ready' || zalo !== 'ready') {
      fail(`Bridge is not ready: storage=${storage}, telegram=${telegram}, zalo=${zalo}`);
    }
  }
  console.log(readiness ? 'ready' : 'alive');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
