import type { TgHandlerContext } from '../types.js';
import type { DeliveryRepository } from '../../infrastructure/database/delivery-repository.js';
import {
  aliasCache,
  friendsCache,
  groupsCache,
  msgStore,
  reactionEventDedupeStore,
  reactionSummaryStore,
  sentMessageIds,
  sentMsgStore,
  store,
  userCache,
} from '../../store/index.js';
import { config } from '../../config.js';
import { escapeHtml } from '../../utils/format.js';

export const adminMenuMarkup = {
  inline_keyboard: [
    [{ text: 'Trạng thái', callback_data: 'admin:status' }],
    [{ text: 'Cache và durable queue', callback_data: 'admin:cache' }],
    [{ text: 'Tra mapping', callback_data: 'admin:lookup' }],
    [{ text: 'Đóng', callback_data: 'admin:close' }],
  ],
};

export const adminBackMarkup = {
  inline_keyboard: [[{ text: 'Quay lại', callback_data: 'admin:menu' }]],
};

export interface AdminCacheSnapshot {
  topics: ReturnType<typeof store.stats>;
  incoming: ReturnType<typeof msgStore.stats>;
  sent: ReturnType<typeof sentMsgStore.stats>;
  users: ReturnType<typeof userCache.stats>;
  aliases: number;
  friends: number;
  groups: number;
  reactionSummaries: number;
  reactionDedupe: number;
  deliveries: Array<{ status: string; count: number }>;
}

export function buildAdminCacheSnapshot(
  deliveryRepository?: DeliveryRepository,
): AdminCacheSnapshot {
  return {
    topics: store.stats(),
    incoming: msgStore.stats(),
    sent: sentMsgStore.stats(),
    users: userCache.stats(),
    aliases: aliasCache.size(),
    friends: friendsCache.stats().count,
    groups: groupsCache.stats().count,
    reactionSummaries: reactionSummaryStore.stats().entries,
    reactionDedupe: reactionEventDedupeStore.stats().entries,
    deliveries: deliveryRepository?.statusCounts() ?? [],
  };
}

export function renderAdminCache(snapshot: AdminCacheSnapshot): string {
  const deliveryText = snapshot.deliveries.length > 0
    ? snapshot.deliveries.map(item => `${escapeHtml(item.status)}=${item.count}`).join(', ')
    : 'không có repository';
  return '<b>Cache và durable queue</b>\n\n'
    + `Topic: <b>${snapshot.topics.topics}</b> `
    + `(${snapshot.topics.groups} group, ${snapshot.topics.directMessages} DM)\n`
    + `Incoming mapping: <b>${snapshot.incoming.aliases}</b> alias / `
    + `${snapshot.incoming.quotes} quote\n`
    + `Sent mapping: <b>${snapshot.sent.entries}</b> entry / ${snapshot.sent.aliases} alias\n`
    + `User cache: <b>${snapshot.users.users}</b> user / ${snapshot.users.groups} group\n`
    + `Contact alias: <b>${snapshot.aliases}</b>\n`
    + `Friends/groups cache: <b>${snapshot.friends}</b> / <b>${snapshot.groups}</b>\n`
    + `Reaction summary/dedupe: <b>${snapshot.reactionSummaries}</b> / `
    + `<b>${snapshot.reactionDedupe}</b>\n`
    + `Delivery: <code>${deliveryText}</code>`;
}

export function renderAdminMapping(telegramMessageId: number): string {
  const sent = sentMsgStore.get(telegramMessageId);
  const quote = msgStore.getQuote(telegramMessageId);
  const lines = [`<b>Mapping Telegram ${telegramMessageId}</b>`];

  if (sent) {
    const providerIds = sentMessageIds(sent);
    lines.push(
      '',
      '<b>Telegram → Zalo</b>',
      `msgId: <code>${escapeHtml(String(sent.msgId))}</code>`,
      `msgIds: ${providerIds.map(id => `<code>${escapeHtml(id)}</code>`).join(', ') || '<i>-</i>'}`,
      `cliMsgId: <code>${escapeHtml(String(sent.cliMsgId ?? '-'))}</code>`,
      `conversation: <code>${sent.threadType}:${escapeHtml(sent.zaloId)}</code>`,
    );
  } else {
    lines.push('', 'Telegram → Zalo: <i>không tìm thấy</i>');
  }

  if (quote) {
    lines.push(
      '',
      '<b>Zalo → Telegram</b>',
      `msgId: <code>${escapeHtml(quote.msgId)}</code>`,
      `cliMsgId: <code>${escapeHtml(quote.cliMsgId || '-')}</code>`,
      `sender: <code>${escapeHtml(quote.uidFrom)}</code>`,
      `conversation: <code>${quote.threadType}:${escapeHtml(quote.zaloId)}</code>`,
    );
  } else {
    lines.push('', 'Zalo → Telegram: <i>không tìm thấy</i>');
  }
  return lines.join('\n');
}

export function renderAdminLookupHelp(): string {
  return '<b>Tra mapping</b>\n\nReply vào tin nhắn cần tra rồi dùng '
    + '<code>/admin lookup</code>.';
}

export function registerAdminCommand({ bot }: TgHandlerContext): void {
  bot.command('admin', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const text = 'text' in ctx.message ? ctx.message.text ?? '' : '';
    const lookup = /^\/admin(?:@[A-Za-z0-9_]+)?\s+lookup(?:\s|$)/i.test(text);
    if (lookup) {
      const repliedMessage = 'reply_to_message' in ctx.message
        ? (ctx.message as { reply_to_message?: { message_id: number } }).reply_to_message
        : undefined;
      await ctx.reply(
        repliedMessage
          ? renderAdminMapping(repliedMessage.message_id)
          : renderAdminLookupHelp(),
        { parse_mode: 'HTML', reply_markup: adminBackMarkup },
      );
      return;
    }

    await ctx.reply('<b>Admin panel</b>\nChọn mục cần kiểm tra:', {
      parse_mode: 'HTML',
      reply_markup: adminMenuMarkup,
    });
  });
}
