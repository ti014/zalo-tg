const OWNER_COMMANDS = new Set([
  'addfriend',
  'addgroup',
  'backup',
  'clear',
  'friendrequests',
  'joingroup',
  'kick',
  'leavegroup',
  'login',
  'members',
  'queue',
  'recall',
  'restore',
  'search',
  'settings',
  'topic',
]);

const TELEGRAM_GROUP_ANONYMOUS_BOT_ID = 1087968824;

type RawUpdate = Record<string, unknown>;

function asRecord(value: unknown): RawUpdate | undefined {
  return typeof value === 'object' && value !== null ? value as RawUpdate : undefined;
}

export function commandNameFromUpdate(update: unknown): string | undefined {
  const raw = asRecord(update);
  const message = asRecord(raw?.message);
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  const match = text.match(/^\/([a-z0-9_]+)(?:@[a-z0-9_]+)?(?:\s|$)/i);
  return match?.[1]?.toLowerCase();
}

export function requiresOwner(update: unknown): boolean {
  const raw = asRecord(update);
  if (!raw) return false;
  if (raw.callback_query || raw.poll_answer || raw.message_reaction) return true;

  const message = asRecord(raw.message);
  if (message?.poll) return true;
  const command = commandNameFromUpdate(raw);
  return command !== undefined && OWNER_COMMANDS.has(command);
}

export function isAnonymousAdminUpdate(update: unknown): boolean {
  const raw = asRecord(update);
  const message = asRecord(raw?.message);
  const chat = asRecord(message?.chat);
  const senderChat = asRecord(message?.sender_chat);
  const from = asRecord(message?.from);
  return typeof chat?.id === 'number'
    && typeof senderChat?.id === 'number'
    && senderChat.id === chat.id
    && from?.id === TELEGRAM_GROUP_ANONYMOUS_BOT_ID
    && from.is_bot === true;
}

export function updateChatId(update: unknown): number | undefined {
  const raw = asRecord(update);
  const message = asRecord(raw?.message);
  const callback = asRecord(raw?.callback_query);
  const callbackMessage = asRecord(callback?.message);
  const reaction = asRecord(raw?.message_reaction);
  const chat = asRecord(message?.chat) ?? asRecord(callbackMessage?.chat) ?? asRecord(reaction?.chat);
  return typeof chat?.id === 'number' ? chat.id : undefined;
}
