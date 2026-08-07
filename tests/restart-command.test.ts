import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.TG_TOKEN ??= 'test-token';
process.env.TG_GROUP_ID ??= '-1001234567890';
process.env.TG_OWNER_IDS ??= '123456789';
process.env.DATA_DIR ??= path.join(os.tmpdir(), `zalo-tg-restart-${process.pid}`);

const [{ registerRestartCommand }, { registerCallbackHandler }] = await Promise.all([
  import('../src/telegram/commands/restart.js'),
  import('../src/telegram/callbacks.js'),
]);

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

type CallbackHandler = (ctx: {
  callbackQuery: { data: string };
  from: { id: number };
  answerCbQuery(text?: string): Promise<void>;
  editMessageText(text: string): Promise<void>;
  reply(text: string): Promise<void>;
}) => Promise<void>;

function captureRestartCallback(requestRestart: () => boolean): CallbackHandler {
  let handler: CallbackHandler | undefined;
  const bot = {
    on(name: string, callback: CallbackHandler): void {
      if (name === 'callback_query') handler = callback;
    },
  };
  registerCallbackHandler({
    bot: bot as never,
    getApi: () => null,
    setApi: () => undefined,
    onZaloLogin: async () => undefined,
    requestRestart,
  });
  if (!handler) throw new Error('Restart callback was not registered.');
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

test('stale restart callback is ignored without restarting the replacement process', async () => {
  let restartCalls = 0;
  let editCalls = 0;
  const handler = captureRestartCallback(() => {
    restartCalls += 1;
    return true;
  });

  await handler({
    callbackQuery: { data: 'restart:confirm:123456789' },
    from: { id: 123456789 },
    answerCbQuery: async () => {
      throw Object.assign(
        new Error('400: Bad Request: query is too old and response timeout expired or query ID is invalid'),
        { code: 400 },
      );
    },
    editMessageText: async () => { editCalls += 1; },
    reply: async () => undefined,
  });

  assert.equal(restartCalls, 0);
  assert.equal(editCalls, 0);
});

test('fresh restart callback edits the prompt before requesting one restart', async () => {
  let restartCalls = 0;
  const edits: string[] = [];
  const handler = captureRestartCallback(() => {
    restartCalls += 1;
    return true;
  });

  await handler({
    callbackQuery: { data: 'restart:confirm:123456789' },
    from: { id: 123456789 },
    answerCbQuery: async () => undefined,
    editMessageText: async text => { edits.push(text); },
    reply: async () => undefined,
  });

  assert.equal(restartCalls, 1);
  assert.match(edits[0] ?? '', /supervisor/i);
});

test('unexpected callback errors still propagate without restarting', async () => {
  let restartCalls = 0;
  const handler = captureRestartCallback(() => {
    restartCalls += 1;
    return true;
  });
  const error = Object.assign(new Error('400: Bad Request: chat not found'), { code: 400 });

  await assert.rejects(
    handler({
      callbackQuery: { data: 'restart:confirm:123456789' },
      from: { id: 123456789 },
      answerCbQuery: async () => { throw error; },
      editMessageText: async () => undefined,
      reply: async () => undefined,
    }),
    error,
  );
  assert.equal(restartCalls, 0);
});
