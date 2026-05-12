import type { TgHandlerContext } from '../types.js';
import { sentMsgStore } from '../../store/index.js';
import { config } from '../../config.js';
import { runZaloRequest } from '../../zalo/rate-limit.js';

type RecallPayload = { msgId: string | number; cliMsgId: string | number };

function buildRecallPayloads(sent: { msgId: string | number; cliMsgId?: string | number }): RecallPayload[] {
  const candidates: RecallPayload[] = [];
  const add = (payload: RecallPayload) => {
    const key = `${payload.msgId}:${payload.cliMsgId}`;
    if (!candidates.some(item => `${item.msgId}:${item.cliMsgId}` === key)) candidates.push(payload);
  };

  if (sent.cliMsgId !== undefined) {
    add({ msgId: sent.msgId, cliMsgId: sent.cliMsgId });
  }
  add({ msgId: sent.msgId, cliMsgId: sent.msgId });
  add({ msgId: sent.msgId, cliMsgId: 0 });

  return candidates;
}

export function registerRecallCommand({ bot, getApi }: TgHandlerContext): void {
  bot.command('recall', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const api = getApi();
    if (!api) { await ctx.reply('Zalo chưa kết nối'); return; }

    const replyTo = 'reply_to_message' in ctx.message
      ? (ctx.message as { reply_to_message?: { message_id: number } }).reply_to_message
      : undefined;

    if (!replyTo) {
      await ctx.reply('Cách dùng: reply vào đúng tin mình đã gửi từ Telegram sang Zalo, rồi gõ /recall. Không reply thì bot không biết cần thu hồi tin nào.');
      return;
    }

    const sent = sentMsgStore.get(replyTo.message_id);
    if (!sent) {
      await ctx.reply('Không tìm thấy mapping tin đã gửi. Chỉ thu hồi được khi reply vào tin mình đã gửi từ Telegram sang Zalo trong cache gần đây.');
      return;
    }

    const { ThreadType } = await import('zca-js');
    const zaloThreadType = sent.threadType === 1 ? ThreadType.Group : ThreadType.User;
    const payloads = buildRecallPayloads(sent);
    let lastError: unknown;

    for (const payload of payloads) {
      try {
        await runZaloRequest(
          { label: `undo(${sent.zaloId})`, priority: 'high' },
          () => api.undo(payload, sent.zaloId, zaloThreadType),
        );
        console.log(`[TG→Zalo] Recall msgId=${payload.msgId} cliMsgId=${payload.cliMsgId} zaloId=${sent.zaloId}`);
        await ctx.reply('Đã thu hồi tin nhắn trên Zalo.');
        return;
      } catch (err) {
        lastError = err;
        console.warn(`[TG→Zalo] Recall payload failed msgId=${payload.msgId} cliMsgId=${payload.cliMsgId}:`, err);
      }
    }

    await ctx.reply(`Thu hồi thất bại: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  });
}
