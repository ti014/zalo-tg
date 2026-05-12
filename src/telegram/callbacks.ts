import type { TgHandlerContext } from './types.js';
import { settingsStore, store, friendsCache, groupsCache, pollStore } from '../store/index.js';
import { config } from '../config.js';
import { escapeHtml } from '../utils/format.js';
import { buildTopicUrl } from './helpers.js';
import type { ZaloAPI } from '../zalo/types.js';
import { tgBot } from './bot.js';
import { confirmDeleteTopicKeyboard, helpKeyboard, topicKeyboard } from './ui/keyboards.js';
import { renderDeleteTopicConfirm, renderHelp, renderTopicCard } from './ui/renderers.js';
import { buildMenuView, buildSettingsView, buildStatusView, type UiView } from './ui/status.js';
import { runZaloRequest } from '../zalo/rate-limit.js';

async function doLockPoll(entry: import('../store/index.js').PollEntry, api: ZaloAPI): Promise<void> {
  await runZaloRequest(
    { label: `lockPoll(${entry.pollId})`, priority: 'high' },
    () => api.lockPoll(entry.pollId),
  );
  console.log(`[TG→Zalo] Locked Zalo poll ${entry.pollId}`);
  try {
    await tgBot.telegram.stopPoll(config.telegram.groupId, entry.tgPollMsgId);
  } catch { /* already stopped or no permission */ }
  if (entry.tgOrigPollMsgId) {
    try {
      await tgBot.telegram.stopPoll(config.telegram.groupId, entry.tgOrigPollMsgId);
    } catch { /* no admin rights or already stopped */ }
  }
  try {
    const detail = await runZaloRequest(
      { label: `getPollDetail(${entry.pollId})`, priority: 'low', maxRetries: 0 },
      () => api.getPollDetail(entry.pollId),
    ) as { options?: Array<{ content: string; votes: number }>; closed?: boolean } | undefined;
    if (detail?.options) {
      const total = detail.options.reduce((s: number, o: { votes: number }) => s + (o.votes ?? 0), 0);
      const lines = (detail.options as Array<{ content: string; votes: number }>).map(o => {
        const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
        const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
        return `${o.content}\n  ${bar} ${o.votes} phiếu (${pct}%)`;
      });
      const scoreText = `📊 <b>Kết quả bình chọn <i>[Đã đóng]</i></b>\n\nTổng: ${total} phiếu\n\n${lines.join('\n\n')}`;
      try {
        await tgBot.telegram.editMessageText(
          config.telegram.groupId,
          entry.tgScoreMsgId,
          undefined,
          scoreText,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } },
        );
      } catch { /* too old to edit */ }
    }
  } catch { /* non-fatal */ }
}

export { doLockPoll };

interface UiMessageContext {
  editMessageText(
    text: string,
    extra: { parse_mode: 'HTML'; reply_markup: UiView['replyMarkup'] },
  ): Promise<unknown>;
  reply(
    text: string,
    extra: { parse_mode: 'HTML'; reply_markup: UiView['replyMarkup'] },
  ): Promise<unknown>;
}

async function editUiMessage(ctx: UiMessageContext, view: UiView): Promise<void> {
  await ctx.editMessageText(view.text, {
    parse_mode: 'HTML',
    reply_markup: view.replyMarkup,
  }).catch(async () => {
    await ctx.reply(view.text, {
      parse_mode: 'HTML',
      reply_markup: view.replyMarkup,
    });
  });
}

