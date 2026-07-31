import { normalizeMessageId, normalizeMessageIds } from './message-id.js';

export interface MessageLinkSnapshot<TQuote> {
  pairs: Array<[string, number]>;
  quotes: Array<[number, TQuote]>;
}

/** A bounded alias index. Quote data lives until its final alias is evicted. */
export class MessageLinkCache<TQuote> {
  readonly #aliasToTelegram = new Map<string, number>();
  readonly #telegramToQuote = new Map<number, TQuote>();
  readonly #aliasOrder: string[] = [];
  readonly #aliasCountByTelegram = new Map<number, number>();

  constructor(readonly maxAliases: number) {
    if (!Number.isInteger(maxAliases) || maxAliases < 1) {
      throw new Error('maxAliases must be a positive integer');
    }
  }

  load(snapshot: Partial<MessageLinkSnapshot<TQuote>>): { normalized: boolean } {
    this.clear();
    const finalAliases = new Map<string, number>();
    const order: string[] = [];
    let normalized = false;

    for (const pair of snapshot.pairs ?? []) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        normalized = true;
        continue;
      }
      const alias = normalizeMessageId(pair[0]);
      const telegramId = pair[1];
      if (!alias || !Number.isSafeInteger(telegramId)) {
        normalized = true;
        continue;
      }
      if (finalAliases.has(alias)) {
        normalized = true;
        const previousIndex = order.indexOf(alias);
        if (previousIndex >= 0) order.splice(previousIndex, 1);
      }
      finalAliases.set(alias, telegramId);
      order.push(alias);
    }

    while (order.length > this.maxAliases) {
      const alias = order.shift();
      if (alias) finalAliases.delete(alias);
      normalized = true;
    }

    for (const alias of order) {
      const telegramId = finalAliases.get(alias);
      if (telegramId === undefined) continue;
      this.#aliasToTelegram.set(alias, telegramId);
      this.#aliasOrder.push(alias);
      this.#aliasCountByTelegram.set(
        telegramId,
        (this.#aliasCountByTelegram.get(telegramId) ?? 0) + 1,
      );
    }

    const quotes = new Map<number, TQuote>();
    for (const pair of snapshot.quotes ?? []) {
      if (!Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[0])) {
        normalized = true;
        continue;
      }
      if (quotes.has(pair[0])) normalized = true;
      quotes.set(pair[0], pair[1]);
    }
    for (const telegramId of this.#aliasCountByTelegram.keys()) {
      const quote = quotes.get(telegramId);
      if (quote !== undefined) this.#telegramToQuote.set(telegramId, quote);
    }
    if (quotes.size !== this.#telegramToQuote.size) normalized = true;
    return { normalized };
  }

  save(telegramId: number, aliases: readonly unknown[], quote: TQuote): boolean {
    if (!Number.isSafeInteger(telegramId)) return false;
    const validAliases = normalizeMessageIds(aliases);
    if (validAliases.length === 0) return false;

    this.#telegramToQuote.set(telegramId, quote);
    for (const alias of validAliases) this.#upsertAlias(alias, telegramId);
    this.#prune();
    return true;
  }

  getTelegramId(alias: unknown): number | undefined {
    const normalized = normalizeMessageId(alias);
    return normalized ? this.#aliasToTelegram.get(normalized) : undefined;
  }

  getQuote(telegramId: number): TQuote | undefined {
    return this.#telegramToQuote.get(telegramId);
  }

  snapshot(): MessageLinkSnapshot<TQuote> {
    return {
      pairs: this.#aliasOrder.flatMap(alias => {
        const telegramId = this.#aliasToTelegram.get(alias);
        return telegramId === undefined ? [] : [[alias, telegramId] as [string, number]];
      }),
      quotes: [...this.#telegramToQuote.entries()],
    };
  }

  get aliasCount(): number {
    return this.#aliasToTelegram.size;
  }

  clear(): void {
    this.#aliasToTelegram.clear();
    this.#telegramToQuote.clear();
    this.#aliasOrder.splice(0);
    this.#aliasCountByTelegram.clear();
  }

  #upsertAlias(alias: string, telegramId: number): void {
    const previousTelegramId = this.#aliasToTelegram.get(alias);
    if (previousTelegramId !== undefined) {
      const previousIndex = this.#aliasOrder.indexOf(alias);
      if (previousIndex >= 0) this.#aliasOrder.splice(previousIndex, 1);
      if (previousTelegramId !== telegramId) this.#decrementAliasCount(previousTelegramId);
    }

    this.#aliasToTelegram.set(alias, telegramId);
    this.#aliasOrder.push(alias);
    if (previousTelegramId !== telegramId) {
      this.#aliasCountByTelegram.set(
        telegramId,
        (this.#aliasCountByTelegram.get(telegramId) ?? 0) + 1,
      );
    }
  }

  #prune(): void {
    while (this.#aliasOrder.length > this.maxAliases) {
      const alias = this.#aliasOrder.shift();
      if (!alias) break;
      const telegramId = this.#aliasToTelegram.get(alias);
      if (telegramId === undefined) continue;
      this.#aliasToTelegram.delete(alias);
      this.#decrementAliasCount(telegramId);
    }
  }

  #decrementAliasCount(telegramId: number): void {
    const nextCount = (this.#aliasCountByTelegram.get(telegramId) ?? 1) - 1;
    if (nextCount > 0) {
      this.#aliasCountByTelegram.set(telegramId, nextCount);
      return;
    }
    this.#aliasCountByTelegram.delete(telegramId);
    this.#telegramToQuote.delete(telegramId);
  }
}
