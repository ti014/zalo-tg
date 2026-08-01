import { createReadStream } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { isAmbiguousProviderFailure } from '../domain/provider-errors.js';
import { getSharedTempRoot, prepareSharedTempFile } from '../utils/sharedTemp.js';

export type TelegramLocalMedia = string | { source: ReturnType<typeof createReadStream> };

export type TelegramDocumentMedia =
  | string
  | { source: ReturnType<typeof createReadStream>; filename: string };

export function isPathWithinSharedRoot(
  filePath: string,
  sharedRoot = getSharedTempRoot(),
): boolean {
  const relative = path.relative(path.resolve(sharedRoot), path.resolve(filePath));
  return relative.length > 0 && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function isSharedLocalPath(filePath: string): boolean {
  return Boolean(config.telegram.localServer) && isPathWithinSharedRoot(filePath);
}

/** Use file:// uploads for a shared local Bot API, multipart otherwise. */
export function telegramMediaInput(filePath: string, forceMultipart = false): TelegramLocalMedia {
  if (isSharedLocalPath(filePath) && !forceMultipart) {
    prepareSharedTempFile(filePath);
    return pathToFileURL(filePath).toString();
  }
  return { source: createReadStream(filePath) };
}

export function telegramDocumentInput(
  filePath: string,
  filename: string,
  forceMultipart = false,
): TelegramDocumentMedia {
  if (isSharedLocalPath(filePath) && !forceMultipart) {
    prepareSharedTempFile(filePath);
    return pathToFileURL(filePath).toString();
  }
  return { source: createReadStream(filePath), filename };
}

export function telegramErrorCode(error: unknown): number | undefined {
  const response = (error as { response?: { error_code?: unknown } })?.response;
  return typeof response?.error_code === 'number' ? response.error_code : undefined;
}

export function telegramErrorDescription(error: unknown): string {
  const response = (error as { response?: { description?: unknown } })?.response;
  if (typeof response?.description === 'string') return response.description;
  return error instanceof Error ? error.message : String(error);
}

/** A definitive local file-URI rejection is safe to retry as multipart. */
export function isTelegramFileUriRejection(error: unknown): boolean {
  if (telegramErrorCode(error) !== 400) return false;
  return /(file:\/\/|http url|url host|wrong file|failed to get.*url|file.*not found|can't open)/i
    .test(telegramErrorDescription(error));
}

export async function withTelegramMediaFallback<T>(
  operation: (forceMultipart: boolean) => Promise<T>,
  label: string,
): Promise<T> {
  try {
    return await operation(false);
  } catch (error) {
    if (!config.telegram.localServer || !isTelegramFileUriRejection(error)) throw error;
    console.warn(
      `[Telegram] ${label}: local file URI rejected (${telegramErrorDescription(error)}); `
      + 'retrying multipart upload.',
    );
    return operation(true);
  }
}

export interface TelegramAnimationOperations<T> {
  animation(media: TelegramLocalMedia): Promise<T>;
  video(media: TelegramLocalMedia): Promise<T>;
  document(media: TelegramDocumentMedia): Promise<T>;
}

/** Preserve delivery by falling back animation → video → document on definitive rejections. */
export async function sendTelegramAnimationWithFallback<T>(
  filePath: string,
  fileName: string,
  operations: TelegramAnimationOperations<T>,
): Promise<T> {
  try {
    return await withTelegramMediaFallback(
      forceMultipart => operations.animation(telegramMediaInput(filePath, forceMultipart)),
      'Animation upload',
    );
  } catch (error) {
    if (isAmbiguousProviderFailure(error)) throw error;
    console.warn('[Telegram] Animation rejected; trying video:', error);
  }

  try {
    return await withTelegramMediaFallback(
      forceMultipart => operations.video(telegramMediaInput(filePath, forceMultipart)),
      'Animation video fallback',
    );
  } catch (error) {
    if (isAmbiguousProviderFailure(error)) throw error;
    console.warn('[Telegram] Animation video rejected; trying document:', error);
  }

  return withTelegramMediaFallback(
    forceMultipart => operations.document(
      telegramDocumentInput(filePath, fileName, forceMultipart),
    ),
    'Animation document fallback',
  );
}
