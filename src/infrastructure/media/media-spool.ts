import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

import type { BridgeDatabase } from '../database/database.js';

export const DEFAULT_MAX_MEDIA_OBJECT_BYTES = 200 * 1024 * 1024;
export const DEFAULT_MAX_MEDIA_SPOOL_BYTES = 5 * 1024 * 1024 * 1024;
export const DEFAULT_STALE_DOWNLOAD_MS = 5 * 60_000;

export type MediaObjectStatus = 'DOWNLOADING' | 'READY' | 'FAILED' | 'DELETED';

export interface MediaObjectRecord {
  id: string;
  sha256: string | null;
  relativePath: string;
  absolutePath: string;
  mimeType: string | null;
  byteSize: number | null;
  status: MediaObjectStatus;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface StageMediaOptions {
  expiresAt: number;
  mimeType?: string;
  now?: number;
}

export interface StageMediaResult {
  media: MediaObjectRecord;
  deduplicated: boolean;
}

export interface MediaSpoolOptions {
  maxObjectBytes?: number;
  maxTotalBytes?: number;
  staleDownloadMs?: number;
  createId?: () => string;
}

export interface RecoveryResult {
  recovered: number;
  failed: number;
  orphanTempsRemoved: number;
}

export interface CleanupResult {
  deleted: number;
  missing: number;
  failed: number;
}

export interface DeliveryMediaRecord {
  deliveryId: string;
  ordinal: number;
  filename: string;
  media: MediaObjectRecord;
}

interface RawMediaRow {
  id: string;
  sha256: string | null;
  relative_path: string;
  mime_type: string | null;
  byte_size: number | null;
  status: MediaObjectStatus;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

interface PreparedMedia {
  sha256: string;
  byteSize: number;
}

interface Reservation {
  media: MediaObjectRecord;
  deduplicated: boolean;
}

export class MediaSizeLimitError extends Error {
  readonly code = 'MEDIA_TOO_LARGE';

  constructor(actualBytes: number, maxBytes: number) {
    super(`Media object is ${actualBytes} bytes; the configured limit is ${maxBytes} bytes.`);
    this.name = 'MediaSizeLimitError';
  }
}

export class MediaSpoolCapacityError extends Error {
  readonly code = 'MEDIA_SPOOL_FULL';

