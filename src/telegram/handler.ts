import type { ZaloAPI } from '../zalo/types.js';
import { tgBot } from './bot.js';
import { registerAllCommands } from './commands/index.js';
import { registerAllEvents } from './events.js';
import type { TgHandlerContext } from './types.js';

export function setupTelegramHandler(
  initialApi: ZaloAPI | null,
  onZaloLogin: (api: ZaloAPI) => Promise<void>,
): (api: ZaloAPI) => void {
  let currentApi: ZaloAPI | null = initialApi;

  const setCurrentApi = (api: ZaloAPI) => { currentApi = api; };
  const getApi = () => currentApi;

  const ctx: TgHandlerContext = {
    bot: tgBot,
    getApi,
    setApi: setCurrentApi,
    onZaloLogin,
  };

  registerAllCommands(ctx);
  registerAllEvents(ctx);

  return setCurrentApi;
}
