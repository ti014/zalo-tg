import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.TG_TOKEN ??= 'test-token';
process.env.TG_GROUP_ID ??= '-1001234567890';
process.env.TG_OWNER_IDS ??= '123456789';
process.env.DATA_DIR ??= path.join(os.tmpdir(), `zalo-tg-seed-${process.pid}`);

const { renderSeedMessage } = await import('../src/telegram/commands/seed.js');

test('seed command rendering explains missing app sessions and escapes the secret', () => {
  assert.match(renderSeedMessage(undefined), /loginapp/);
  const rendered = renderSeedMessage('secret<&>');
  assert.match(rendered, /secret&lt;&amp;&gt;/);
  assert.doesNotMatch(rendered, /secret<&>/);
  assert.match(rendered, /secret/i);
});
