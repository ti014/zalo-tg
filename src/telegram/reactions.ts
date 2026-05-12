import type { TgHandlerContext } from './types.js';
import { msgStore, reactionEchoStore } from '../store/index.js';

export function registerReactionHandler({ bot, getApi }: TgHandlerContext): void {
  bot.on('message_reaction', async (ctx) => {
    try {
      const currentApi = getApi();
      if (!currentApi) return;
      const update = ctx.messageReaction;
      if (!update) return;

      type EmojiReaction = { type: 'emoji'; emoji: string };
      const isEmoji = (r: { type: string }): r is EmojiReaction => r.type === 'emoji';
      const oldEmojis = new Set(
        update.old_reaction
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter(r => isEmoji(r as any))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map(r => (r as any).emoji as string),
      );
      const added = update.new_reaction
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter(r => isEmoji(r as any) && !oldEmojis.has((r as any).emoji as string));

      if (added.length === 0) return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tgEmoji = (added[0] as any).emoji as string;

      const TG_TO_ZALO: Record<string, string> = {
        '❤':  '/-heart',
        '❤️': '/-heart',
        '👍':  '/-strong',
        '👎':  '/-weak',
        '😄':  ':>',
        '😁':  ':>',
        '😢':  ':-((',
        '😭':  ':((',
        '😮':  ':o',
        '😱':  ':o',
        '😡':  ':-h',
        '🤬':  ':-h',
        '😘':  ':-*',
        '🥰':  ';xx',
        '😍':  ';xx',
        '🤣':  ":'>",
        '😂':  ":'>",
        '💩':  '/-shit',
        '🌹':  '/-rose',
        '💔':  '/-break',
        '😕':  ';-/',
        '🤔':  ';-/',
        '😉':  ';-)',
        '👌':  '/-ok',
        '✌️':  '/-v',
        '✌':  '/-v',
        '🙏':  '_()_',
        '👊':  '/-punch',
        '🤯':  ':o',
        '🎉':  '/-bd',
        '🏆':  '/-ok',
        '💯':  '/-ok',
        '😎':  'x-)',
        '🤩':  'x-)',
        '🔥':  '/-heart',
      };

      const zaloIcon = TG_TO_ZALO[tgEmoji];
      if (!zaloIcon) {
        console.log(`[TG→Zalo] Reaction: no Zalo map for TG emoji "${tgEmoji}"`);
        return;
      }

      const tgMsgId = update.message_id;
      const quote   = msgStore.getQuote(tgMsgId);
      if (!quote) {
        console.log(`[TG→Zalo] Reaction: no Zalo quote for TG msg ${tgMsgId}`);
        return;
      }

      const { ThreadType } = await import('zca-js');
      const zaloThreadType = quote.threadType === 1 ? ThreadType.Group : ThreadType.User;

      reactionEchoStore.mark(quote.zaloId, quote.msgId, zaloIcon);
      try {
        await currentApi.addReaction(
          { rType: 0, source: 0, icon: zaloIcon },
          {
            data: { msgId: quote.msgId, cliMsgId: quote.cliMsgId },
            threadId: quote.zaloId,
            type: zaloThreadType,
          },
        );
      } catch (err) {
        reactionEchoStore.cancel(quote.zaloId, quote.msgId, zaloIcon);
        throw err;
      }
      console.log(`[TG→Zalo] Reaction "${tgEmoji}" → Zalo "${zaloIcon}" on msg ${quote.msgId}`);
    } catch (err) {
      console.error('[TG→Zalo] Reaction error:', err);
    }
  });
}