  constructor(requiredBytes: number, availableBytes: number) {
    super(
      `Media spool needs ${requiredBytes} bytes but only ${Math.max(0, availableBytes)} bytes are available.`,
    );
    this.name = 'MediaSpoolCapacityError';
  }
}

function requireTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function normalizeMimeType(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) throw new Error('mimeType must not be blank.');
  return normalized;
}

function hashBuffer(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function writeAll(descriptor: number, buffer: Buffer, length: number): void {
  let offset = 0;
  while (offset < length) {
    const written = writeSync(descriptor, buffer, offset, length - offset);
    if (written === 0) throw new Error('Filesystem made no progress while writing media.');
    offset += written;
  }
}

/**
 * Durable, bounded storage for media that must survive a delivery retry.
 *
 * SQLite is the source of truth for lifecycle state. Files are written to a
 * sibling temporary path, fsynced, atomically renamed, and only then marked
 * READY. Call `recoverStaleDownloads` during startup before workers run.
 */
export class MediaSpool {
  readonly mediaRoot: string;

  private readonly objectRoot: string;
  private readonly maxObjectBytes: number;
  private readonly maxTotalBytes: number;
  private readonly staleDownloadMs: number;
  private readonly createId: () => string;

  constructor(
    private readonly db: BridgeDatabase,
    private readonly dataDir: string,
    options: MediaSpoolOptions = {},
  ) {
    this.maxObjectBytes = requirePositiveSafeInteger(
      options.maxObjectBytes ?? DEFAULT_MAX_MEDIA_OBJECT_BYTES,
      'maxObjectBytes',
    );
    this.maxTotalBytes = requirePositiveSafeInteger(
      options.maxTotalBytes ?? DEFAULT_MAX_MEDIA_SPOOL_BYTES,
      'maxTotalBytes',
    );
    this.staleDownloadMs = requirePositiveSafeInteger(
      options.staleDownloadMs ?? DEFAULT_STALE_DOWNLOAD_MS,
      'staleDownloadMs',
    );
    if (this.maxTotalBytes < this.maxObjectBytes) {
      throw new Error('maxTotalBytes must be at least maxObjectBytes.');
    }
    this.createId = options.createId ?? randomUUID;
    this.mediaRoot = path.resolve(dataDir, 'media');
    this.objectRoot = path.join(this.mediaRoot, 'objects');
    mkdirSync(this.objectRoot, { recursive: true });
  }

  stageBuffer(buffer: Uint8Array, options: StageMediaOptions): StageMediaResult {
    const byteSize = buffer.byteLength;
    this.assertObjectSize(byteSize);
    const prepared = { sha256: hashBuffer(buffer), byteSize };
    const reservation = this.reserve(prepared, options);
    if (reservation.deduplicated) return reservation;

    const tempPath = this.tempSibling(reservation.media.absolutePath);
    try {
      this.writeBufferTemp(tempPath, buffer);
      return this.commitTemp(reservation.media, tempPath, prepared, options.now ?? Date.now());
    } catch (error) {
      this.removeIfPresent(tempPath);
      if (!existsSync(reservation.media.absolutePath)) {
        this.markFailed(reservation.media.id, options.now ?? Date.now());
      }
      throw error;
    }
  }

  stageLocalFile(sourcePath: string, options: StageMediaOptions): StageMediaResult {
    const source = path.resolve(sourcePath);
    const initial = lstatSync(source);
    if (!initial.isFile()) throw new Error(`Media source is not a regular file: ${source}`);

    const prepared = this.hashLocalFile(source);
    const reservation = this.reserve(prepared, options);
    if (reservation.deduplicated) return reservation;

    const tempPath = this.tempSibling(reservation.media.absolutePath);
    try {
      const copied = this.copyLocalFileToTemp(source, tempPath);
      if (copied.byteSize !== prepared.byteSize || copied.sha256 !== prepared.sha256) {
        throw new Error(`Media source changed while it was being staged: ${source}`);
      }
      return this.commitTemp(reservation.media, tempPath, prepared, options.now ?? Date.now());
    } catch (error) {
      this.removeIfPresent(tempPath);
      if (!existsSync(reservation.media.absolutePath)) {
        this.markFailed(reservation.media.id, options.now ?? Date.now());
      }
      throw error;
    }
  }

  getById(mediaId: string): MediaObjectRecord | undefined {
    const row = this.db.prepare(`
      SELECT id, sha256, relative_path, mime_type, byte_size, status,
             expires_at, created_at, updated_at
      FROM media_objects
      WHERE id = ?
    `).get(mediaId) as RawMediaRow | undefined;
    return row ? this.toRecord(row) : undefined;
  }

  isReadyAndIntact(mediaId: string): boolean {
    if (!mediaId.trim()) return false;
    const row = this.db.prepare(`
      SELECT id, sha256, relative_path, mime_type, byte_size, status,
             expires_at, created_at, updated_at
      FROM media_objects
      WHERE id = ?
    `).get(mediaId) as RawMediaRow | undefined;
    return row?.status === 'READY' && this.isCompleteFile(row);
  }

  attachToDelivery(
    deliveryId: string,
    mediaId: string,
    ordinal: number,
    filename: string,
  ): void {
    if (!deliveryId.trim()) throw new Error('deliveryId must not be empty.');
    if (!mediaId.trim()) throw new Error('mediaId must not be empty.');
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
      throw new Error('ordinal must be a non-negative safe integer.');
    }
    const normalizedFilename = filename.trim();
    if (!normalizedFilename) throw new Error('filename must not be empty.');

    const attach = this.db.transaction(() => {
      const media = this.db.prepare(`
        SELECT status FROM media_objects WHERE id = ?
      `).get(mediaId) as { status: MediaObjectStatus } | undefined;
      if (!media) throw new Error(`Media object ${mediaId} does not exist.`);
      if (media.status !== 'READY') {
        throw new Error(`Media object ${mediaId} is ${media.status}, not READY.`);
      }
      this.db.prepare(`
        INSERT INTO delivery_media(delivery_id, media_id, ordinal, filename)
        VALUES (?, ?, ?, ?)
      `).run(deliveryId, mediaId, ordinal, normalizedFilename);
    });
    attach.immediate();
  }

  detachFromDelivery(deliveryId: string, ordinal: number): boolean {
    if (!deliveryId.trim()) throw new Error('deliveryId must not be empty.');
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
      throw new Error('ordinal must be a non-negative safe integer.');
    }
    return this.db.prepare(`
      DELETE FROM delivery_media WHERE delivery_id = ? AND ordinal = ?
    `).run(deliveryId, ordinal).changes === 1;
  }

