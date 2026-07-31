import assert from 'node:assert/strict';
import test from 'node:test';

import { MessageLinkCache } from '../src/domain/message-links.js';

test('load removes sentinel and duplicate aliases', () => {
  const cache = new MessageLinkCache<string>(10);
  const result = cache.load({
    pairs: [['0', 1], ['a', 1], ['a', 2], ['b', 2]],
    quotes: [[1, 'old'], [2, 'current']],
  });

  assert.equal(result.normalized, true);
  assert.equal(cache.getTelegramId('0'), undefined);
  assert.equal(cache.getTelegramId('a'), 2);
  assert.equal(cache.getTelegramId('b'), 2);
  assert.equal(cache.getQuote(1), undefined);
  assert.equal(cache.getQuote(2), 'current');
  assert.deepEqual(cache.snapshot().pairs, [['a', 2], ['b', 2]]);
});

test('evicting one alias retains quote while another alias references it', () => {
  const cache = new MessageLinkCache<string>(2);
  cache.save(10, ['msg', 'real'], 'quote-10');
  cache.save(20, ['next'], 'quote-20');

  assert.equal(cache.getTelegramId('msg'), undefined);
  assert.equal(cache.getTelegramId('real'), 10);
  assert.equal(cache.getQuote(10), 'quote-10');
  assert.equal(cache.getQuote(20), 'quote-20');
});

test('moving aliases drops an old quote only after its final reference moves', () => {
  const cache = new MessageLinkCache<string>(10);
  cache.save(10, ['a', 'b'], 'quote-10');
  cache.save(20, ['a'], 'quote-20');
  assert.equal(cache.getQuote(10), 'quote-10');

  cache.save(20, ['b'], 'quote-20');
  assert.equal(cache.getQuote(10), undefined);
  assert.equal(cache.getQuote(20), 'quote-20');
});
