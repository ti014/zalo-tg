/**
 * Zalo occasionally emits placeholder IDs such as "0". Those values must
 * never become durable aliases because many unrelated messages would then
 * share the same key.
 */
export function normalizeMessageId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;

  const normalized = String(value).trim();
  if (!normalized || normalized === '0') return undefined;
  return normalized;
}

export function normalizeMessageIds(values: readonly unknown[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const normalized = normalizeMessageId(value);
    if (normalized) unique.add(normalized);
  }
  return [...unique];
}
