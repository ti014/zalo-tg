import type { Telegraf } from 'telegraf';
import type { ZaloAPI } from '../zalo/types.js';
import type { DeliveryRepository } from '../infrastructure/database/delivery-repository.js';

export type MappingClearBlockReason =
  | 'active_deliveries'
  | 'already_scheduled'
  | 'shutting_down';

export interface MappingClearPreparation {
  accepted: boolean;
  activeDeliveries: number;
  reason?: MappingClearBlockReason;
  start?: () => void;
  cancel?: () => void;
}

export interface TgHandlerContext {
  bot: Telegraf;
  getApi: () => ZaloAPI | null;
  setApi: (api: ZaloAPI) => void;
  onZaloLogin: (api: ZaloAPI) => Promise<void>;
  deliveryRepository?: DeliveryRepository;
  prepareMappingClear?: () => MappingClearPreparation;
}
