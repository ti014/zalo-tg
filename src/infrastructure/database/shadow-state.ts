import type { SentMsgInfo, ZaloQuoteData } from '../../store/messages.js';
import type { AppSettings } from '../../store/settings.js';
import type { TopicEntry } from '../../store/topics.js';
import { normalizeMessageId, normalizeMessageIds } from '../../domain/message-id.js';
import type { BridgeDatabase } from './database.js';

type MessageAliasKind = 'cli_msg_id' | 'msg_id' | 'provider_alias';

interface MessageAliasInput {
  value: unknown;
  kind: MessageAliasKind;
}

let shadowDb: BridgeDatabase | undefined;
let telegramChatId: number | undefined;
let shadowErrors = 0;

export class SqliteShadowWriteError extends Error {
  readonly code = 'SHADOW_WRITE_FAILED';

  constructor(label: string, cause: unknown) {
    super(`SQLite shadow operation ${label} failed.`, { cause });
    this.name = 'SqliteShadowWriteError';
  }
}

function withShadow(label: string, operation: (db: BridgeDatabase, chatId: number) => void): void {
  if (!shadowDb || telegramChatId === undefined) return;
  try {
    operation(shadowDb, telegramChatId);
  } catch (error) {
    shadowErrors += 1;
    throw new SqliteShadowWriteError(label, error);
  }
}

function conversationKey(zaloId: string, threadType: 0 | 1): string {
  return `${threadType}:${zaloId}`;
}

function incomingAliasInputs(
  aliases: readonly unknown[],
  quote: ZaloQuoteData,
): MessageAliasInput[] {
  const msgId = normalizeMessageId(quote.msgId);
  const cliMsgId = normalizeMessageId(quote.cliMsgId);
  return aliases.map(value => {
    const alias = normalizeMessageId(value);
    const kind: MessageAliasKind = alias !== undefined && alias === msgId
      ? 'msg_id'
      : alias !== undefined && alias === cliMsgId
        ? 'cli_msg_id'
        : 'provider_alias';
    return { value, kind };
  });
}

function sentAliasInputs(info: SentMsgInfo): MessageAliasInput[] {
  return [
    { value: info.msgId, kind: 'msg_id' },
    { value: info.cliMsgId, kind: 'cli_msg_id' },
  ];
}

function upsertTopic(db: BridgeDatabase, chatId: number, entry: TopicEntry): void {
  const now = Date.now();
  db.prepare(`
    DELETE FROM topic_links
    WHERE telegram_chat_id = ?
      AND (telegram_topic_id = ? OR (zalo_thread_id = ? AND thread_type = ?))
  `).run(chatId, entry.topicId, entry.zaloId, entry.type);
  db.prepare(`
    INSERT INTO topic_links(
      telegram_chat_id, telegram_topic_id, zalo_thread_id, thread_type, name, source, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'runtime', ?)
  `).run(chatId, entry.topicId, entry.zaloId, entry.type, entry.name, now);
}

function upsertMessageLink(
  db: BridgeDatabase,
  chatId: number,
  telegramMessageId: number,
  aliases: readonly MessageAliasInput[],
  conversation: string,
  direction: 'telegram_to_zalo' | 'zalo_to_telegram',
  quote: ZaloQuoteData | undefined,
): void {
  const validAliases: Array<{ alias: string; kind: MessageAliasKind }> = [];
  const seenAliases = new Set<string>();
  for (const input of aliases) {
    const alias = normalizeMessageId(input.value);
    if (!alias || seenAliases.has(alias)) continue;
    seenAliases.add(alias);
    validAliases.push({ alias, kind: input.kind });
  }
  const now = Date.now();
  db.prepare(`
    INSERT INTO message_links(
      telegram_chat_id, telegram_message_id, conversation_key, direction,
      quote_json, source, created_at
    ) VALUES (?, ?, ?, ?, ?, 'runtime', ?)
    ON CONFLICT(telegram_chat_id, telegram_message_id, direction) DO UPDATE SET
      conversation_key = excluded.conversation_key,
      quote_json = excluded.quote_json,
      source = 'runtime'
  `).run(
    chatId,
    telegramMessageId,
    conversation,
    direction,
    quote ? JSON.stringify(quote) : null,
    now,
  );
  const link = db.prepare(`
    SELECT id FROM message_links
    WHERE telegram_chat_id = ? AND telegram_message_id = ? AND direction = ?
  `).get(chatId, telegramMessageId, direction) as { id: number };
  db.prepare('DELETE FROM message_aliases WHERE message_link_id = ?').run(link.id);
  const insertAlias = db.prepare(`
    INSERT INTO message_aliases(
      conversation_key, alias, alias_kind, message_link_id, created_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(conversation_key, alias) DO UPDATE SET
      alias_kind = excluded.alias_kind,
      message_link_id = excluded.message_link_id,
      created_at = excluded.created_at
  `);
  for (const { alias, kind } of validAliases) {
    insertAlias.run(conversation, alias, kind, link.id, now);
  }
}