export function registerCallbackHandler({ bot, getApi }: TgHandlerContext): void {
  bot.on('callback_query', async (ctx) => {
    const data = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    const currentApi = getApi();

    if (data?.startsWith('ui:')) {
      try {
        if (data === 'ui:h') {
          await editUiMessage(ctx, buildMenuView(getApi));
          await ctx.answerCbQuery('Menu');
          return;
        }
        if (data === 'ui:s' || data === 'ui:sr') {
          await editUiMessage(ctx, await buildStatusView(getApi, { forceRefresh: data === 'ui:sr' }));
          await ctx.answerCbQuery(data === 'ui:sr' ? 'Đã làm mới' : 'Trạng thái');
          return;
        }
        if (data === 'ui:set') {
          await editUiMessage(ctx, buildSettingsView());
          await ctx.answerCbQuery('Cài đặt');
          return;
        }
        if (data === 'ui:help') {
          await editUiMessage(ctx, { text: renderHelp(), replyMarkup: helpKeyboard() });
          await ctx.answerCbQuery('Hướng dẫn');
          return;
        }
        if (data === 'ui:topics') {
          const topics = store.all();
          const lines = topics.slice(0, 20).map(entry =>
            `• <b>${escapeHtml(entry.name)}</b> — ${entry.type === 1 ? 'nhóm' : 'chat riêng'} — <code>${entry.topicId}</code>`,
          );
          const text = lines.length
            ? `<b>Topic</b> (${topics.length})\n\n${lines.join('\n')}`
            : '<b>Topic</b>\n\nChưa có topic nào.';
          await editUiMessage(ctx, { text, replyMarkup: { inline_keyboard: [[{ text: 'Menu', callback_data: 'ui:h' }]] } });
          await ctx.answerCbQuery('Topic');
          return;
        }
        if (data === 'ui:requests') {
          await ctx.answerCbQuery('Dùng /friendrequests để tải lời mời');
          await ctx.reply('Dùng <code>/friendrequests</code> để tải lời mời Zalo.', { parse_mode: 'HTML' });
          return;
        }
        if (data === 'ui:search') {
          await ctx.answerCbQuery('Dùng /search <từ khóa>');
          await ctx.reply('Dùng <code>/search &lt;tên hoặc số điện thoại&gt;</code>. Ví dụ: <code>/search An</code>', { parse_mode: 'HTML' });
          return;
        }
        if (data.startsWith('ui:st:')) {
          const key = data.slice('ui:st:'.length);
          if (key === 'c') settingsStore.toggleTelegramUi('compactMode');
          else if (key === 'd') settingsStore.toggleTelegramUi('statusDetails');
          else if (key === 't') settingsStore.toggleTelegramUi('topicActions');
          else { await ctx.answerCbQuery('Cài đặt không hợp lệ'); return; }
          await editUiMessage(ctx, buildSettingsView());
          await ctx.answerCbQuery('Đã lưu');
          return;
        }
        if (data.startsWith('ui:t:')) {
          const topicId = Number(data.slice('ui:t:'.length));
          const entry = store.getEntryByTopic(topicId);
          if (!entry) { await ctx.answerCbQuery('Không tìm thấy topic'); return; }
          await editUiMessage(ctx, { text: renderTopicCard(entry), replyMarkup: topicKeyboard(entry) });
          await ctx.answerCbQuery('Topic');
          return;
        }
        if (data.startsWith('ui:tc:')) {
          const topicId = Number(data.slice('ui:tc:'.length));
          const entry = store.getEntryByTopic(topicId);
          if (!entry) { await ctx.answerCbQuery('Không tìm thấy topic'); return; }
          await editUiMessage(ctx, { text: renderDeleteTopicConfirm(entry), replyMarkup: confirmDeleteTopicKeyboard(topicId) });
          await ctx.answerCbQuery('Xác nhận');
          return;
        }
        if (data.startsWith('ui:td:')) {
          const topicId = Number(data.slice('ui:td:'.length));
          const removed = store.remove(topicId);
          if (!removed) { await ctx.answerCbQuery('Không tìm thấy topic'); return; }
          await editUiMessage(ctx, {
            text: `Đã xóa ánh xạ: <b>${escapeHtml(removed.name)}</b>`,
            replyMarkup: { inline_keyboard: [[{ text: 'Menu', callback_data: 'ui:h' }]] },
          });
          await ctx.answerCbQuery('Đã xóa');
          return;
        }
      } catch (err) {
        console.error('[cb/ui]', err);
        await ctx.answerCbQuery('Lỗi giao diện').catch(() => undefined);
        return;
      }
    }

    if (data?.startsWith('lock_poll:')) {
      const pollId = Number(data.slice('lock_poll:'.length));
      const entry = pollStore.getByPollId(pollId);
      if (!entry || !currentApi) {
        await ctx.answerCbQuery('❌ Không tìm thấy bình chọn.');
        return;
      }
      try {
        await doLockPoll(entry, currentApi);
        await ctx.answerCbQuery('✅ Đã khoá bình chọn');
      } catch (err) {
        console.error('[TG→Zalo] lock_poll callback error:', err);
        try { await ctx.answerCbQuery('❌ Lỗi khoá bình chọn'); } catch { /* ignore */ }
      }
      return;
    }

    if (data?.startsWith('lg:')) {
      if (data === 'lg:cancel') {
        await ctx.answerCbQuery('❌ Đã huỷ');
        await ctx.editMessageReplyMarkup(undefined);
        return;
      }
      const topicId = Number(data.slice(3));
      const entry = store.getEntryByTopic(topicId);
      if (!entry || !currentApi) {
        await ctx.answerCbQuery('❌ Không tìm thấy topic');
        return;
      }
      try {
        await runZaloRequest(
          { label: `leaveGroup(${entry.zaloId})`, priority: 'high' },
          () => currentApi.leaveGroup(entry.zaloId),
        );
        store.remove(topicId);
        groupsCache.set([]);
        await ctx.answerCbQuery('✅ Đã rời nhóm');
        await ctx.editMessageReplyMarkup(undefined);
        await ctx.telegram.closeForumTopic(config.telegram.groupId, topicId)
          .catch(() => undefined);
        await ctx.telegram.sendMessage(
          config.telegram.groupId,
          `🚪 Đã rời nhóm <b>${escapeHtml(entry.name)}</b> và đóng topic.`,
          { message_thread_id: topicId, parse_mode: 'HTML' },
        ).catch(() => undefined);
      } catch (err) {
        console.error('[cb/lg]', err);
        await ctx.answerCbQuery('❌ Rời nhóm thất bại');
      }
      return;
    }

    if (data?.startsWith('fr:')) {
      const [, action, fromUid] = data.split(':');
      if (!fromUid || !currentApi) {
        await ctx.answerCbQuery('Zalo chưa kết nối');
        return;
      }
      if (action !== 'accept' && action !== 'reject') {
        await ctx.answerCbQuery('Dữ liệu không hợp lệ');
        return;
      }

      try {
        if (action === 'accept') {
          await runZaloRequest(
            { label: `acceptFriendRequest(${fromUid})`, priority: 'high' },
            () => currentApi.acceptFriendRequest(fromUid),
          );
          await ctx.answerCbQuery('Đã chấp nhận kết bạn');
          await ctx.editMessageReplyMarkup(undefined);
          const previousText = ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text ?? ''
            : '';
          await ctx.editMessageText(`${previousText}\n\nĐã chấp nhận`, { parse_mode: 'HTML' }).catch(() => undefined);
        } else {
          await runZaloRequest(
            { label: `rejectFriendRequest(${fromUid})`, priority: 'high' },
            () => currentApi.rejectFriendRequest(fromUid),
          );
          await ctx.answerCbQuery('Đã từ chối lời mời');
          await ctx.editMessageReplyMarkup(undefined);
          const previousText = ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text ?? ''
            : '';
          await ctx.editMessageText(`${previousText}\n\nĐã từ chối`, { parse_mode: 'HTML' }).catch(() => undefined);
        }
      } catch (err) {
        console.error('[cb/fr]', err);
        await ctx.answerCbQuery('Xử lý lời mời thất bại');
      }
      return;
    }

    if (data?.startsWith('af:')) {
      const userId = data.slice(3);
      if (!currentApi) { await ctx.answerCbQuery('❌ Zalo chưa kết nối'); return; }
      try {
        await runZaloRequest(
          { label: `sendFriendRequest(${userId})`, priority: 'high' },
          () => currentApi.sendFriendRequest('Xin chào! Mình muốn kết bạn với bạn', userId),
        );
        await ctx.answerCbQuery('Đã gửi lời mời kết bạn');
        await ctx.editMessageReplyMarkup(undefined);
      } catch (err) {
        console.error('[cb/af]', err);
        await ctx.answerCbQuery('Gửi lời mời thất bại');
      }
      return;
    }

    if (data?.startsWith('jgi:')) {
      const groupId = data.slice(4);
      if (!currentApi) { await ctx.answerCbQuery('❌ Zalo chưa kết nối'); return; }
      try {
        await runZaloRequest(
          { label: `joinGroupInviteBox(${groupId})`, priority: 'high' },
          () => currentApi.joinGroupInviteBox(groupId),
        );
        await ctx.answerCbQuery('✅ Đã tham gia nhóm!');
        await ctx.editMessageReplyMarkup(undefined);
        groupsCache.set([]);
      } catch (err) {
        console.error('[cb/jgi]', err);
        await ctx.answerCbQuery('❌ Không thể tham gia nhóm');
      }
      return;
    }

    if (!data?.startsWith('sc:') && !data?.startsWith('sg:')) return;

    const isGroup = data.startsWith('sg:');
    const entityId = data.slice(3);
    if (!entityId) { await ctx.answerCbQuery('❌ Dữ liệu không hợp lệ'); return; }
    const threadType: 0 | 1 = isGroup ? 1 : 0;

    const existing = store.getTopicByZalo(entityId, threadType);
    if (existing !== undefined) {
      let topicAlive = false;
      try {
        await ctx.telegram.sendMessage(
          config.telegram.groupId,
          '💬 Topic đang hoạt động. Nhấn để xem.',
          {
            message_thread_id: existing,
            reply_markup: { inline_keyboard: [[{ text: 'Mở topic ↗', url: buildTopicUrl(existing) }]] },
          },
        );
        topicAlive = true;
      } catch (checkErr) {
        const checkMsg = checkErr instanceof Error ? checkErr.message : String(checkErr);
        if (
          checkMsg.includes('thread not found') ||
          checkMsg.includes('message thread not found') ||
          checkMsg.includes('TOPIC_CLOSED') ||
          checkMsg.includes('the message thread is closed')
        ) {
          console.warn(`[sc/sg] Topic ${existing} is gone — removing stale mapping for ${entityId}`);
          store.remove(existing);
        } else {
          topicAlive = true;
        }
      }
      if (topicAlive) {
        await ctx.answerCbQuery('ℹ️ Topic đã tồn tại');
        return;
      }
    }

    let displayName: string | undefined;
    if (!isGroup) {
      displayName = friendsCache.search('', 0).find(f => f.userId === entityId)?.displayName;
      if (!displayName) {
        try {
          const resp = await currentApi?.getUserInfo(entityId) as {
            changed_profiles?: Record<string, { displayName?: string }>;
          } | undefined;
          displayName = resp?.changed_profiles?.[entityId]?.displayName;
        } catch { /* ignore */ }
      }
      if (!displayName) displayName = `Zalo ${entityId}`;
    } else {
      displayName = groupsCache.search('', 0).find(g => g.groupId === entityId)?.name;
      if (!displayName) {
        try {
          const info = await currentApi?.getGroupInfo(entityId) as {
            gridInfoMap?: Record<string, { name: string }>;
          } | undefined;
          displayName = info?.gridInfoMap?.[entityId]?.name;
        } catch { /* ignore */ }
      }
      if (!displayName) displayName = `Nhóm ${entityId}`;
    }

    try {
      const icon = isGroup ? 0x6FB9F0 : 0xFF93B2;
      const prefix = isGroup ? '👥' : '👤';
      const topic = await ctx.telegram.createForumTopic(
        config.telegram.groupId,
        `${prefix} ${displayName}`.slice(0, 128),
        { icon_color: icon },
      );
      const topicId = topic.message_thread_id;
      store.set({ topicId, zaloId: entityId, type: threadType, name: displayName });
      console.log(`[search/cb] Created ${isGroup ? 'group' : 'DM'} topic "${displayName}" (topicId=${topicId})`);

      await ctx.answerCbQuery('✅ Đã tạo topic!');
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        isGroup
          ? `✅ Đã tạo topic cho nhóm <b>${displayName}</b>.\nTin nhắn từ nhóm sẽ xuất hiện tại đây.`
          : `✅ Đã tạo topic cho <b>${displayName}</b>.\nNhắn tin tại đây để chat với họ qua Zalo.`,
        { message_thread_id: topicId, parse_mode: 'HTML' },
      );
    } catch (err) {
      console.error('[search/cb] createForumTopic failed:', err);
      await ctx.answerCbQuery('❌ Tạo topic thất bại');
    }
  });
}
