import assert from 'node:assert/strict';
import test from 'node:test';

import { isTopicUnavailableError } from '../src/domain/topic-errors.js';

test('topic classifier recognizes closed and deleted variants', () => {
  for (const message of [
    'Bad Request: message thread not found',
    'TOPIC_CLOSED',
    'TOPIC_DELETED',
    'Bad Request: the message thread is closed',
  ]) {
    assert.equal(isTopicUnavailableError(new Error(message)), true, message);
  }
});

test('topic classifier does not retry unrelated Telegram errors', () => {
  assert.equal(isTopicUnavailableError(new Error('Too Many Requests')), false);
  assert.equal(isTopicUnavailableError(new Error('bot was blocked by the user')), false);
});