export function configureSqliteShadow(db: BridgeDatabase, chatId: number): void {
  shadowDb = db;
  telegramChatId = chatId;
  shadowErrors = 0;
}

export function disableSqliteShadow(): void {
  shadowDb = undefined;
  telegramChatId = undefined;
}

export function sqliteShadowErrorCount(): number {
  return shadowErrors;
}

export function lookupShadowSentTelegramId(
  zaloId: string,
  threadType: 0 | 1,
  aliases: readonly unknown[],
): number | undefined {
  if (!shadowDb || telegramChatId === undefined) return undefined;
  const validAliases = normalizeMessageIds(aliases);
  if (validAliases.length === 0) return undefined;
  const placeholders = validAliases.map(() => '?').join(', ');
  const row = shadowDb.prepare(`
    SELECT links.telegram_message_id
    FROM message_aliases aliases
    JOIN message_links links ON links.id = aliases.message_link_id
    WHERE links.telegram_chat_id = ?
      AND links.direction = 'telegram_to_zalo'
      AND aliases.conversation_key = ?
      AND aliases.alias IN (${placeholders})
    ORDER BY links.created_at DESC
    LIMIT 1
  `).get(
    telegramChatId,
    conversationKey(zaloId, threadType),
    ...validAliases,
  ) as { telegram_message_id: number } | undefined;
  return row?.telegram_message_id;
}

export function lookupShadowIncomingTelegramId(alias: unknown): number | undefined {
  if (!shadowDb || telegramChatId === undefined) return undefined;
  const [normalized] = normalizeMessageIds([alias]);
  if (!normalized) return undefined;
  const row = shadowDb.prepare(`
    SELECT links.telegram_message_id
    FROM message_aliases aliases
    JOIN message_links links ON links.id = aliases.message_link_id
    WHERE links.telegram_chat_id = ?
      AND links.direction = 'zalo_to_telegram'
      AND aliases.alias = ?
    ORDER BY links.created_at DESC
    LIMIT 1
  `).get(telegramChatId, normalized) as { telegram_message_id: number } | undefined;
  return row?.telegram_message_id;
}

export function lookupShadowIncomingQuote(telegramMessageId: number): ZaloQuoteData | undefined {
  if (!shadowDb || telegramChatId === undefined) return undefined;
  const row = shadowDb.prepare(`
    SELECT quote_json
    FROM message_links
    WHERE telegram_chat_id = ?
      AND telegram_message_id = ?
      AND direction = 'zalo_to_telegram'
    LIMIT 1
  `).get(telegramChatId, telegramMessageId) as { quote_json: string | null } | undefined;
  if (!row?.quote_json) return undefined;
  try {
    return JSON.parse(row.quote_json) as ZaloQuoteData;
  } catch {
    return undefined;
  }
}

export function lookupShadowSentInfo(telegramMessageId: number): SentMsgInfo | undefined {
  if (!shadowDb || telegramChatId === undefined) return undefined;
  const link = shadowDb.prepare(`
    SELECT id, conversation_key
    FROM message_links
    WHERE telegram_chat_id = ?
      AND telegram_message_id = ?
      AND direction = 'telegram_to_zalo'
    LIMIT 1
  `).get(telegramChatId, telegramMessageId) as { id: number; conversation_key: string } | undefined;
  if (!link) return undefined;
  const match = link.conversation_key.match(/^([01]):(.+)$/);
  if (!match) return undefined;
  const aliases = shadowDb.prepare(`
    SELECT alias
    FROM message_aliases
    WHERE message_link_id = ?
    ORDER BY CASE alias_kind WHEN 'msg_id' THEN 0 WHEN 'cli_msg_id' THEN 1 ELSE 2 END, rowid
  `).all(link.id) as Array<{ alias: string }>;
  if (!aliases[0]) return undefined;
  return {
    msgId: aliases[0].alias,
    ...(aliases[1] ? { cliMsgId: aliases[1].alias } : {}),
    zaloId: match[2]!,
    threadType: Number(match[1]) as 0 | 1,
  };
}