  getForDelivery(deliveryId: string, ordinal: number): DeliveryMediaRecord | undefined {
    if (!deliveryId.trim()) throw new Error('deliveryId must not be empty.');
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
      throw new Error('ordinal must be a non-negative safe integer.');
    }
    const row = this.db.prepare(`
      SELECT
        link.delivery_id, link.ordinal, link.filename,
        media.id, media.sha256, media.relative_path, media.mime_type,
        media.byte_size, media.status, media.expires_at, media.created_at, media.updated_at
      FROM delivery_media link
      JOIN media_objects media ON media.id = link.media_id
      WHERE link.delivery_id = ? AND link.ordinal = ?
    `).get(deliveryId, ordinal) as (RawMediaRow & {
      delivery_id: string;
      ordinal: number;
      filename: string;
    }) | undefined;
    if (!row) return undefined;
    return {
      deliveryId: row.delivery_id,
      ordinal: row.ordinal,
      filename: row.filename,
      media: this.toRecord(row),
    };
  }

  detachAllFromDelivery(deliveryId: string): number {
    if (!deliveryId.trim()) throw new Error('deliveryId must not be empty.');
    return this.db.prepare('DELETE FROM delivery_media WHERE delivery_id = ?')
      .run(deliveryId).changes;
  }

  detachTerminalDeliveries(): number {
    return this.db.prepare(`
      DELETE FROM delivery_media
      WHERE delivery_id IN (
        SELECT id FROM deliveries WHERE status IN ('SENT', 'SKIPPED', 'DLQ')
      )
    `).run().changes;
  }

  recoverStaleDownloads(
    now: number = Date.now(),
    staleAfterMs: number = this.staleDownloadMs,
  ): RecoveryResult {
    requireTimestamp(now, 'now');
    requirePositiveSafeInteger(staleAfterMs, 'staleAfterMs');
    const cutoff = now - staleAfterMs;
    const rows = this.db.prepare(`
      SELECT id, sha256, relative_path, mime_type, byte_size, status,
             expires_at, created_at, updated_at
      FROM media_objects
      WHERE status = 'DOWNLOADING' AND updated_at <= ?
      ORDER BY created_at, id
    `).all(cutoff) as RawMediaRow[];

    let recovered = 0;
    let failed = 0;
    for (const row of rows) {
      const valid = this.isCompleteFile(row);
      const nextStatus: MediaObjectStatus = valid ? 'READY' : 'FAILED';
      const update = this.db.prepare(`
        UPDATE media_objects
        SET status = ?, updated_at = ?
        WHERE id = ? AND status = 'DOWNLOADING' AND updated_at <= ?
      `).run(nextStatus, now, row.id, cutoff);
      if (update.changes !== 1) continue;
      if (valid) recovered += 1;
      else failed += 1;
      this.removeTempSiblings(row.relative_path);
    }

    return {
      recovered,
      failed,
      orphanTempsRemoved: this.removeOrphanTemps(cutoff),
    };
  }

  cleanupExpired(now: number = Date.now()): CleanupResult {
    requireTimestamp(now, 'now');
    const rows = this.db.prepare(`
      SELECT id, sha256, relative_path, mime_type, byte_size, status,
             expires_at, created_at, updated_at
      FROM media_objects media
      WHERE (
          (media.status IN ('READY', 'FAILED') AND media.expires_at <= ?)
          OR media.status = 'DELETED'
        )
        AND NOT EXISTS (
          SELECT 1 FROM delivery_media link WHERE link.media_id = media.id
        )
      ORDER BY media.created_at, media.id
    `).all(now) as RawMediaRow[];

    let deleted = 0;
    let missing = 0;
    let failed = 0;
    for (const row of rows) {
      const claimed = this.claimForDeletion(row.id, now);
      if (!claimed) continue;
      try {
        const absolutePath = this.resolveStoredPath(row.relative_path);
        const existed = existsSync(absolutePath);
        if (existed) {
          unlinkSync(absolutePath);
        }
        this.removeTempSiblings(row.relative_path);
        if (!this.finalizeDeletion(row.id)) {
          throw new Error(`Media object ${row.id} could not be finalized after deletion.`);
        }
        if (existed) deleted += 1;
        else missing += 1;
      } catch {
        // The DELETED tombstone is intentionally retained so the next cleanup
        // pass retries an interrupted or temporarily blocked filesystem delete.
        failed += 1;
      }
    }
    return { deleted, missing, failed };
  }

  private reserve(prepared: PreparedMedia, options: StageMediaOptions): Reservation {
    const now = requireTimestamp(options.now ?? Date.now(), 'now');
    const expiresAt = requireTimestamp(options.expiresAt, 'expiresAt');
    if (expiresAt <= now) throw new Error('expiresAt must be later than now.');
    const mimeType = normalizeMimeType(options.mimeType);

    const reserve = this.db.transaction((): Reservation => {
      const existing = this.db.prepare(`
        SELECT id, sha256, relative_path, mime_type, byte_size, status,
               expires_at, created_at, updated_at
        FROM media_objects
        WHERE sha256 = ?
      `).get(prepared.sha256) as RawMediaRow | undefined;

      if (existing?.status === 'READY' && this.isCompleteFile(existing)) {
        this.db.prepare(`
          UPDATE media_objects
          SET expires_at = MAX(expires_at, ?),
              mime_type = COALESCE(mime_type, ?),
              updated_at = ?
          WHERE id = ? AND status = 'READY'
        `).run(expiresAt, mimeType, now, existing.id);
        return { media: this.requireById(existing.id), deduplicated: true };
      }

      const excludedId = existing?.id ?? '';
      const usage = this.db.prepare(`
        SELECT COALESCE(SUM(byte_size), 0) AS bytes
        FROM media_objects
        WHERE id != ?
      `).get(excludedId) as { bytes: number };
      if (usage.bytes + prepared.byteSize > this.maxTotalBytes) {
        throw new MediaSpoolCapacityError(
          prepared.byteSize,
          this.maxTotalBytes - usage.bytes,
        );
      }

      if (existing) {
        let relativePath = existing.relative_path;
        try {
          this.resolveStoredPath(relativePath);
        } catch {
          relativePath = this.relativePathForId(existing.id);
        }
        this.db.prepare(`
          UPDATE media_objects
          SET relative_path = ?, mime_type = ?, byte_size = ?,
              status = 'DOWNLOADING', expires_at = MAX(expires_at, ?), updated_at = ?
          WHERE id = ?
        `).run(relativePath, mimeType ?? existing.mime_type, prepared.byteSize, expiresAt, now, existing.id);
        return { media: this.requireById(existing.id), deduplicated: false };
      }

      const id = this.createId().trim();
      if (!id) throw new Error('createId returned an empty media ID.');
      const relativePath = this.relativePathForId(id);
      this.db.prepare(`
        INSERT INTO media_objects(
          id, sha256, relative_path, mime_type, byte_size, status,
          expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'DOWNLOADING', ?, ?, ?)
      `).run(
        id,
        prepared.sha256,
        relativePath,
        mimeType,
        prepared.byteSize,
        expiresAt,
        now,
        now,
      );
      return { media: this.requireById(id), deduplicated: false };
    });

    return reserve.immediate();
  }

  private commitTemp(
    media: MediaObjectRecord,
    tempPath: string,
    prepared: PreparedMedia,
    nowValue: number,
  ): StageMediaResult {
    const now = requireTimestamp(nowValue, 'now');
    renameSync(tempPath, media.absolutePath);
    this.syncDirectoryBestEffort(path.dirname(media.absolutePath));
    const update = this.db.prepare(`
      UPDATE media_objects
      SET status = 'READY', updated_at = ?
      WHERE id = ? AND status = 'DOWNLOADING' AND sha256 = ? AND byte_size = ?
    `).run(now, media.id, prepared.sha256, prepared.byteSize);
    if (update.changes !== 1) {
      throw new Error(`Media object ${media.id} changed while its file was being committed.`);
    }
    return { media: this.requireById(media.id), deduplicated: false };
  }

  private hashLocalFile(sourcePath: string): PreparedMedia {
    const descriptor = openSync(sourcePath, 'r');
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let byteSize = 0;
    try {
      if (!fstatSync(descriptor).isFile()) {
        throw new Error(`Media source is not a regular file: ${sourcePath}`);
      }
      while (true) {
        const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        byteSize += bytesRead;
        this.assertObjectSize(byteSize);
        hash.update(chunk.subarray(0, bytesRead));
      }
      return { sha256: hash.digest('hex'), byteSize };
    } finally {
      closeSync(descriptor);
    }
  }

  private copyLocalFileToTemp(sourcePath: string, tempPath: string): PreparedMedia {
    const source = openSync(sourcePath, 'r');
    let destination: number | undefined;
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let byteSize = 0;
    try {
      if (!fstatSync(source).isFile()) {
        throw new Error(`Media source is not a regular file: ${sourcePath}`);
      }
      destination = openSync(tempPath, 'wx', 0o600);
      while (true) {
        const bytesRead = readSync(source, chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        byteSize += bytesRead;
        this.assertObjectSize(byteSize);
        hash.update(chunk.subarray(0, bytesRead));
        writeAll(destination, chunk, bytesRead);
      }
      fsyncSync(destination);
      closeSync(destination);
      destination = undefined;
      return { sha256: hash.digest('hex'), byteSize };
    } finally {
      closeSync(source);
      if (destination !== undefined) closeSync(destination);
    }
  }

  private writeBufferTemp(tempPath: string, buffer: Uint8Array): void {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(tempPath, 'wx', 0o600);
      writeFileSync(descriptor, buffer);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private assertObjectSize(byteSize: number): void {
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
      throw new Error('Media byte size must be a non-negative safe integer.');
    }
    if (byteSize > this.maxObjectBytes) {
      throw new MediaSizeLimitError(byteSize, this.maxObjectBytes);
    }
  }

  private isCompleteFile(row: RawMediaRow): boolean {
    if (!row.sha256 || row.byte_size === null) return false;
    try {
      const absolutePath = this.resolveStoredPath(row.relative_path);
      const stats = statSync(absolutePath);
      if (!stats.isFile() || stats.size !== row.byte_size) return false;
      const actual = this.hashLocalFile(absolutePath);
      return actual.byteSize === row.byte_size && actual.sha256 === row.sha256;
    } catch {
      return false;
    }
  }

  private claimForDeletion(mediaId: string, now: number): boolean {
    const claim = this.db.transaction(() => this.db.prepare(`
      UPDATE media_objects
      SET status = 'DELETED', sha256 = NULL, updated_at = ?
      WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM delivery_media link WHERE link.media_id = media_objects.id
        )
    `).run(now, mediaId).changes === 1);
    return claim.immediate();
  }

  private finalizeDeletion(mediaId: string): boolean {
    const remove = this.db.transaction(() => this.db.prepare(`
      DELETE FROM media_objects
      WHERE id = ? AND status = 'DELETED'
        AND NOT EXISTS (
          SELECT 1 FROM delivery_media link WHERE link.media_id = media_objects.id
        )
    `).run(mediaId).changes === 1);
    return remove.immediate();
  }

  private markFailed(mediaId: string, nowValue: number): void {
    const now = Number.isSafeInteger(nowValue) && nowValue >= 0 ? nowValue : Date.now();
    try {
      this.db.prepare(`
        UPDATE media_objects SET status = 'FAILED', updated_at = ?
        WHERE id = ? AND status = 'DOWNLOADING'
      `).run(now, mediaId);
    } catch {
      // Preserve the original filesystem/staging error. Startup recovery will
      // revisit any row that remains DOWNLOADING.
    }
  }

  private requireById(mediaId: string): MediaObjectRecord {
    const media = this.getById(mediaId);
    if (!media) throw new Error(`Media object ${mediaId} does not exist.`);
    return media;
  }

  private toRecord(row: RawMediaRow): MediaObjectRecord {
    return {
      id: row.id,
      sha256: row.sha256,
      relativePath: row.relative_path,
      absolutePath: this.resolveStoredPath(row.relative_path),
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      status: row.status,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private relativePathForId(id: string): string {
    const safeName = createHash('sha256').update(id).digest('hex');
    return `media/objects/${safeName}.blob`;
  }

  private resolveStoredPath(relativePath: string): string {
    if (path.isAbsolute(relativePath)) {
      throw new Error('Media relative_path must not be absolute.');
    }
    const resolved = path.resolve(this.dataDir, relativePath);
    const relativeToRoot = path.relative(this.mediaRoot, resolved);
    if (
      !relativeToRoot
      || relativeToRoot.startsWith('..')
      || path.isAbsolute(relativeToRoot)
    ) {
      throw new Error(`Media path escapes the spool root: ${relativePath}`);
    }
    return resolved;
  }

  private tempSibling(targetPath: string): string {
    return path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
  }

  private removeTempSiblings(relativePath: string): void {
    let absolutePath: string;
    try {
      absolutePath = this.resolveStoredPath(relativePath);
    } catch {
      return;
    }
    const prefix = `.${path.basename(absolutePath)}.`;
    let entries;
    try {
      entries = readdirSync(path.dirname(absolutePath), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.tmp')) {
        this.removeIfPresent(path.join(path.dirname(absolutePath), entry.name));
      }
    }
  }

  private removeOrphanTemps(cutoff: number): number {
    let removed = 0;
    for (const entry of readdirSync(this.objectRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue;
      const absolutePath = path.join(this.objectRoot, entry.name);
      try {
        if (statSync(absolutePath).mtimeMs > cutoff) continue;
        unlinkSync(absolutePath);
        removed += 1;
      } catch {
        // A concurrently committed or already removed temp is harmless.
      }
    }
    return removed;
  }

  private removeIfPresent(targetPath: string): void {
    try {
      unlinkSync(targetPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
  }

  private syncDirectoryBestEffort(directory: string): void {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(directory, 'r');
      fsyncSync(descriptor);
    } catch {
      // Directory fsync is unsupported on Windows; the file itself was fsynced.
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}
