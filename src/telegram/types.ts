import type { Telegraf } from 'telegraf';
import type { ZaloAPI } from '../zalo/types.js';

export interface TgHandlerContext {
  bot: Telegraf;
  getApi: () => ZaloAPI | null;
  setApi: (api: ZaloAPI) => void;
  onZaloLogin: (api: ZaloAPI) => Promise<void>;
}
