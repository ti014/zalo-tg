const _aliasMap = new Map<string, string>();

export const aliasCache = {
  setAll(items: Array<{ userId: string; alias: string }>): void {
    _aliasMap.clear();
    for (const { userId, alias } of items) {
      if (alias?.trim()) _aliasMap.set(userId, alias.trim());
    }
  },

  get(userId: string): string | undefined {
    return _aliasMap.get(userId);
  },

  label(userId: string, realName: string): string {
    const alias = _aliasMap.get(userId);
    if (!alias || alias === realName) return realName;
    return `${alias} (${realName})`;
  },
};
