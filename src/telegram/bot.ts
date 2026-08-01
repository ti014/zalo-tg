import { Telegraf } from 'telegraf';
import http from 'node:http';
import https from 'https';
import { config } from '../config.js';
import {
  abortTelegramPollingForCapture,
  DurableTelegramCaptureError,
  recordDurableTelegramFailure,
} from '../application/durable-telegram.js';

// Force IPv4 to avoid ETIMEDOUT on systems where IPv6 is blocked/unreachable
const agent = config.telegram.apiRoot?.startsWith('http://')
  ? new http.Agent({ family: 4 })
  : new https.Agent({ family: 4 });

export const GROUP_BOT_COMMANDS = [
  { command: 'menu', description: 'Mở bảng điều khiển' },
  { command: 'status', description: 'Xem trạng thái bridge' },
  { command: 'search', description: 'Tìm bạn bè hoặc nhóm Zalo' },
  { command: 'topic', description: 'Xem và quản lý topic mapping' },
  { command: 'clear', description: 'Xóa mapping cũ có xác nhận' },
  { command: 'queue', description: 'Kiểm tra hàng đợi durable' },
  { command: 'settings', description: 'Cài đặt giao diện bridge' },
  { command: 'members', description: 'Xem thành viên nhóm Zalo' },
  { command: 'recall', description: 'Thu hồi tin đã gửi sang Zalo' },
  { command: 'addfriend', description: 'Tìm và gửi lời mời kết bạn' },
  { command: 'friendrequests', description: 'Xem lời mời kết bạn' },
  { command: 'addgroup', description: 'Tìm và thêm nhóm Zalo' },
  { command: 'joingroup', description: 'Tham gia nhóm Zalo bằng link' },
  { command: 'leavegroup', description: 'Rời nhóm Zalo của topic' },
  { command: 'kick', description: 'Xóa thành viên khỏi nhóm Zalo' },
  { command: 'backup', description: 'Xuất backup logic' },
  { command: 'restore', description: 'Khôi phục backup logic' },
  { command: 'login', description: 'Đăng nhập Zalo bằng QR' },
  { command: 'loginweb', description: 'Đăng nhập Zalo bằng QR Web' },
  { command: 'loginapp', description: 'Đăng nhập Zalo qua PC App API' },
  { command: 'autoreply', description: 'Cấu hình auto-reply DM' },
  { command: 'group_info', description: 'Xem thông tin nhóm Zalo' },
  { command: 'group_infoall', description: 'Xem toàn bộ thành viên nhóm' },
  { command: 'history', description: 'Nạp lịch sử nhóm Zalo' },
  { command: 'seed', description: 'Xem mã seed giải mã backup Zalo' },
  { command: 'admin', description: 'Xem trạng thái, cache và mapping' },
  { command: 'update', description: 'Kiểm tra phiên bản mới' },
  { command: 'restart', description: 'Khởi động lại bridge có kiểm soát' },
  { command: 'help', description: 'Xem hướng dẫn' },
] as const;

export const PRIVATE_BOT_COMMANDS = [
  { command: 'login', description: 'Đăng nhập Zalo bằng QR' },
  { command: 'loginweb', description: 'Đăng nhập Zalo bằng QR Web' },
  { command: 'loginapp', description: 'Đăng nhập Zalo qua PC App API' },
] as const;

const COMMAND_SYNC_ATTEMPTS = 3;

function commandCatalogMatches(
  actual: readonly { command: string; description: string }[],
  expected: readonly { command: string; description: string }[],
): boolean {
  return actual.length === expected.length
    && actual.every((entry, index) => (
      entry.command === expected[index]?.command
      && entry.description === expected[index]?.description
    ));
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Singleton Telegraf bot instance shared across the app. */
export const tgBot = new Telegraf(config.telegram.token, {
  telegram: {
    agent,
    ...(config.telegram.apiRoot ? { apiRoot: config.telegram.apiRoot } : {}),
  },
});

// A malformed update must not terminate long polling. Transport/polling
// failures still reject launch() and are handled as fatal by bootstrap.
tgBot.catch((err, ctx) => {
  if (err instanceof DurableTelegramCaptureError) {
    console.error(`[Telegram] Durable capture of update ${ctx.update.update_id} failed:`, err);
    abortTelegramPollingForCapture(tgBot, err);
  }
  recordDurableTelegramFailure(err);
  console.error(`[Telegram] Update ${ctx.update.update_id} failed:`, err);
});

async function syncTelegramCommandsOnce(): Promise<void> {
  const staleScopes = [
    { type: 'default' },
    { type: 'all_group_chats' },
    { type: 'all_chat_administrators' },
    { type: 'chat_administrators', chat_id: config.telegram.groupId },
  ] as const;
  for (const scope of staleScopes) {
    await tgBot.telegram.deleteMyCommands({ scope });
  }
  for (const userId of config.telegram.ownerIds) {
    await tgBot.telegram.deleteMyCommands({
      scope: {
        type: 'chat_member',
        chat_id: config.telegram.groupId,
        user_id: userId,
      },
    });
  }

  await tgBot.telegram.setMyCommands(PRIVATE_BOT_COMMANDS, {
    scope: { type: 'all_private_chats' },
  });
  await tgBot.telegram.setMyCommands(GROUP_BOT_COMMANDS, {
    scope: { type: 'chat', chat_id: config.telegram.groupId },
  });

  const [
    defaultCommands,
    allGroupCommands,
    allAdminCommands,
    privateCommands,
    groupCommands,
    adminCommands,
    ...ownerCommands
  ] = await Promise.all([
    tgBot.telegram.getMyCommands({ scope: { type: 'default' } }),
    tgBot.telegram.getMyCommands({ scope: { type: 'all_group_chats' } }),
    tgBot.telegram.getMyCommands({ scope: { type: 'all_chat_administrators' } }),
    tgBot.telegram.getMyCommands({ scope: { type: 'all_private_chats' } }),
    tgBot.telegram.getMyCommands({
      scope: { type: 'chat', chat_id: config.telegram.groupId },
    }),
    tgBot.telegram.getMyCommands({
      scope: { type: 'chat_administrators', chat_id: config.telegram.groupId },
    }),
    ...[...config.telegram.ownerIds].map(userId => tgBot.telegram.getMyCommands({
      scope: {
        type: 'chat_member' as const,
        chat_id: config.telegram.groupId,
        user_id: userId,
      },
    })),
  ]);
  if (
    defaultCommands.length !== 0
    || allGroupCommands.length !== 0
    || allAdminCommands.length !== 0
    || adminCommands.length !== 0
    || ownerCommands.some(commands => commands.length !== 0)
    || !commandCatalogMatches(privateCommands, PRIVATE_BOT_COMMANDS)
    || !commandCatalogMatches(groupCommands, GROUP_BOT_COMMANDS)
  ) {
    throw new Error('Telegram command scopes did not match the expected catalogs after sync.');
  }
}

export async function syncTelegramCommands(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= COMMAND_SYNC_ATTEMPTS; attempt += 1) {
    try {
      await syncTelegramCommandsOnce();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < COMMAND_SYNC_ATTEMPTS) await wait(attempt * 1_000);
    }
  }
  throw new Error(
    `Telegram command menu sync failed after ${COMMAND_SYNC_ATTEMPTS} attempts.`,
    { cause: lastError },
  );
}
