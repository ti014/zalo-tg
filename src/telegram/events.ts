import type { TgHandlerContext } from './types.js';
import { registerCallbackHandler } from './callbacks.js';
import { registerReactionHandler } from './reactions.js';
import { registerMessageHandler } from './messages.js';
import { registerPollHandlers } from './polls.js';

export function registerAllEvents(ctx: TgHandlerContext): void {
  registerCallbackHandler(ctx);
  registerReactionHandler(ctx);
  registerMessageHandler(ctx);
  registerPollHandlers(ctx);
}
