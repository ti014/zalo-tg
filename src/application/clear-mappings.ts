import { msgStore, store } from '../store/index.js';
import { shadowMappingsClear } from '../infrastructure/database/shadow-state.js';

const EMPTY_MESSAGE_MAP = JSON.stringify({ pairs: [], quotes: [], sent: [] });

export interface ClearBridgeMappingsResult {
  topics: number;
}

export function clearBridgeMappings(): ClearBridgeMappingsResult {
  const topics = store.all().length;
  // Clear both SQLite tables first in one transaction. Compatibility JSON is
  // then replaced without synchronizing it back into the authoritative DB.
  shadowMappingsClear();
  msgStore.replaceFromJson(EMPTY_MESSAGE_MAP, { synchronizeShadow: false });
  store.replaceAll([], { synchronizeShadow: false });
  return { topics };
}
