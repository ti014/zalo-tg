import type { ZaloMediaContent } from './types.js';
import { escapeHtml, groupCaption, truncate } from '../utils/format.js';
import { splitZaloText } from '../domain/text-chunks.js';

/** Keep short captions unchanged; send long captions as separate messages, never truncate. */
export function telegramPhotoCaption(senderName: string, caption = ''): { caption: string; text: string[] } {
  const prefix = groupCaption(senderName);
  const full = caption ? `${prefix}\n${escapeHtml(caption)}` : prefix;
  return full.length <= 1024
    ? { caption: full, text: [] }
    : { caption: '', text: splitZaloText(`${senderName}\n${caption}`, [], 4000).map(chunk => chunk.text) };
}

export interface ZaloLinkContent {
  href: string;
  title: string;
}

export interface ZaloPhotoContent {
  urls: string[];
  caption?: string;
}

/** Resolve plain and rich-text object payloads emitted under msgType webchat. */
export function resolveZaloTextBody(
  text: string | null,
  rawContent: string | ZaloMediaContent | Record<string, unknown>,
  media: ZaloMediaContent,
): string {
  if (text !== null) return text;
  if (typeof rawContent === 'string' && rawContent.trim()) return rawContent;
  return typeof media.title === 'string' ? media.title : '';
}

function firstNonBlank(values: readonly unknown[]): string | undefined {
  return values
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.trim();
}

export function resolveZaloFallbackDetail(media: ZaloMediaContent): string | undefined {
  return firstNonBlank([media.title, media.description, media.desc, media.action]);
}

export function normalizeZaloPollOptions(
  options: ReadonlyArray<{ content: string }>,
  maxLength = 100,
): string[] {
  return options.map((option, index) => truncate(
    option.content.trim() || `Lựa chọn ${index + 1}`,
    maxLength,
  ));
}

/** Resolve URL variants emitted by different Zalo clients for chat.recommended. */
export function resolveZaloLinkContent(media: ZaloMediaContent): ZaloLinkContent | null {
  const href = firstNonBlank([media.href, media.src, media.msg]);
  if (!href) return null;
  const title = firstNonBlank([media.title, media.desc]) ?? href;
  return { href, title };
}

/** Resolve Zalo photo variants in quality order while retaining CDN fallbacks. */
export function resolveZaloPhotoContent(media: ZaloMediaContent): ZaloPhotoContent | null {
  let hdUrl: string | undefined;
  if (media.params) {
    try {
      const params = JSON.parse(media.params) as { hd?: unknown };
      hdUrl = firstNonBlank([params.hd]);
    } catch { /* Ignore malformed provider metadata. */ }
  }

  const urls = Array.from(new Set(
    [hdUrl, media.href, media.thumb]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map(value => value.trim()),
  ));
  if (urls.length === 0) return null;

  const caption = firstNonBlank([media.title, media.description]);
  return { urls, ...(caption ? { caption } : {}) };
}
