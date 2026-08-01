import type { TgHandlerContext } from '../types.js';
import { config } from '../../config.js';
import { escapeHtml } from '../../utils/format.js';
import { loadAppSession } from '../../zalo/app-api.js';

export function renderSeedMessage(dkey: string | undefined): string {
  if (!dkey?.trim()) {
    return 'Không tìm thấy <code>dkey</code>. Hãy đăng nhập lại bằng <code>/loginapp</code>.';
  }
  return '<b>Backup decryption seed (dkey)</b>\n\n'
    + `<code>${escapeHtml(dkey.trim())}</code>\n\n`
    + '<i>Đây là secret; không chuyển tiếp hoặc chụp màn hình nội dung này.</i>';
}

export function registerSeedCommand({ bot }: TgHandlerContext): void {
  bot.command('seed', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const session = loadAppSession();
    await ctx.reply(renderSeedMessage(session?.dkey), {
      parse_mode: 'HTML',
      ...(threadId ? { message_thread_id: threadId } : {}),
    });
  });
}
