import { normalizeMessageIds } from './message-id.js';

export interface ZaloReplyIdentifiers {
  globalMsgId?: string | number;
  cliMsgId?: string | number;
}

export interface ZaloReplyMappingReader {
  incomingTelegramId(alias: string): number | undefined;
  incomingConversation(telegramMessageId: number): { zaloId: string; threadType: 0 | 1 } | undefined;
  sentTelegramId(alias: string): number | undefined;
  sentConversation(telegramMessageId: number): { zaloId: string; threadType: 0 | 1 } | undefined;
}

function belongsToConversation(
  mapping: { zaloId: string; threadType: 0 | 1 } | undefined,
  zaloId: string,
  threadType: 0 | 1,
): boolean {
  // Legacy aliases may exist without metadata. Retain upstream compatibility,
  // but reject every mapping that has explicit conflicting ownership.
  return mapping === undefined
    || (mapping.zaloId === zaloId && mapping.threadType === threadType);
}

/** Resolve a Telegram reply target without crossing Zalo conversation boundaries. */
export function resolveTelegramReplyTarget(
  identifiers: ZaloReplyIdentifiers | null | undefined,
  zaloId: string,
  threadType: 0 | 1,
  reader: ZaloReplyMappingReader,
): number | undefined {
  if (!identifiers) return undefined;
  const aliases = normalizeMessageIds([
    identifiers.globalMsgId,
    identifiers.cliMsgId,
  ]);

  for (const alias of aliases) {
    const incoming = reader.incomingTelegramId(alias);
    if (
      incoming !== undefined
      && belongsToConversation(reader.incomingConversation(incoming), zaloId, threadType)
    ) return incoming;

    const sent = reader.sentTelegramId(alias);
    if (
      sent !== undefined
      && belongsToConversation(reader.sentConversation(sent), zaloId, threadType)
    ) return sent;
  }
  return undefined;
}
