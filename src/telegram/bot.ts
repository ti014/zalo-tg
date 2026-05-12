import { Telegraf } from 'telegraf';
import https from 'https';
import { config } from '../config.js';

// Force IPv4 to avoid ETIMEDOUT on systems where IPv6 is blocked/unreachable
const agent = new https.Agent({ family: 4 });

export const BOT_COMMANDS = [
  { command: 'menu',   description: 'Mở bảng điều khiển' },
  { command: 'search', description: 'Tìm bạn bè hoặc nhóm Zalo' },
  { command: 'login',  description: 'Đăng nhập Zalo bằng QR' },
  { command: 'help',   description: 'Xem hướng dẫn' },
];

/** Singleton Telegraf bot instance shared across the app. */
export const tgBot = new Telegraf(config.telegram.token, {
  telegram: { agent },
});

export async function syncTelegramCommands(): Promise<void> {
  await tgBot.telegram.setMyCommands(BOT_COMMANDS);
}
