import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { normalizeMessageId } from '../../domain/message-id.js';
import type { BridgeDatabase } from './database.js';

const LEGACY_FILES = ['topics.json', 'settings.json', 'msg-map.json'] as const;

type LegacyFileName = (typeof LEGACY_FILES)[number];
type ImportStatus = 'imported' | 'skipped' | 'missing';
type ThreadType = 0 | 1;
type Direction = 'zalo_to_telegram' | 'telegram_to_zalo';

interface ImportCounts {
  recordsRead: number;
  recordsImported: number;
  recordsQuarantined: number;
}

interface LegacyImportRecord extends ImportCounts {
  sourcePath: string;
  sourceSha256: string;
}

interface QuarantineWriter {
  add(recordKey: string | null, reason: string, payload: unknown): void;
  readonly count: number;
}

interface LegacyQuote {
  zaloId?: unknown;
  threadType?: unknown;
  msgId?: unknown;
  cliMsgId?: unknown;
  [key: string]: unknown;
}

interface LegacySentInfo {
  zaloId?: unknown;
  threadType?: unknown;
  msgId?: unknown;
  cliMsgId?: unknown;
  [key: string]: unknown;
}

export interface LegacyFileImportResult extends ImportCounts {
  fileName: LegacyFileName;
  sourcePath: string;
  sourceSha256?: string;
  status: ImportStatus;
}

