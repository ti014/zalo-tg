import { normalizeMessageIds } from './message-id.js';

export type PendingSendKind =
  | 'contact'
  | 'document'
  | 'location'
  | 'photo'
  | 'poll'
  | 'sticker'
  | 'text'
  | 'video'
  | 'voice';

export interface PendingSendInput {
  conversationId: string;
  telegramMessageId?: number;
  kind: PendingSendKind;
  fingerprint?: string;
}

export interface PendingEchoInput {
  conversationId: string;
  aliases: readonly unknown[];
  kind: PendingSendKind;
  fingerprint?: string;
}

interface PendingSendRecord extends PendingSendInput {
  token: string;
  aliases: Set<string>;
  createdAt: number;
  completedAt?: number;
}

export function contentFingerprint(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\s+/g, ' ');
  return normalized ? normalized : undefined;
}

/** Multi-entry correlation registry; never matches by conversation alone. */
export class PendingSendRegistry {
  readonly #records = new Map<string, PendingSendRecord>();
  readonly #tokensByConversation = new Map<string, string[]>();
  readonly #tokensByTelegramMessage = new Map<number, Set<string>>();
  #sequence = 0;

  constructor(
    readonly ttlMs = 10_000,
    readonly now: () => number = Date.now,
  ) {}

  begin(input: PendingSendInput): string {
    this.prune();
    const token = `${this.now().toString(36)}-${(++this.#sequence).toString(36)}`;
    const record: PendingSendRecord = {
      ...input,
      fingerprint: contentFingerprint(input.fingerprint),
      token,
      aliases: new Set(),
      createdAt: this.now(),
    };
    this.#records.set(token, record);

    const conversationTokens = this.#tokensByConversation.get(input.conversationId) ?? [];
    conversationTokens.push(token);
    this.#tokensByConversation.set(input.conversationId, conversationTokens);

    if (input.telegramMessageId !== undefined) {
      const telegramTokens = this.#tokensByTelegramMessage.get(input.telegramMessageId) ?? new Set();
      telegramTokens.add(token);
      this.#tokensByTelegramMessage.set(input.telegramMessageId, telegramTokens);
    }
    return token;
  }

  bindAliases(token: string, aliases: readonly unknown[]): void {
    const record = this.#records.get(token);
    if (!record) return;
    for (const alias of normalizeMessageIds(aliases)) record.aliases.add(alias);
  }

  bindAliasesByTelegramMessage(telegramMessageId: number, aliases: readonly unknown[]): void {
    const tokens = this.#tokensByTelegramMessage.get(telegramMessageId);
    if (!tokens) return;
    for (const token of tokens) this.bindAliases(token, aliases);
  }

  complete(token: string): void {
    const record = this.#records.get(token);
    if (record) record.completedAt = this.now();
  }

  cancel(token: string): void {
    this.#delete(token);
  }

  consume(input: PendingEchoInput): number | undefined {
    this.prune();
    const eventAliases = new Set(normalizeMessageIds(input.aliases));
    const fingerprint = contentFingerprint(input.fingerprint);
    const tokens = [...(this.#tokensByConversation.get(input.conversationId) ?? [])];

    const exact = tokens.find(token => {
      const record = this.#records.get(token);
      return record?.kind === input.kind
        && [...eventAliases].some(alias => record.aliases.has(alias));
    });
    const fallback = exact ?? tokens.find(token => {
      const record = this.#records.get(token);
      return record?.kind === input.kind
        && fingerprint !== undefined
        && record.fingerprint === fingerprint;
    });
    if (!fallback) return undefined;

    const telegramMessageId = this.#records.get(fallback)?.telegramMessageId;
    this.#delete(fallback);
    return telegramMessageId;
  }

  prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [token, record] of this.#records) {
      if (record.createdAt <= cutoff) this.#delete(token);
    }
  }

  get size(): number {
    return this.#records.size;
  }

  #delete(token: string): void {
    const record = this.#records.get(token);
    if (!record) return;
    this.#records.delete(token);

    const conversationTokens = this.#tokensByConversation.get(record.conversationId);
    if (conversationTokens) {
      const next = conversationTokens.filter(value => value !== token);
      if (next.length > 0) this.#tokensByConversation.set(record.conversationId, next);
      else this.#tokensByConversation.delete(record.conversationId);
    }

    if (record.telegramMessageId !== undefined) {
      const telegramTokens = this.#tokensByTelegramMessage.get(record.telegramMessageId);
      telegramTokens?.delete(token);
      if (telegramTokens?.size === 0) this.#tokensByTelegramMessage.delete(record.telegramMessageId);
    }
  }
}
