import type { ZaloAPI } from './types.js';
import { aliasCache, friendsCache, store } from '../store/index.js';
import { runZaloRequest } from './rate-limit.js';
import { handleZaloMessage, registerZaloMessageHandler } from './message-handler.js';
import { registerZaloEventHandlers } from './event-handlers.js';
import type { DurableZaloRelay } from '../application/durable-zalo.js';
import { registerHistoryListener, setHistoryReplayHandler } from './history.js';
import { ensureGroupMemberCache } from './helpers.js';

const wiredApis = new WeakSet<object>();

export interface AddressBookLoadResult {
  aliases: number;
  friends: number;
}

/** Load aliases and friends independently so one provider endpoint cannot mask the other. */
export async function loadZaloAddressBook(api: ZaloAPI): Promise<AddressBookLoadResult> {
  aliasCache.setAll([]);
  friendsCache.clear();
  let aliases = 0;
  let friendsLoaded = 0;

  try {
    const result = await runZaloRequest(
      { label: 'getAliasList()', priority: 'low', maxRetries: 0 },
      () => api.getAliasList(),
    ) as { items?: Array<{ userId: string; alias: string }> };
    if (result?.items?.length) {
      aliasCache.setAll(result.items);
      aliases = result.items.length;
      console.log(`[Zalo] Loaded ${aliases} aliases from address book`);
    }
  } catch (error) {
    console.warn('[Zalo] Failed to load alias list:', error);
  }

  try {
    const friends = await runZaloRequest(
      { label: 'getAllFriends(address-book)', priority: 'low', maxRetries: 0 },
      () => api.getAllFriends(),
    ) as Array<{
      userId: string;
      displayName?: string;
      zaloName?: string;
      username?: string;
      alias?: string;
    }>;
    if (Array.isArray(friends)) {
      const normalized = friends
        .filter(friend => String(friend.userId ?? '').trim())
        .map(friend => ({
          userId: String(friend.userId),
          displayName: (
            friend.displayName
            || friend.zaloName
            || friend.username
            || friend.userId
          ).trim(),
          ...(friend.alias?.trim() ? { alias: friend.alias.trim() } : {}),
        }));
      friendsCache.set(normalized);
      friendsLoaded = normalized.length;
      aliasCache.merge(normalized.flatMap(friend => (
        friend.alias
          ? [{ userId: friend.userId, alias: friend.alias }]
          : []
      )));
    }
  } catch (error) {
    console.warn('[Zalo] Failed to load friend list:', error);
  }

  return { aliases, friends: friendsLoaded };
}

export async function setupZaloHandler(api: ZaloAPI, durableRelay?: DurableZaloRelay): Promise<void> {
  if (wiredApis.has(api as object)) return;
  wiredApis.add(api as object);
  registerHistoryListener(api);
  setHistoryReplayHandler(async message => {
    if (durableRelay) {
      durableRelay.enqueue(message);
      return;
    }
    await handleZaloMessage(api, message);
  });

  await loadZaloAddressBook(api);

  const startupGroups = store.all().filter(entry => entry.type === 1);
  void (async () => {
    for (let index = 0; index < startupGroups.length; index += 1) {
      const groupId = startupGroups[index]!.zaloId;
      if (index > 0) await new Promise(resolve => setTimeout(resolve, 2_000));
      await ensureGroupMemberCache(api, groupId);
    }
  })().catch(error => console.warn('[Zalo] Startup member-cache warmup failed:', error));

  registerZaloMessageHandler(api, durableRelay);
  registerZaloEventHandlers(api);
}
