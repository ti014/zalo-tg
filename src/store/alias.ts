const _aliasMap = new Map<string, string>();
const _normalizedAliasToUid = new Map<string, string>();

function normalizeName(name: string): string {
  return name.toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

export const aliasCache = {
  setAll(items: Array<{ userId: string; alias: string }>): void {
    _aliasMap.clear();
    _normalizedAliasToUid.clear();
    this.merge(items);
  },

  merge(items: Array<{ userId: string; alias?: string; displayName?: string }>): void {
    for (const { userId, alias, displayName } of items) {
      const name = (alias ?? displayName)?.trim();
      if (!userId?.trim() || !name) continue;
      const previous = _aliasMap.get(userId);
      if (previous && previous !== name) {
        const previousKey = normalizeName(previous);
        if (_normalizedAliasToUid.get(previousKey) === userId) {
          _normalizedAliasToUid.delete(previousKey);
        }
      }
      _aliasMap.set(userId, name);
      _normalizedAliasToUid.set(normalizeName(name), userId);
    }
  },

  resolveByAlias(rawName: string): string | undefined {
    return _normalizedAliasToUid.get(normalizeName(rawName));
  },

  get(userId: string): string | undefined {
    return _aliasMap.get(userId);
  },

  label(userId: string, realName: string): string {
    const alias = _aliasMap.get(userId);
    if (!alias || alias === realName) return realName;
    return `${alias} (${realName})`;
  },

  size(): number {
    return _aliasMap.size;
  },
};
