import type { Telegraf } from 'telegraf';

interface TelegramChatCapabilities {
  type?: string;
  is_forum?: boolean;
}

interface TelegramMemberCapabilities {
  status?: string;
  can_manage_topics?: boolean;
  can_delete_messages?: boolean;
  can_pin_messages?: boolean;
}

function deploymentError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export function assertTelegramDeploymentCapabilities(
  chat: TelegramChatCapabilities,
  member: TelegramMemberCapabilities,
): void {
  if (chat.type !== 'supergroup') {
    throw deploymentError(
      'TELEGRAM_SUPERGROUP_REQUIRED',
      'TG_GROUP_ID must reference a Telegram supergroup.',
    );
  }
  if (chat.is_forum !== true) {
    throw deploymentError(
      'TELEGRAM_FORUM_REQUIRED',
      'The configured Telegram supergroup must have Topics enabled.',
    );
  }
  if (member.status === 'creator') return;
  if (member.status !== 'administrator') {
    throw deploymentError(
      'TELEGRAM_BOT_ADMIN_REQUIRED',
      'The Telegram bot must be an administrator in the configured supergroup.',
    );
  }

  const missing = [
    member.can_manage_topics === true ? undefined : 'Manage Topics',
    member.can_delete_messages === true ? undefined : 'Delete Messages',
    member.can_pin_messages === true ? undefined : 'Pin Messages',
  ].filter((permission): permission is string => permission !== undefined);
  if (missing.length > 0) {
    throw deploymentError(
      'TELEGRAM_ADMIN_PERMISSIONS_REQUIRED',
      `Telegram bot is missing required administrator permissions: ${missing.join(', ')}.`,
    );
  }
}

export async function verifyTelegramDeployment(
  bot: Telegraf,
  groupId: number,
): Promise<void> {
  if (!bot.botInfo) {
    throw deploymentError(
      'TELEGRAM_BOT_IDENTITY_MISSING',
      'Telegram bot identity is unavailable after polling startup.',
    );
  }
  const [chat, member] = await Promise.all([
    bot.telegram.getChat(groupId),
    bot.telegram.getChatMember(groupId, bot.botInfo.id),
  ]);
  assertTelegramDeploymentCapabilities(chat, member);
}