export function lookupShadowSentTelegramIdByAlias(alias: unknown): number | undefined {
  if (!shadowDb || telegramChatId === undefined) return undefined;
  const [normalized] = normalizeMessageIds([alias]);
  if (!normalized) return undefined;
  const row = shadowDb.prepare(`
    SELECT links.telegram_message_id
    FROM message_aliases aliases
    JOIN message_links links ON links.id = aliases.message_link_id
    WHERE links.telegram_chat_id = ?
      AND links.direction = 'telegram_to_zalo'
      AND aliases.alias = ?
    ORDER BY links.created_at DESC
    LIMIT 1
  `).get(telegramChatId, normalized) as { telegram_message_id: number } | undefined;
  return row?.telegram_message_id;
}

export function shadowTopicSet(entry: TopicEntry): void {
  withShadow('topic.set', (db, chatId) => db.transaction(() => upsertTopic(db, chatId, entry))());
}

export function shadowTopicsReplace(entries: TopicEntry[]): void {
  withShadow('topic.replaceAll', (db, chatId) => db.transaction(() => {
    db.prepare('DELETE FROM topic_links WHERE telegram_chat_id = ?').run(chatId);
    for (const entry of entries) upsertTopic(db, chatId, entry);
  })());
}

export function shadowTopicRemove(topicId: number): void {
  withShadow('topic.remove', (db, chatId) => {
    db.prepare('DELETE FROM topic_links WHERE telegram_chat_id = ? AND telegram_topic_id = ?')
      .run(chatId, topicId);
  });
}

export function shadowSettingsReplace(settings: AppSettings): void {
  withShadow('settings.replace', db => {
    db.prepare(`
      INSERT INTO app_settings(key, value_json, updated_at)
      VALUES ('app', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(JSON.stringify(settings), Date.now());
  });
}

export function shadowIncomingMessage(
  telegramMessageId: number,
  aliases: readonly unknown[],
  quote: ZaloQuoteData,
): void {
  withShadow('message.incoming', (db, chatId) => db.transaction(() => upsertMessageLink(
    db,
    chatId,
    telegramMessageId,
    incomingAliasInputs(aliases, quote),
    conversationKey(quote.zaloId, quote.threadType),
    'zalo_to_telegram',
    quote,
  ))());
}

export function shadowSentMessage(telegramMessageId: number, info: SentMsgInfo): void {
  withShadow('message.sent', (db, chatId) => db.transaction(() => upsertMessageLink(
    db,
    chatId,
    telegramMessageId,
    sentAliasInputs(info),
    conversationKey(info.zaloId, info.threadType),
    'telegram_to_zalo',
    undefined,
  ))());
}

export interface ShadowIncomingMessageSnapshot {
  telegramMessageId: number;
  aliases: readonly unknown[];
  quote: ZaloQuoteData;
}

export interface ShadowSentMessageSnapshot {
  telegramMessageId: number;
  info: SentMsgInfo;
}

export function shadowMessagesReplace(
  incoming: readonly ShadowIncomingMessageSnapshot[],
  sent: readonly ShadowSentMessageSnapshot[],
): void {
  withShadow('message.replaceAll', (db, chatId) => db.transaction(() => {
    db.prepare('DELETE FROM message_links WHERE telegram_chat_id = ?').run(chatId);
    for (const entry of incoming) {
      upsertMessageLink(
        db,
        chatId,
        entry.telegramMessageId,
        incomingAliasInputs(entry.aliases, entry.quote),
        conversationKey(entry.quote.zaloId, entry.quote.threadType),
        'zalo_to_telegram',
        entry.quote,
      );
    }
    for (const entry of sent) {
      upsertMessageLink(
        db,
        chatId,
        entry.telegramMessageId,
        sentAliasInputs(entry.info),
        conversationKey(entry.info.zaloId, entry.info.threadType),
        'telegram_to_zalo',
        undefined,
      );
    }
  })());
}

/**
 * Atomically removes compatibility mappings for the configured Telegram chat.
 * Durable deliveries and mappings belonging to other chats are intentionally
 * outside this transaction.
 */
export function shadowMappingsClear(): void {
  if (!shadowDb || telegramChatId === undefined) {
    throw new SqliteShadowWriteError(
      'mapping.clear',
      new Error('SQLite shadow is not configured.'),
    );
  }
  withShadow('mapping.clear', (db, chatId) => db.transaction(() => {
    db.prepare('DELETE FROM message_links WHERE telegram_chat_id = ?').run(chatId);
    db.prepare('DELETE FROM topic_links WHERE telegram_chat_id = ?').run(chatId);
  })());
}
