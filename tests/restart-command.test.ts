import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.TG_TOKEN ??= 'test-token';
process.env.TG_GROUP_ID ??= '-1001234567890';
process.env.TG_OWNER_IDS ??= '123456789';
process.env.DATA_DIR ??= path.join(os.tmpdir(), `zalo-tg-restart-${process.pid}`);

const { registerRestartCommand } = await import('../src/telegram/commands/restart.js');

type CommandHandler = (ctx: {
  chat: { id: number };
  from: { id: number };
  message: { message_thread_id?: number };
  reply(text: string, options?: Record<string, unknown>): Promise<void>;
}) => Promise<void>;

function captureRestartCommand(requestRestart?: () => boolean): CommandHandler {
  let handler: CommandHandler | undefined;
  const bot = {
    command(name: string, callback: CommandHandler): void {
      if (name === 'restart') handler = callback;
    },
  };
  registerRestartCommand({
    bot: bot as never,
    getApi: () => null,
    setApi: () => undefined,
    onZaloLogin: async () => undefined,
    requestRestart,
  });
  if (!handler) throw new Error('Restart command was not registered.');
  return handler;
}

test('restart command stays disabled without an explicit supervisor contract', async () => {
  const replies: string[] = [];
  await captureRestartCommand()({
    chat: { id: Number(process.env.TG_GROUP_ID) },
    from: { id: 123456789 },
    message: {},
    reply: async text => { replies.push(text); },
  });
  assert.match(replies[0] ?? '', /supervisor/i);
});

test('restart command requires an owner-bound inline confirmation', async () => {
  const replies: Array<{ text: string; options?: Record<string, unknown> }> = [];
  await captureRestartCommand(() => true)({
    chat: { id: Number(process.env.TG_GROUP_ID) },
    from: { id: 123456789 },
    message: { message_thread_id: 77 },
    reply: async (text, options) => { replies.push({ text, options }); },
  });
  const markup = replies[0]?.options?.reply_markup as {
    inline_keyboard?: Array<Array<{ callback_data?: string }>>;
  } | undefined;
  assert.equal(markup?.inline_keyboard?.[0]?.[0]?.callback_data, 'restart:confirm:123456789');
  assert.equal(markup?.inline_keyboard?.[0]?.[1]?.callback_data, 'restart:cancel:123456789');
  assert.equal(replies[0]?.options?.message_thread_id, 77);
});
