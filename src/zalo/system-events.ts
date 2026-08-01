import type { ZaloMediaContent } from './types.js';

export interface EcardData {
  title: string;
  description: string;
  notification: string;
  imageUrl?: string;
}

export function parseEcard(media: ZaloMediaContent): EcardData {
  let notification = '';
  try {
    const params = JSON.parse(media.params ?? '{}') as { notifyTxt?: string };
    notification = typeof params.notifyTxt === 'string' ? params.notifyTxt : '';
  } catch { /* malformed optional metadata */ }
  return {
    title: media.title?.trim() ?? '',
    description: media.description?.trim() ?? '',
    notification,
    ...(media.href ? { imageUrl: media.href } : {}),
  };
}

export function parseMissedCall(media: ZaloMediaContent): { video: boolean } | null {
  if (media.action !== 'recommened.misscall') return null;
  try {
    const params = JSON.parse(media.params ?? '{}') as { calltype?: number };
    return { video: params.calltype === 1 };
  } catch {
    return { video: false };
  }
}

export interface DeletedZaloMessage {
  uidFrom?: string;
  clientDelMsgId?: string | number;
  globalDelMsgId?: string | number;
  destId?: string | number;
}

export function parseDeletedZaloMessages(raw: unknown): DeletedZaloMessage[] {
  if (Array.isArray(raw)) return raw as DeletedZaloMessage[];
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as DeletedZaloMessage[] : [];
  } catch {
    return [];
  }
}

export function parseGroupRename(
  eventType: unknown,
  data: unknown,
): string | null {
  if (eventType !== 'update' && eventType !== 'update_setting') return null;
  if (!data || typeof data !== 'object') return null;
  const record = data as { groupName?: unknown; name?: unknown };
  const value = typeof record.groupName === 'string'
    ? record.groupName
    : typeof record.name === 'string'
      ? record.name
      : '';
  return value.trim() || null;
}

export function extractUndoTargetId(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const record = data as {
    msgId?: unknown;
    content?: { globalMsgId?: unknown; cliMsgId?: unknown };
  };
  for (const candidate of [
    record.content?.globalMsgId,
    record.content?.cliMsgId,
    record.msgId,
  ]) {
    if (candidate === undefined || candidate === null) continue;
    const normalized = String(candidate).trim();
    if (normalized && normalized !== '0') return normalized;
  }
  return null;
}
