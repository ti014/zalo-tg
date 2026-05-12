import type { ZaloAPI } from './types.js';
import { aliasCache } from '../store/index.js';
import { registerZaloMessageHandler } from './message-handler.js';
import { registerZaloEventHandlers } from './event-handlers.js';

export async function setupZaloHandler(api: ZaloAPI): Promise<void> {
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
