import { ThreadType } from 'zca-js';
import {
  msgStore,
  sentMessageIds,
  sentMsgStore,
  markRecentlyRecalled,
} from '../store/index.js';
import { runZaloRequest } from '../zalo/rate-limit.js';
import {
  buildRecallPayloadGroups,
  buildRecallPayloads,
  type RecallPayload,
} from '../domain/recall.js';
import type { ZaloAPI } from '../zalo/types.js';

export interface RecallTarget {
  zaloId: string;
  threadType: 0 | 1;
  payloads: RecallPayload[];
  payloadGroups: RecallPayload[][];
  aliases: Array<string | number | undefined>;
  recalledCount?: number;
}

export function resolveRecallTarget(tgMessageId: number): RecallTarget | undefined {
  const sent = sentMsgStore.get(tgMessageId);
  if (sent) {
    const msgIds = sentMessageIds(sent);
    const payloadGroups = buildRecallPayloadGroups({
      msgIds,
      cliMsgId: sent.cliMsgId,
    });
    return {
      zaloId: sent.zaloId,
      threadType: sent.threadType,
      payloads: payloadGroups.flat(),
      payloadGroups,
      aliases: [...msgIds, sent.cliMsgId],
    };
  }

  const quote = msgStore.getQuote(tgMessageId);
  if (!quote) return undefined;
  const payloads = buildRecallPayloads({ msgId: quote.msgId, cliMsgId: quote.cliMsgId });
  return {
    zaloId: quote.zaloId,
    threadType: quote.threadType,
    payloads,
    payloadGroups: [payloads],
    aliases: [quote.msgId, quote.cliMsgId],
  };
}

export async function recallTelegramMappedMessage(
  api: ZaloAPI,
  tgMessageId: number,
): Promise<RecallTarget> {
  const target = resolveRecallTarget(tgMessageId);
  if (!target) throw new Error('No Zalo mapping exists for this Telegram message.');

  const zaloThreadType = target.threadType === 1 ? ThreadType.Group : ThreadType.User;
  let recalledCount = 0;
  for (const payloadGroup of target.payloadGroups) {
    let lastError: unknown;
    let recalled = false;
    for (const payload of payloadGroup) {
      try {
        await runZaloRequest(
          { label: `undo(${target.zaloId})`, priority: 'high' },
          () => api.undo(payload, target.zaloId, zaloThreadType),
        );
        markRecentlyRecalled(payload.msgId, payload.cliMsgId);
        recalled = true;
        recalledCount += 1;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!recalled) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`Unable to recall Telegram message ${tgMessageId} on Zalo.`);
    }
  }
  markRecentlyRecalled(...target.aliases);
  return { ...target, recalledCount };
}
