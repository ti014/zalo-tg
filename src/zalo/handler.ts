import type { ZaloAPI } from './types.js';
import { store, aliasCache } from '../store/index.js';
import { populateGroupMemberCache, memberCacheLoaded } from './helpers.js';
import { registerZaloMessageHandler } from './message-handler.js';
import { registerZaloEventHandlers } from './event-handlers.js';

export async function setupZaloHandler(api: ZaloAPI): Promise<void> {
  void (async () => {
    for (const entry of store.all()) {
      if (entry.type !== 1) continue;
      const ok = await populateGroupMemberCache(api, entry.zaloId);
      if (ok) memberCacheLoaded.add(entry.zaloId);
      await new Promise(r => setTimeout(r, 800));
    }
  })();

  try {
    const result = await api.getAliasList() as { items?: Array<{ userId: string; alias: string }> };
    if (result?.items?.length) {
      aliasCache.setAll(result.items);
      console.log(`[Zalo] Loaded ${result.items.length} aliases from address book`);
    }
  } catch (err) {
    console.warn('[Zalo] Failed to load alias list:', err);
  }

  registerZaloMessageHandler(api);
  registerZaloEventHandlers(api);
}
