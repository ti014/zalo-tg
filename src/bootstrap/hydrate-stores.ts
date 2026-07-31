import type { BridgeDatabase } from '../infrastructure/database/database.js';
import { msgStore } from '../store/messages.js';
import { settingsStore, type AppSettings } from '../store/settings.js';
import { store, type TopicEntry } from '../store/topics.js';

interface TopicRow {
  telegram_topic_id: number;
  zalo_thread_id: string;
  thread_type: 0 | 1;
  name: string;
}

interface MessageLinkRow {
  id: number;
  telegram_message_id: number;
  conversation_key: string;
  direction: 'zalo_to_telegram' | 'telegram_to_zalo';
  quote_json: string | null;
}

interface AliasRow {
  message_link_id: number;
  alias: string;
}

export interface StoreHydrationResult {
  topics: number;
  incomingMessageLinks: number;
  sentMessageLinks: number;
  aliases: number;
  settings: boolean;
}

function requireRecoverable(
  label: string,
  state: { status: 'loaded' | 'missing' | 'invalid'; error?: Error },
  sqliteRecords: number,
): void {
  if (state.status === 'invalid' && sqliteRecords === 0) {
    throw new Error(
      `${label} is invalid and SQLite contains no recovery state; restore a known-good backup.`,
      { cause: state.error },
    );
  }
}

function conversationTarget(conversationKey: string): { type: 0 | 1; zaloId: string } {
  const match = conversationKey.match(/^([01]):(.+)$/);
  if (!match) throw new Error(`Invalid conversation key in SQLite shadow state: ${conversationKey}`);
  return { type: Number(match[1]) as 0 | 1, zaloId: match[2]! };
}

/**
 * Hydrates the in-memory/JSON compatibility stores from SQLite before any
 * provider listener or delivery worker starts.
 *
 * SQLite remains the recovery source. Invalid legacy JSON is never silently
 * replaced with an empty document: recovery fails if the corresponding SQLite
 * state is also empty.
 */
export function hydrateCompatibilityStores(
  db: BridgeDatabase,
  telegramChatId: number,
): StoreHydrationResult {
  const topicRows = db.prepare(`
    SELECT telegram_topic_id, zalo_thread_id, thread_type, name
    FROM topic_links
    WHERE telegram_chat_id = ?
    ORDER BY telegram_topic_id
  `).all(telegramChatId) as TopicRow[];
  requireRecoverable('topics.json', store.loadState(), topicRows.length);
  store.replaceAll(
    topicRows.map((row): TopicEntry => ({
      topicId: row.telegram_topic_id,
      zaloId: row.zalo_thread_id,
      type: row.thread_type,
      name: row.name,
    })),
    { synchronizeShadow: false },
  );

  const settingsRow = db.prepare(`
    SELECT value_json
    FROM app_settings
    WHERE key = 'app'
  `).get() as { value_json: string } | undefined;
  requireRecoverable('settings.json', settingsStore.loadState(), settingsRow ? 1 : 0);
  if (settingsRow) {
    let parsed: Partial<AppSettings>;
    try {
      parsed = JSON.parse(settingsRow.value_json) as Partial<AppSettings>;
    } catch (error) {
      throw new Error('SQLite app settings contain invalid JSON.', { cause: error });
    }
    settingsStore.replace(parsed);
  }

  const messageLinks = db.prepare(`
    SELECT id, telegram_message_id, conversation_key, direction, quote_json
    FROM message_links
    WHERE telegram_chat_id = ?
    ORDER BY created_at, id
  `).all(telegramChatId) as MessageLinkRow[];
  requireRecoverable('msg-map.json', msgStore.loadState(), messageLinks.length);

  let incomingMessageLinks = 0;
  let sentMessageLinks = 0;
  let aliases = 0;
  const pairs: Array<[string, number]> = [];
  const quotes: Array<[number, Record<string, unknown>]> = [];
  const sent: Array<[number, {
    msgId: string;
    cliMsgId?: string;
    zaloId: string;
    threadType: 0 | 1;
  }]> = [];
  if (messageLinks.length > 0) {
    const aliasRows = db.prepare(`
      SELECT aliases.message_link_id, aliases.alias
      FROM message_aliases aliases
      JOIN message_links links ON links.id = aliases.message_link_id
      WHERE links.telegram_chat_id = ?
      ORDER BY
        aliases.message_link_id,
        CASE aliases.alias_kind
          WHEN 'msg_id' THEN 0
          WHEN 'cli_msg_id' THEN 1
          WHEN 'global_msg_id' THEN 2
          ELSE 3
        END,
        aliases.rowid
    `).all(telegramChatId) as AliasRow[];
    const aliasesByLink = new Map<number, string[]>();
    for (const row of aliasRows) {
      const current = aliasesByLink.get(row.message_link_id) ?? [];
      current.push(row.alias);
      aliasesByLink.set(row.message_link_id, current);
    }

    for (const link of messageLinks) {
      const linkAliases = aliasesByLink.get(link.id) ?? [];
      if (link.direction === 'zalo_to_telegram') {
        if (!link.quote_json) {
          throw new Error(`Incoming SQLite message link ${link.id} has no quote JSON.`);
        }
        let quote: Record<string, unknown>;
        try {
          quote = JSON.parse(link.quote_json) as Record<string, unknown>;
        } catch (error) {
          throw new Error(`Incoming SQLite message link ${link.id} has invalid quote JSON.`, {
            cause: error,
          });
        }
        const target = conversationTarget(link.conversation_key);
        quote = { ...quote, zaloId: target.zaloId, threadType: target.type };
        quotes.push([link.telegram_message_id, quote]);
        for (const alias of linkAliases) pairs.push([alias, link.telegram_message_id]);
        incomingMessageLinks += 1;
        aliases += linkAliases.length;
        continue;
      }

      const target = conversationTarget(link.conversation_key);
      const [msgId, cliMsgId] = linkAliases;
      if (!msgId) {
        throw new Error(`Sent SQLite message link ${link.id} has no valid provider alias.`);
      }
      sent.push([
        link.telegram_message_id,
        {
          msgId,
          ...(cliMsgId ? { cliMsgId } : {}),
          zaloId: target.zaloId,
          threadType: target.type,
        },
      ]);
      sentMessageLinks += 1;
      aliases += linkAliases.length;
    }

  }

  // SQLite is authoritative even when the current Telegram chat has no rows.
  // Always replacing the compatibility cache prevents a valid JSON shadow
  // from a previous group from leaking into a newly configured group. The
  // bounded cache must not synchronize back into SQLite during hydration.
  msgStore.replaceFromJson(
    JSON.stringify({ pairs, quotes, sent }),
    { synchronizeShadow: false },
  );

  return {
    topics: topicRows.length,
    incomingMessageLinks,
    sentMessageLinks,
    aliases,
    settings: Boolean(settingsRow),
  };
}
