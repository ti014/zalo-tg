import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeBridgeDatabase, openBridgeDatabase } from '../src/infrastructure/database/database.js';
import { acquireSqliteInstanceLease } from '../src/runtime/sqlite-instance-lease.js';

test('SQLite instance lease rejects a concurrent owner and allows takeover after release', () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'zalo-tg-lease-'));
  const databasePath = path.join(dataDir, 'bridge.db');
  const firstDb = openBridgeDatabase(databasePath);
  const secondDb = openBridgeDatabase(databasePath);

  try {
    const firstLease = acquireSqliteInstanceLease(firstDb, {
      leaseName: 'test-bridge',
      ttlMs: 10_000,
      renewIntervalMs: 1_000,
    });

    assert.throws(
      () => acquireSqliteInstanceLease(secondDb, {
        leaseName: 'test-bridge',
        ttlMs: 10_000,
        renewIntervalMs: 1_000,
      }),
      /Another bridge instance owns lease/,
    );

    firstLease.release();
    const secondLease = acquireSqliteInstanceLease(secondDb, {
      leaseName: 'test-bridge',
      ttlMs: 10_000,
      renewIntervalMs: 1_000,
    });
    secondLease.release();
  } finally {
    closeBridgeDatabase(secondDb);
    closeBridgeDatabase(firstDb);
  }
});
