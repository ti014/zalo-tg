import assert from 'node:assert/strict';
import test from 'node:test';

import { redactLogValue } from '../src/runtime/redacted-console.js';

test('log redaction removes Telegram tokens and sensitive object fields', () => {
  const token = '1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
  const error = Object.assign(new Error(`request to /bot${token}/sendMessage timed out`), {
    code: 'ETIMEDOUT',
  });
  const redacted = redactLogValue({
    authorization: `Bearer ${token}`,
    nested: { url: `https://api.telegram.org/bot${token}/getMe` },
    error,
  }, [token]) as {
    authorization: string;
    nested: { url: string };
    error: { message: string; code: string; stack: string };
  };

  assert.equal(redacted.authorization, '[REDACTED]');
  assert.equal(
    redacted.nested.url,
    'https://api.telegram.org/bot[REDACTED_TELEGRAM_TOKEN]/getMe',
  );
  assert.equal(
    redacted.error.message,
    'request to /bot[REDACTED_TELEGRAM_TOKEN]/sendMessage timed out',
  );
  assert.equal(redacted.error.code, 'ETIMEDOUT');
  assert.match(redacted.error.stack, /REDACTED_TELEGRAM_TOKEN/);
  assert.equal(JSON.stringify(redacted).includes(token), false);
  assert.equal(
    redactLogValue(`https://api.telegram.org/bot${token}/getMe`),
    'https://api.telegram.org/bot[REDACTED_TELEGRAM_TOKEN]/getMe',
  );
});
