import type { TgHandlerContext } from './types.js';
import {
  msgStore,
  sentMsgStore,
  reactionEchoStore,
  reactionEventDedupeStore,
} from '../store/index.js';
import { recallTelegramMappedMessage } from '../application/zalo-recall.js';
import {
  TELEGRAM_TO_ZALO_REACTION,
} from '../zalo/reaction.js';
import { runZaloRequest } from '../zalo/rate-limit.js';

const RECALL_TRIGGER_EMOJI = '🙈';

export function registerReactionHandler({ bot, getApi }: TgHandlerContext): void {
  bot.on('message_reaction', async (ctx) => {
    try {
      const currentApi = getApi();
      if (!currentApi || !ctx.messageReaction) return;
      const update = ctx.messageReaction;

      type EmojiReaction = { type: 'emoji'; emoji: string };
      const isEmoji = (reaction: { type: string }): reaction is EmojiReaction => (
        reaction.type === 'emoji'
      );
      const oldEmojis = new Set(
        update.old_reaction
          .filter(reaction => isEmoji(reaction as { type: string }))
          .map(reaction => (reaction as EmojiReaction).emoji),
      );
      const added = update.new_reaction
        .filter(reaction => (
          isEmoji(reaction as { type: string })
          && !oldEmojis.has((reaction as EmojiReaction).emoji)
        ))
        .map(reaction => (reaction as EmojiReaction).emoji);
      if (added.length === 0) return;

      const tgEmoji = added[0]!;
      const tgMessageId = update.message_id;
      const actorId = String(
        (update as unknown as { user?: { id?: number }; actor_chat?: { id?: number } }).user?.id
          ?? (update as unknown as { actor_chat?: { id?: number } }).actor_chat?.id
          ?? 'unknown',
      );
      const chatId = Number(
        (update as unknown as { chat?: { id?: number } }).chat?.id
          ?? ctx.chat?.id
          ?? 0,
      );

      if (reactionEventDedupeStore.isDuplicateTgOutbound({
        chatId,
        messageId: tgMessageId,
        actorId,
        emoji: tgEmoji,
      })) return;

      if (tgEmoji === RECALL_TRIGGER_EMOJI) {
        try {
          await recallTelegramMappedMessage(currentApi, tgMessageId);
          await ctx.telegram.deleteMessage(chatId, tgMessageId).catch(error => {
            console.warn('[TG→Zalo] Recall reaction deleted Zalo copy but not Telegram copy:', error);
          });
        } catch (error) {
          await ctx.telegram.sendMessage(
            chatId,
            'Không thu hồi được tin nhắn trên Zalo. Chỉ tin nhắn của bạn trong thời hạn Zalo cho phép mới thu hồi được.',
            {
              message_thread_id: (update as unknown as { message_thread_id?: number }).message_thread_id,
            },
          ).catch(() => undefined);
          console.warn('[TG→Zalo] Recall reaction failed:', error);
        }
        return;
      }

      const zaloIcon = TELEGRAM_TO_ZALO_REACTION[tgEmoji];
      if (!zaloIcon) return;

      const quote = msgStore.getQuote(tgMessageId);
      const sent = sentMsgStore.get(tgMessageId);
      const zaloId = quote?.zaloId ?? sent?.zaloId;
      const zaloMsgId = quote?.msgId ?? sent?.msgId;
      if (!zaloId || zaloMsgId === undefined) return;
      const cliMsgId = quote?.cliMsgId ?? sent?.cliMsgId;
      const threadType = quote?.threadType ?? sent?.threadType ?? 0;
      const zaloThreadType = threadType === 1
        ? (await import('zca-js')).ThreadType.Group
        : (await import('zca-js')).ThreadType.User;

      reactionEchoStore.mark(zaloId, String(zaloMsgId), zaloIcon);
      try {
        await runZaloRequest(
          { label: `addReaction(${zaloId})`, priority: 'high' },
          () => currentApi.addReaction(
            { rType: 0, source: 0, icon: zaloIcon },
            {
              data: { msgId: zaloMsgId, cliMsgId },
              threadId: zaloId,
              type: zaloThreadType,
            },
          ),
        );
      } catch (error) {
        reactionEchoStore.cancel(zaloId, String(zaloMsgId), zaloIcon);
        throw error;
      }
    } catch (error) {
      console.error('[TG→Zalo] Reaction error:', error);
    }
  });
}
