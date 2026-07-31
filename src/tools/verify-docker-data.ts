#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

interface MediaRow {
  id: string;
  relative_path: string;
  sha256: string | null;
  byte_size: number | null;
}

function hashFile(filePath: string): { sha256: string; bytes: number } {
  const descriptor = openSync(filePath, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(`Not a regular file: ${filePath}`);
    while (true) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      bytes += read;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
  return { sha256: hash.digest('hex'), bytes };
}

function resolveMediaPath(dataDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) throw new Error('Media path must be relative.');
  const mediaRoot = path.resolve(dataDir, 'media');
  const resolved = path.resolve(dataDir, relativePath);
  const relative = path.relative(mediaRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Media path escapes the spool root: ${relativePath}`);
  }
  return resolved;
}

const dataDir = path.resolve(process.env.DATA_DIR ?? '/app/data');
const databasePath = path.resolve(
  process.env.DATABASE_PATH ?? path.join(dataDir, 'bridge.db'),
);
const db = new Database(databasePath, { readonly: true, fileMustExist: true });

try {
  const quickCheck = db.pragma('quick_check') as Array<{ quick_check: string }>;
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== 'ok') {
    throw new Error(`SQLite quick_check failed: ${JSON.stringify(quickCheck)}`);
  }
  const foreignKeyViolations = db.pragma('foreign_key_check') as unknown[];
  if (foreignKeyViolations.length > 0) {
    throw new Error(`SQLite foreign_key_check found ${foreignKeyViolations.length} violation(s).`);
  }

  const mediaRows = db.prepare(`
    SELECT id, relative_path, sha256, byte_size
    FROM media_objects
    WHERE status = 'READY'
    ORDER BY id
  `).all() as MediaRow[];
  for (const media of mediaRows) {
    if (!media.sha256 || media.byte_size === null) {
      throw new Error(`READY media ${media.id} has incomplete integrity metadata.`);
    }
    const absolutePath = resolveMediaPath(dataDir, media.relative_path);
    const stats = statSync(absolutePath);
    if (!stats.isFile() || stats.size !== media.byte_size) {
      throw new Error(`READY media ${media.id} has an invalid file size.`);
    }
    const actual = hashFile(absolutePath);
    if (actual.bytes !== media.byte_size || actual.sha256 !== media.sha256) {
      throw new Error(`READY media ${media.id} failed SHA-256 verification.`);
    }
  }

  const scalar = (sql: string): number => Number(
    (db.prepare(sql).get() as { count: number }).count,
  );
  const invalidMultipart = scalar(`
    SELECT count(*) AS count
    FROM telegram_multipart_parts p
    JOIN telegram_multipart_manifests m ON m.delivery_id = p.delivery_id
    WHERE p.part_no > m.part_count
       OR p.byte_offset <> (p.part_no - 1) * m.part_size_bytes
       OR p.byte_size <> MIN(
         m.part_size_bytes,
         m.source_byte_size - ((p.part_no - 1) * m.part_size_bytes)
       )
       OR (
         p.status = 'SENT'
         AND NOT EXISTS (
           SELECT 1
           FROM delivery_receipts r
           WHERE r.delivery_id = p.delivery_id
             AND r.receipt_kind = 'part'
             AND r.ordinal = p.part_no - 1
             AND r.provider_message_id = p.provider_message_id
         )
       )
  `);
  const invalidManifestCounts = scalar(`
    SELECT count(*) AS count
    FROM (
      SELECT m.delivery_id
      FROM telegram_multipart_manifests m
      LEFT JOIN telegram_multipart_parts p ON p.delivery_id = m.delivery_id
      GROUP BY m.delivery_id, m.part_count, m.source_byte_size
      HAVING count(p.part_no) <> m.part_count
         OR coalesce(sum(p.byte_size), 0) <> m.source_byte_size
    )
  `);
  const invalidSkipAudits = scalar(`
    SELECT count(*) AS count
    FROM deliveries d
    LEFT JOIN delivery_skip_audits s ON s.delivery_id = d.id
    WHERE (d.status = 'SKIPPED' AND s.delivery_id IS NULL)
       OR (d.status <> 'SKIPPED' AND s.delivery_id IS NOT NULL)
  `);
  if (invalidMultipart > 0 || invalidManifestCounts > 0 || invalidSkipAudits > 0) {
    throw new Error(
      `Durable state invariants failed: multipart=${invalidMultipart}, `
      + `manifestCounts=${invalidManifestCounts}, skipAudits=${invalidSkipAudits}.`,
    );
  }
  const result = {
    quickCheck: 'ok',
    foreignKeyViolations: 0,
    topics: scalar('SELECT count(*) AS count FROM topic_links'),
    messageLinks: scalar('SELECT count(*) AS count FROM message_links'),
    aliases: scalar('SELECT count(*) AS count FROM message_aliases'),
    deliveries: scalar('SELECT count(*) AS count FROM deliveries'),
    problemDeliveries: scalar(`
      SELECT count(*) AS count FROM deliveries
      WHERE status IN ('UNKNOWN', 'PERMANENT_FAILED', 'DLQ')
    `),
    readyMedia: mediaRows.length,
    providerReceipts: scalar('SELECT count(*) AS count FROM delivery_receipts'),
    multipartManifests: scalar('SELECT count(*) AS count FROM telegram_multipart_manifests'),
    invalidMultipart,
    invalidManifestCounts,
    invalidSkipAudits,
  };
  console.log(JSON.stringify(result));
} finally {
  db.close();
}
