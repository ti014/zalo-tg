import type { TgHandlerContext } from '../types.js';
import { config } from '../../config.js';
import { recallTelegramMappedMessage } from '../../application/zalo-recall.js';

export function registerRecallCommand({ bot, getApi }: TgHandlerContext): void {
  bot.command('recall', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const api = getApi();
    if (!api) {
      await ctx.reply('Zalo chưa kết nối');
      return;
    }

    const replyTo = 'reply_to_message' in ctx.message
      ? (ctx.message as { reply_to_message?: { message_id: number } }).reply_to_message
      : undefined;
    if (!replyTo) {
      await ctx.reply('Cách dùng: reply vào tin nhắn cần thu hồi rồi gõ /recall.');
      return;
    }

    try {
      const target = await recallTelegramMappedMessage(api, replyTo.message_id);
      console.log(`[TG→Zalo] Recall msgId=${target.payloads[0]?.msgId} zaloId=${target.zaloId}`);
      await ctx.reply(
        target.recalledCount && target.recalledCount > 1
          ? `Đã thu hồi ${target.recalledCount} tin nhắn trên Zalo.`
          : 'Đã thu hồi tin nhắn trên Zalo.',
      );
    } catch (error) {
      await ctx.reply(`Thu hồi thất bại: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
