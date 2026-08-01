import { existsSync } from 'node:fs';

import type {
  DeliveryMediaRecord,
  MediaSpool,
} from '../infrastructure/media/media-spool.js';
import { config } from '../config.js';
import {
  cleanTemp,
  downloadToTemp,
  downloadToTempFromCandidates,
  materializeTempFile,
} from '../utils/media.js';
import { currentDurableZaloDeliveryId } from './durable-zalo.js';
import { currentDurableTelegramDeliveryId } from './durable-telegram.js';

const DEFAULT_MEDIA_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

let runtimeMediaSpool: MediaSpool | undefined;

export function configureRuntimeMediaSpool(mediaSpool: MediaSpool): void {
  runtimeMediaSpool = mediaSpool;
}

export function disableRuntimeMediaSpool(): void {
  runtimeMediaSpool = undefined;
}

export function currentDurableZaloMedia(
  ordinal = 0,
): DeliveryMediaRecord | undefined {
  const deliveryId = currentDurableZaloDeliveryId();
  return deliveryId && runtimeMediaSpool
    ? runtimeMediaSpool.getForDelivery(deliveryId, ordinal)
    : undefined;
}

export async function downloadZaloMediaDurably(
  urlOrCandidates: string | readonly string[],
  filename: string,
  ordinal = 0,
): Promise<string> {
  const deliveryId = currentDurableZaloDeliveryId();
  const candidates = typeof urlOrCandidates === 'string'
    ? [urlOrCandidates]
    : [...urlOrCandidates];
  if (!deliveryId || !runtimeMediaSpool) {
    return downloadToTempFromCandidates(candidates, filename);
  }

  const attached = runtimeMediaSpool.getForDelivery(deliveryId, ordinal);
  if (
    attached?.media.status === 'READY'
    && existsSync(attached.media.absolutePath)
    && runtimeMediaSpool.isReadyAndIntact(attached.media.id)
  ) {
    return config.telegram.localServer
      ? materializeTempFile(attached.media.absolutePath, filename)
      : attached.media.absolutePath;
  }
  if (attached) runtimeMediaSpool.detachFromDelivery(deliveryId, ordinal);

  const temporaryPath = await downloadToTempFromCandidates(
    candidates,
    filename,
    3,
    config.media.maxObjectBytes,
  );
  try {
    const staged = runtimeMediaSpool.stageLocalFile(temporaryPath, {
      expiresAt: Date.now() + DEFAULT_MEDIA_RETENTION_MS,
    });
    runtimeMediaSpool.attachToDelivery(deliveryId, staged.media.id, ordinal, filename);
    return config.telegram.localServer
      ? await materializeTempFile(staged.media.absolutePath, filename)
      : staged.media.absolutePath;
  } finally {
    await cleanTemp(temporaryPath);
  }
}

export async function downloadTelegramMediaDurably(
  resolveUrl: () => Promise<string>,
  filename: string,
  ordinal = 0,
): Promise<string> {
  const deliveryId = currentDurableTelegramDeliveryId();
  if (!deliveryId || !runtimeMediaSpool) {
    return downloadToTemp(
      await resolveUrl(),
      filename,
      3,
      config.telegram.downloadMaxBytes,
    );
  }

  const attached = runtimeMediaSpool.getForDelivery(deliveryId, ordinal);
  if (
    attached?.filename === filename
    && attached.media.status === 'READY'
    && existsSync(attached.media.absolutePath)
    && runtimeMediaSpool.isReadyAndIntact(attached.media.id)
  ) {
    return materializeTempFile(attached.media.absolutePath, filename);
  }
  if (attached) runtimeMediaSpool.detachFromDelivery(deliveryId, ordinal);

  const temporaryPath = await downloadToTemp(
    await resolveUrl(),
    filename,
    3,
    config.telegram.downloadMaxBytes,
  );
  try {
    const staged = runtimeMediaSpool.stageLocalFile(temporaryPath, {
      expiresAt: Date.now() + DEFAULT_MEDIA_RETENTION_MS,
    });
    runtimeMediaSpool.attachToDelivery(
      deliveryId,
      staged.media.id,
      ordinal,
      filename,
    );
    return materializeTempFile(staged.media.absolutePath, filename);
  } finally {
    await cleanTemp(temporaryPath);
  }
}
