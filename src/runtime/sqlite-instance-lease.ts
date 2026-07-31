import { randomUUID } from 'node:crypto';

import type { BridgeDatabase } from '../infrastructure/database/database.js';

export interface SqliteInstanceLease {
  readonly ownerId: string;
  release(): void;
}

export interface SqliteInstanceLeaseOptions {
  leaseName?: string;
  ttlMs?: number;
  renewIntervalMs?: number;
  onLost?: (error: Error) => void;
}

interface ExistingLease {
  owner_id: string;
  acquired_at: number;
  expires_at: number;
}

const DEFAULT_LEASE_NAME = 'bridge-main';
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_RENEW_INTERVAL_MS = 15_000;

function assertLeaseTiming(ttlMs: number, renewIntervalMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 10_000) {
    throw new Error('Instance lease TTL must be a safe integer of at least 10000 ms.');
  }
  if (!Number.isSafeInteger(renewIntervalMs) || renewIntervalMs < 1_000 || renewIntervalMs * 2 >= ttlMs) {
    throw new Error('Instance lease renewal interval must be at least 1000 ms and less than half the TTL.');
  }
}

export function acquireSqliteInstanceLease(
  db: BridgeDatabase,
  options: SqliteInstanceLeaseOptions = {},
): SqliteInstanceLease {
  const leaseName = options.leaseName ?? DEFAULT_LEASE_NAME;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const renewIntervalMs = options.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
  assertLeaseTiming(ttlMs, renewIntervalMs);

  const ownerId = randomUUID();
  const acquiredAt = Date.now();
  let expiresAt = acquiredAt + ttlMs;
  let released = false;
  let lost = false;

  const acquire = db.transaction(() => {
    db.prepare('DELETE FROM instance_leases WHERE lease_name = ? AND expires_at <= ?')
      .run(leaseName, acquiredAt);
    const result = db.prepare(`
      INSERT INTO instance_leases(lease_name, owner_id, acquired_at, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(lease_name) DO NOTHING
    `).run(leaseName, ownerId, acquiredAt, expiresAt);
    if (result.changes === 1) return;

    const existing = db.prepare(`
      SELECT owner_id, acquired_at, expires_at
      FROM instance_leases
      WHERE lease_name = ?
    `).get(leaseName) as ExistingLease | undefined;
    const since = existing ? new Date(existing.acquired_at).toISOString() : 'unknown';
    throw new Error(`Another bridge instance owns lease ${leaseName} since ${since}.`);
  });
  acquire();

  const loseLease = (error: Error): void => {
    if (released || lost) return;
    lost = true;
    clearInterval(timer);
    options.onLost?.(error);
  };

  const renew = (): void => {
    if (released || lost || !db.open) return;
    const now = Date.now();
    const nextExpiry = now + ttlMs;
    try {
      const result = db.prepare(`
        UPDATE instance_leases
        SET expires_at = ?
        WHERE lease_name = ? AND owner_id = ?
      `).run(nextExpiry, leaseName, ownerId);
      if (result.changes !== 1) {
        loseLease(new Error(`Instance lease ${leaseName} ownership was lost.`));
        return;
      }
      expiresAt = nextExpiry;
    } catch (error) {
      if (Date.now() >= expiresAt) {
        loseLease(new Error(`Instance lease ${leaseName} expired after renewal failures.`, { cause: error }));
      } else {
        console.warn(`[Lease] Could not renew ${leaseName}; will retry:`, error);
      }
    }
  };

  const timer = setInterval(renew, renewIntervalMs);
  timer.unref();

  return {
    ownerId,
    release(): void {
      if (released) return;
      released = true;
      clearInterval(timer);
      if (!db.open) return;
      try {
        db.prepare('DELETE FROM instance_leases WHERE lease_name = ? AND owner_id = ?')
          .run(leaseName, ownerId);
      } catch (error) {
        console.warn(`[Lease] Could not release ${leaseName}:`, error);
      }
    },
  };
}