export interface LegacyImportResult extends ImportCounts {
  files: LegacyFileImportResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isThreadType(value: unknown): value is ThreadType {
  return value === 0 || value === 1;
}

function isTelegramMessageId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function conversationKey(zaloId: string, threadType: ThreadType): string {
  return `${threadType}:${zaloId}`;
}

function stringifyPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload) ?? 'null';
  } catch {
    return JSON.stringify({ unserializable: String(payload) });
  }
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function parseJson(content: Buffer): unknown {
  const text = content.toString('utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text) as unknown;
}

function createQuarantineWriter(
  db: BridgeDatabase,
  sourcePath: string,
  sourceSha256: string,
  now: number,
): QuarantineWriter {
  const insert = db.prepare(`
    INSERT INTO migration_quarantine(
      source_path, source_sha256, record_key, reason, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  let count = 0;

  return {
    add(recordKey, reason, payload): void {
      insert.run(
        sourcePath,
        sourceSha256,
        recordKey,
        reason,
        stringifyPayload(payload),
        now,
      );
      count += 1;
    },
    get count(): number {
      return count;
    },
  };
}

function importTopics(
  db: BridgeDatabase,
  parsed: unknown,
  telegramChatId: number,
  now: number,
  quarantine: QuarantineWriter,
): Omit<ImportCounts, 'recordsQuarantined'> {
  if (!isRecord(parsed) || !isRecord(parsed.topics)) {
    quarantine.add(null, 'invalid_topics_document', parsed);
    return { recordsRead: 1, recordsImported: 0 };
  }

  const entries = Object.entries(parsed.topics);
  let imported = 0;
  const replaceTopic = db.transaction((
    topicId: number,
    zaloId: string,
    threadType: ThreadType,
    name: string,
  ) => {
    db.prepare(`
      DELETE FROM topic_links
      WHERE telegram_chat_id = ?
        AND (
          telegram_topic_id = ?
          OR (zalo_thread_id = ? AND thread_type = ?)
        )
    `).run(telegramChatId, topicId, zaloId, threadType);
    db.prepare(`
      INSERT INTO topic_links(
        telegram_chat_id, telegram_topic_id, zalo_thread_id, thread_type,
        name, source, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'legacy', ?)
    `).run(telegramChatId, topicId, zaloId, threadType, name, now);
  });

  for (const [recordKey, rawEntry] of entries) {
    if (!isRecord(rawEntry)) {
      quarantine.add(recordKey, 'invalid_topic_record', rawEntry);
      continue;
    }

    const topicId = rawEntry.topicId;
    const zaloId = typeof rawEntry.zaloId === 'string' ? rawEntry.zaloId.trim() : '';
    const threadType = rawEntry.type;
    const name = typeof rawEntry.name === 'string' ? rawEntry.name.trim() : '';
    if (
      !Number.isSafeInteger(topicId)
      || Number(topicId) <= 1
      || !zaloId
      || !isThreadType(threadType)
      || !name
    ) {
      quarantine.add(recordKey, 'invalid_topic_record', rawEntry);
      continue;
    }

    replaceTopic(Number(topicId), zaloId, threadType, name);
    imported += 1;
  }

  return { recordsRead: entries.length, recordsImported: imported };
}

function importSettings(
  db: BridgeDatabase,
  parsed: unknown,
  now: number,
  quarantine: QuarantineWriter,
): Omit<ImportCounts, 'recordsQuarantined'> {
  if (!isRecord(parsed)) {
    quarantine.add('app', 'invalid_settings_document', parsed);
    return { recordsRead: 1, recordsImported: 0 };
  }

  db.prepare(`
    INSERT INTO app_settings(key, value_json, updated_at)
    VALUES ('app', ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(JSON.stringify(parsed), now);
  return { recordsRead: 1, recordsImported: 1 };
}

function upsertMessageLink(
  db: BridgeDatabase,
  telegramChatId: number,
  telegramMessageId: number,
  conversation: string,
  direction: Direction,
  quote: unknown,
  now: number,
): number {
  db.prepare(`
    INSERT INTO message_links(
      telegram_chat_id, telegram_message_id, conversation_key, direction,
      quote_json, source, created_at
    ) VALUES (?, ?, ?, ?, ?, 'legacy', ?)
    ON CONFLICT(telegram_chat_id, telegram_message_id, direction) DO UPDATE SET
      conversation_key = excluded.conversation_key,
      quote_json = excluded.quote_json,
      source = 'legacy',
      created_at = excluded.created_at
  `).run(
    telegramChatId,
    telegramMessageId,
    conversation,
    direction,
    quote === undefined ? null : JSON.stringify(quote),
    now,
  );

  const row = db.prepare(`
    SELECT id
    FROM message_links
    WHERE telegram_chat_id = ?
      AND telegram_message_id = ?
      AND direction = ?
  `).get(telegramChatId, telegramMessageId, direction) as { id: number } | undefined;
  if (!row) throw new Error('Message link upsert did not return a durable row.');
  return row.id;
}

function upsertAlias(
  db: BridgeDatabase,
  conversation: string,
  alias: string,
  aliasKind: string,
  messageLinkId: number,
  now: number,
): void {
  db.prepare(`
    INSERT INTO message_aliases(
      conversation_key, alias, alias_kind, message_link_id, created_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(conversation_key, alias) DO UPDATE SET
      alias_kind = excluded.alias_kind,
      message_link_id = excluded.message_link_id,
      created_at = excluded.created_at
  `).run(conversation, alias, aliasKind, messageLinkId, now);
}

function parseQuote(
  value: unknown,
): { quote: LegacyQuote; zaloId: string; threadType: ThreadType } | undefined {
  if (!isRecord(value)) return undefined;
  const zaloId = typeof value.zaloId === 'string' ? value.zaloId.trim() : '';
  if (!zaloId || !isThreadType(value.threadType)) return undefined;
  return { quote: value as LegacyQuote, zaloId, threadType: value.threadType };
}

function importMessageMap(
  db: BridgeDatabase,
  parsed: unknown,
  telegramChatId: number,
  now: number,
  quarantine: QuarantineWriter,
): Omit<ImportCounts, 'recordsQuarantined'> {
  if (
    !isRecord(parsed)
    || !Array.isArray(parsed.pairs)
    || !Array.isArray(parsed.quotes)
    || (parsed.sent !== undefined && !Array.isArray(parsed.sent))
  ) {
    quarantine.add(null, 'invalid_message_map_document', parsed);
    return { recordsRead: 1, recordsImported: 0 };
  }

  const pairs = parsed.pairs;
  const quotes = parsed.quotes;
  const sent = Array.isArray(parsed.sent) ? parsed.sent : [];
  const recordsRead = pairs.length + quotes.length + sent.length;
  let imported = 0;

  const finalQuotes = new Map<number, { quote: LegacyQuote; zaloId: string; threadType: ThreadType }>();
  for (const rawEntry of quotes) {
    if (!Array.isArray(rawEntry) || rawEntry.length !== 2 || !isTelegramMessageId(rawEntry[0])) {
      quarantine.add(null, 'invalid_quote_record', rawEntry);
      continue;
    }
    const telegramMessageId = rawEntry[0];
    const parsedQuote = parseQuote(rawEntry[1]);
    if (!parsedQuote) {
      quarantine.add(String(telegramMessageId), 'invalid_quote_record', rawEntry);
      continue;
    }
    if (finalQuotes.has(telegramMessageId)) {
      quarantine.add(String(telegramMessageId), 'duplicate_quote_record', rawEntry);
    }
    finalQuotes.set(telegramMessageId, parsedQuote);
  }

  const incomingLinks = new Map<number, { id: number; conversation: string; quote: LegacyQuote }>();
  for (const [telegramMessageId, entry] of finalQuotes) {
    const conversation = conversationKey(entry.zaloId, entry.threadType);
    const id = upsertMessageLink(
      db,
      telegramChatId,
      telegramMessageId,
      conversation,
      'zalo_to_telegram',
      entry.quote,
      now,
    );
    db.prepare('DELETE FROM message_aliases WHERE message_link_id = ?').run(id);
    incomingLinks.set(telegramMessageId, { id, conversation, quote: entry.quote });
    imported += 1;
  }

  const finalPairs = new Map<string, { telegramMessageId: number; payload: unknown }>();
  for (const rawEntry of pairs) {
    if (!Array.isArray(rawEntry) || rawEntry.length !== 2) {
      quarantine.add(null, 'invalid_message_pair', rawEntry);
      continue;
    }
    const alias = normalizeMessageId(rawEntry[0]);
    if (!alias) {
      quarantine.add(String(rawEntry[0] ?? ''), 'invalid_message_alias', rawEntry);
      continue;
    }
    if (!isTelegramMessageId(rawEntry[1])) {
      quarantine.add(alias, 'invalid_telegram_message_id', rawEntry);
      continue;
    }
    if (finalPairs.has(alias)) {
      quarantine.add(alias, 'duplicate_message_alias', finalPairs.get(alias)?.payload);
    }
    finalPairs.set(alias, { telegramMessageId: rawEntry[1], payload: rawEntry });
  }

  for (const [alias, pair] of finalPairs) {
    const link = incomingLinks.get(pair.telegramMessageId);
    if (!link) {
      quarantine.add(alias, 'message_alias_without_valid_quote', pair.payload);
      continue;
    }
    const quoteMsgId = normalizeMessageId(link.quote.msgId);
    const quoteCliMsgId = normalizeMessageId(link.quote.cliMsgId);
    const aliasKind = alias === quoteMsgId
      ? 'msg_id'
      : alias === quoteCliMsgId
        ? 'cli_msg_id'
        : 'legacy_pair';
    upsertAlias(db, link.conversation, alias, aliasKind, link.id, now);
    imported += 1;
  }

  const finalSent = new Map<number, LegacySentInfo>();
  for (const rawEntry of sent) {
    if (!Array.isArray(rawEntry) || rawEntry.length !== 2 || !isTelegramMessageId(rawEntry[0])) {
      quarantine.add(null, 'invalid_sent_record', rawEntry);
      continue;
    }
    if (!isRecord(rawEntry[1])) {
      quarantine.add(String(rawEntry[0]), 'invalid_sent_record', rawEntry);
      continue;
    }
    if (finalSent.has(rawEntry[0])) {
      quarantine.add(String(rawEntry[0]), 'duplicate_sent_record', finalSent.get(rawEntry[0]));
    }
    finalSent.set(rawEntry[0], rawEntry[1] as LegacySentInfo);
  }

  for (const [telegramMessageId, info] of finalSent) {
    const zaloId = typeof info.zaloId === 'string' ? info.zaloId.trim() : '';
    if (!zaloId || !isThreadType(info.threadType)) {
      quarantine.add(String(telegramMessageId), 'invalid_sent_record', info);
      continue;
    }

    const candidates = [
      { kind: 'msg_id', raw: info.msgId },
      { kind: 'cli_msg_id', raw: info.cliMsgId },
    ];
    const aliases: Array<{ kind: string; alias: string }> = [];
    const aliasesSeen = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.raw === undefined || candidate.raw === null) continue;
      const alias = normalizeMessageId(candidate.raw);
      if (!alias) {
        quarantine.add(
          `${telegramMessageId}:${candidate.kind}`,
          'invalid_message_alias',
          { telegramMessageId, kind: candidate.kind, value: candidate.raw },
        );
        continue;
      }
      if (aliasesSeen.has(alias)) {
        quarantine.add(
          `${telegramMessageId}:${candidate.kind}`,
          'duplicate_message_alias',
          { telegramMessageId, kind: candidate.kind, value: candidate.raw },
        );
        continue;
      }
      aliasesSeen.add(alias);
      aliases.push({ kind: candidate.kind, alias });
    }
    if (aliases.length === 0) {
      quarantine.add(String(telegramMessageId), 'sent_record_without_valid_alias', info);
      continue;
    }

    const conversation = conversationKey(zaloId, info.threadType);
    const linkId = upsertMessageLink(
      db,
      telegramChatId,
      telegramMessageId,
      conversation,
      'telegram_to_zalo',
      undefined,
      now,
    );
    db.prepare('DELETE FROM message_aliases WHERE message_link_id = ?').run(linkId);
    for (const { alias, kind } of aliases) {
      upsertAlias(db, conversation, alias, kind, linkId, now);
    }
    imported += 1;
  }

  return { recordsRead, recordsImported: imported };
}

function importedRecord(
  db: BridgeDatabase,
  sourcePath: string,
  fileName: LegacyFileName,
): LegacyImportRecord | undefined {
  const exact = db.prepare(`
    SELECT
      source_path AS sourcePath,
      source_sha256 AS sourceSha256,
      records_read AS recordsRead,
      records_imported AS recordsImported,
      records_quarantined AS recordsQuarantined
    FROM legacy_imports
    WHERE source_path = ?
    ORDER BY imported_at, id
    LIMIT 1
  `).get(sourcePath) as LegacyImportRecord | undefined;
  if (exact) return exact;

  // DATA_DIR can legitimately change during a restore or deployment move.
  // A compatibility shadow is still the same logical legacy source, so a new
  // absolute path must not make it eligible for replay into another chat.
  const records = db.prepare(`
    SELECT
      source_path AS sourcePath,
      source_sha256 AS sourceSha256,
      records_read AS recordsRead,
      records_imported AS recordsImported,
      records_quarantined AS recordsQuarantined
    FROM legacy_imports
    ORDER BY imported_at, id
  `).all() as LegacyImportRecord[];
  return records.find(record => (
    record.sourcePath.replaceAll('\\', '/').split('/').at(-1) === fileName
  ));
}

function importFile(
  db: BridgeDatabase,
  dataDir: string,
  telegramChatId: number,
  fileName: LegacyFileName,
): LegacyFileImportResult {
  const sourcePath = path.resolve(dataDir, fileName);
  if (!existsSync(sourcePath)) {
    return {
      fileName,
      sourcePath,
      status: 'missing',
      recordsRead: 0,
      recordsImported: 0,
      recordsQuarantined: 0,
    };
  }

  const content = readFileSync(sourcePath);
  const sourceSha256 = sha256(content);
  // Legacy JSON files become runtime compatibility shadows after the first
  // migration. Importing a later hash would replay state from another
  // Telegram group back into the current group on every restart.
  const previous = importedRecord(db, sourcePath, fileName);
  if (previous) {
    return {
      fileName,
      sourcePath,
      sourceSha256,
      status: 'skipped',
      recordsRead: previous.recordsRead,
      recordsImported: previous.recordsImported,
      recordsQuarantined: previous.recordsQuarantined,
    };
  }

  return db.transaction(() => {
    const now = Date.now();
    const quarantine = createQuarantineWriter(db, sourcePath, sourceSha256, now);
    let counts: Omit<ImportCounts, 'recordsQuarantined'>;
    let parsed: unknown;
    try {
      parsed = parseJson(content);
    } catch (error) {
      quarantine.add(
        null,
        'invalid_json',
        { error: error instanceof Error ? error.message : String(error) },
      );
      counts = { recordsRead: 1, recordsImported: 0 };
    }

    if (parsed !== undefined) {
      if (fileName === 'topics.json') {
        counts = importTopics(db, parsed, telegramChatId, now, quarantine);
      } else if (fileName === 'settings.json') {
        counts = importSettings(db, parsed, now, quarantine);
      } else {
        counts = importMessageMap(db, parsed, telegramChatId, now, quarantine);
      }
    }

    const result: LegacyFileImportResult = {
      fileName,
      sourcePath,
      sourceSha256,
      status: 'imported',
      recordsRead: counts!.recordsRead,
      recordsImported: counts!.recordsImported,
      recordsQuarantined: quarantine.count,
    };
    db.prepare(`
      INSERT INTO legacy_imports(
        source_path, source_sha256, imported_at,
        records_read, records_imported, records_quarantined
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      sourcePath,
      sourceSha256,
      now,
      result.recordsRead,
      result.recordsImported,
      result.recordsQuarantined,
    );
    return result;
  })();
}

export function importLegacyState(
  db: BridgeDatabase,
  dataDir: string,
  telegramChatId: number,
): LegacyImportResult {
  if (!db.open) throw new Error('Cannot import legacy state into a closed database.');
  if (!Number.isSafeInteger(telegramChatId)) {
    throw new Error(`Invalid Telegram chat ID: ${telegramChatId}`);
  }

  const files = LEGACY_FILES.map(fileName =>
    importFile(db, dataDir, telegramChatId, fileName),
  );
  return {
    files,
    recordsRead: files.reduce((sum, file) => sum + file.recordsRead, 0),
    recordsImported: files.reduce((sum, file) => sum + file.recordsImported, 0),
    recordsQuarantined: files.reduce((sum, file) => sum + file.recordsQuarantined, 0),
  };
}

export const importLegacyData = importLegacyState;
