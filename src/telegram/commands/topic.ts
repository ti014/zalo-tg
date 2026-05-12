import type { TgHandlerContext } from '../types.js';
import { settingsStore, store } from '../../store/index.js';
import { config } from '../../config.js';
import { escapeHtml } from '../../utils/format.js';
import { topicKeyboard } from '../ui/keyboards.js';
import { renderTopicCard } from '../ui/renderers.js';

export function registerTopicCommand({ bot }: TgHandlerContext): void {
  bot.command('topic', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const topicId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const arg = (ctx.message.text ?? '').split(/\s+/)[1]?.toLowerCase() ?? '';
    const replyOpts = topicId ? { message_thread_id: topicId } : {};

    if (arg === 'list' || !arg) {
      const all = store.all();
      if (all.length === 0) {
        await ctx.telegram.sendMessage(config.telegram.groupId, '📭 Chưa có topic nào.', replyOpts);
        return;
      }
      const lines = all.map(e =>
        `• <b>${escapeHtml(e.name)}</b> — topicId=${e.topicId}, zaloId=${e.zaloId}, type=${e.type === 1 ? 'group' : 'dm'}`,
      );
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `📋 <b>Bridge topics</b> (${all.length}):\n${lines.join('\n')}`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    if (!topicId) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '⚠️ Lệnh này phải được gửi trong một topic cụ thể.',
        replyOpts,
      );
      return;
    }

    if (arg === 'info') {
      const entry = store.getEntryByTopic(topicId);
      if (!entry) {
        await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Topic này chưa được map.', replyOpts);
        return;
      }
      const topicActionsEnabled = settingsStore.get().telegramUi.topicActions;
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        topicActionsEnabled ? renderTopicCard(entry) : `ℹ️ <b>${escapeHtml(entry.name)}</b>\nzaloId: <code>${entry.zaloId}</code>\ntype: ${entry.type === 1 ? 'group' : 'dm'}`,
        {
          ...replyOpts,
          parse_mode: 'HTML',
          ...(topicActionsEnabled ? { reply_markup: topicKeyboard(entry) } : {}),
        },
      );
      return;
    }

    if (arg === 'delete') {
      const removed = store.remove(topicId);
      if (!removed) {
        await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Topic này chưa được map.', replyOpts);
        return;
      }
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `🗑️ Đã xoá mapping: <b>${escapeHtml(removed.name)}</b> (zaloId=${removed.zaloId})`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      '❓ Dùng: <code>/topic list</code> | <code>/topic info</code> | <code>/topic delete</code>',
      { ...replyOpts, parse_mode: 'HTML' },
    );
  });
}
