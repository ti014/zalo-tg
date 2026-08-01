import type { ZaloAPI } from '../zalo/types.js';
import { Context } from 'telegraf';
import type { Message, Update } from 'telegraf/types';
import { tgBot } from './bot.js';
import { registerAllCommands } from './commands/index.js';
import { registerAllEvents } from './events.js';
import type { MappingClearPreparation, TgHandlerContext } from './types.js';
import { registerOwnerAuthorization } from './authorization.js';
import { config } from '../config.js';
import {
  DurableTelegramRelay,
  type TelegramDeliveryTarget,
} from '../application/durable-telegram.js';
import type { DeliveryRepository } from '../infrastructure/database/delivery-repository.js';
import { store } from '../store/index.js';
import {
  processTelegramMessage,
  type TelegramMessageContext,
} from './messages.js';

export interface TelegramHandlerHandle {
  setApi(api: ZaloAPI): void;
  clearApi(api?: ZaloAPI): void;
  stop(): Promise<void>;
}

export interface TelegramHandlerOptions {
  deliveryRepository?: DeliveryRepository;
  onFatal?: (error: Error) => void;
  prepareMappingClear?: () => MappingClearPreparation;
  requestRestart?: () => boolean;
}

export function setupTelegramHandler(
  initialApi: ZaloAPI | null,
  onZaloLogin: (api: ZaloAPI) => Promise<void>,
  options: TelegramHandlerOptions = {},
): TelegramHandlerHandle {
  let currentApi: ZaloAPI | null = initialApi;
  let durableRelay: DurableTelegramRelay | undefined;

  const setCurrentApi = (api: ZaloAPI) => {
    currentApi = api;
    durableRelay?.wake();
  };
  const clearCurrentApi = (api?: ZaloAPI) => {
    if (api === undefined || currentApi === api) currentApi = null;
  };
  const getApi = () => currentApi;
  const guardApiSession = (expectedApi: ZaloAPI): ZaloAPI => new Proxy(expectedApi as object, {
    get(target, property) {
      const requireCurrentApi = () => {
        if (currentApi !== expectedApi) {
          throw Object.assign(
            new Error('Zalo API session changed while a durable delivery was in progress.'),
            { code: 'ZALO_API_STALE' },
          );
        }
      };
      requireCurrentApi();
      const value = Reflect.get(target, property, expectedApi);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        requireCurrentApi();
        return Reflect.apply(value, expectedApi, args);
      };
    },
  }) as ZaloAPI;

  const ctx: TgHandlerContext = {
    bot: tgBot,
    getApi,
    setApi: setCurrentApi,
    onZaloLogin,
    deliveryRepository: options.deliveryRepository,
    prepareMappingClear: options.prepareMappingClear,
    requestRestart: options.requestRestart,
  };

  registerOwnerAuthorization(tgBot);
  if (options.deliveryRepository) {
    durableRelay = new DurableTelegramRelay({
      repository: options.deliveryRepository,
      bot: tgBot,
      telegramChatId: config.telegram.groupId,
      getApi,
      getTopic: topicId => store.getEntryByTopic(topicId),
      onFatal: options.onFatal ?? (error => console.error('[Telegram delivery] Fatal:', error)),
      replayUpdate: async (update, target: TelegramDeliveryTarget) => {
        if (!tgBot.botInfo) throw new Error('Telegram bot identity is not initialized.');
        const topicId = store.getTopicByZalo(target.zaloId, target.type);
        const entry = topicId === undefined ? undefined : store.getEntryByTopic(topicId);
        if (!entry || entry.zaloId !== target.zaloId || entry.type !== target.type) {
          throw Object.assign(
            new Error(`No current Telegram topic maps to ${target.type}:${target.zaloId}.`),
            { code: 'TOPIC_MAPPING_MISSING' },
          );
        }
        if (!update || typeof update !== 'object' || !('message' in update)) {
          throw Object.assign(new Error('Stored Telegram update is invalid.'), {
            code: 'INVALID_PAYLOAD',
          });
        }
        const storedUpdate = update as Update.MessageUpdate<Message>;
        const replayedUpdate = {
          ...storedUpdate,
          message: {
            ...storedUpdate.message,
            message_thread_id: topicId,
          },
        } as Update.MessageUpdate<Message>;
        const replayContext = new Context(
          replayedUpdate,
          tgBot.telegram,
          tgBot.botInfo,
        ) as TelegramMessageContext;
        const apiAtReplay = getApi();
        await processTelegramMessage(
          replayContext,
          () => apiAtReplay === null ? null : guardApiSession(apiAtReplay),
        );
      },
    });
    tgBot.use(durableRelay.middleware());
  }
  registerAllCommands(ctx);
  registerAllEvents(ctx);
  durableRelay?.start();

  return {
    setApi: setCurrentApi,
    clearApi: clearCurrentApi,
    async stop(): Promise<void> {
      await durableRelay?.stop();
    },
  };
}
