import { createReadStream } from 'fs';
import { userCache } from '../store/index.js';
import { tgBot } from './bot.js';
import { config } from '../config.js';
import { escapeHtml } from '../utils/format.js';
import { triggerQRLogin } from '../zalo/client.js';
import type { ZaloAPI } from '../zalo/types.js';

export type TgEntity = { type: string; offset: number; length: number; user?: { first_name: string; last_name?: string } };

export function resolveTgMentions(
  text: string,
  entities: ReadonlyArray<TgEntity> | undefined,
  forZaloGroup: boolean,
  zaloId?: string,
): Array<{ pos: number; uid: string; len: number }> {
  const result: Array<{ pos: number; uid: string; len: number }> = [];
  if (!forZaloGroup) return result;

  const resolveName = (rawName: string) => zaloId
    ? userCache.resolveByNameInGroup(rawName, zaloId)
    : userCache.resolveByName(rawName);

  if (entities) {
    for (const e of entities) {
      if (e.type === 'mention') {
        const rawName = text.slice(e.offset + 1, e.offset + e.length);
        const uid = resolveName(rawName);
        if (uid) result.push({ pos: e.offset, uid, len: e.length });
      } else if (e.type === 'text_mention' && e.user) {
        const rawName = e.user.first_name + (e.user.last_name ? ` ${e.user.last_name}` : '');
        const uid = resolveName(rawName);
        if (uid) result.push({ pos: e.offset, uid, len: e.length });
      }
    }
  }

  if (result.length === 0) {
    const atPattern = /@([\p{L}\p{N}_]+(?:\s[\p{L}\p{N}_]+){0,3})/gu;
    let m: RegExpExecArray | null;
    while ((m = atPattern.exec(text)) !== null) {
      const captured = m[1];
      if (/^(all|everyone|tất\s*cả)$/i.test(captured)) {
        result.push({ pos: m.index, uid: '-1', len: m[0].length });
        continue;
      }
      const words = captured.split(' ');
      for (let end = words.length; end >= 1; end--) {
        const candidate = words.slice(0, end).join(' ');
        const uid = resolveName(candidate);
        if (uid) {
          result.push({ pos: m.index, uid, len: ('@' + candidate).length });
          break;
        }
      }
    }
  }

  return result;
}

export function normalizePhoneSearchQuery(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  if (!/^[+()\d.\s-]+$/.test(trimmed)) return null;

  const digitsOnly = trimmed.replace(/\D/g, '');
  if (digitsOnly.length < 9 || digitsOnly.length > 15) return null;

  return digitsOnly;
}

export function buildTopicUrl(topicId: number): string {
  const chatId = String(config.telegram.groupId);
  const internalChatId = chatId.startsWith('-100') ? chatId.slice(4) : chatId.replace(/^-/, '');
  return `https://t.me/c/${internalChatId}/${topicId}`;
}

let qrLoginInProgress = false;

export async function handleLoginCommand(
  chatId: number,
  threadId: number | undefined,
  onNewApi: (api: ZaloAPI) => void,
): Promise<void> {
  if (qrLoginInProgress) {
    await tgBot.telegram.sendMessage(
      chatId,
      '⏳ Đang có phiên đăng nhập khác đang chạy. Vui lòng chờ...',
      threadId ? { message_thread_id: threadId } : {},
    );
    return;
  }

  qrLoginInProgress = true;
  const msgOpts = threadId ? { message_thread_id: threadId } : {};

  try {
    await tgBot.telegram.sendMessage(chatId, '🔄 Đang tạo mã QR Zalo...', msgOpts);

    const newApi = await triggerQRLogin({
      onQRReady: async (imagePath) => {
        await tgBot.telegram.sendPhoto(
          chatId,
          { source: createReadStream(imagePath) },
          {
            ...msgOpts,
            caption: '📱 Mở ứng dụng <b>Zalo</b> → Cài đặt → Quét mã QR để đăng nhập.',
            parse_mode: 'HTML',
          },
        );
      },
      onExpired: async () => {
        await tgBot.telegram.sendMessage(chatId, '⏰ QR hết hạn, đang tạo mã mới...', msgOpts);
      },
      onScanned: async (displayName) => {
        await tgBot.telegram.sendMessage(
          chatId,
          `✅ Đã quét! Chờ xác nhận từ <b>${escapeHtml(displayName)}</b>...`,
          { ...msgOpts, parse_mode: 'HTML' },
        );
      },
      onDeclined: async () => {
        await tgBot.telegram.sendMessage(chatId, '❌ Đăng nhập bị từ chối trên điện thoại.', msgOpts);
      },
      onSuccess: async () => {
        await tgBot.telegram.sendMessage(
          chatId,
          '🎉 Đăng nhập Zalo thành công! Bridge đang hoạt động.',
          msgOpts,
        );
      },
    });

    onNewApi(newApi);
  } catch (err) {
    await tgBot.telegram.sendMessage(
      chatId,
      `❌ Đăng nhập thất bại: ${String(err)}`,
      msgOpts,
    ).catch(() => undefined);
  } finally {
    qrLoginInProgress = false;
  }
}
