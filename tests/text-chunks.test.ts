import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReplyAutoMention, splitZaloText } from '../src/domain/text-chunks.js';

test('long Zalo text splits losslessly on grapheme and mention boundaries', () => {
  const family = '👨‍👩‍👧‍👦';
  const text = `${'a'.repeat(12)} ${family} @Nguyễn Văn An ${'b'.repeat(18)}`;
  const mentionPos = text.indexOf('@Nguyễn');
  const chunks = splitZaloText(text, [{ pos: mentionPos, uid: 'u1', len: 14 }], 20);
  assert.equal(chunks.map(chunk => chunk.text).join(''), text);
  assert.ok(chunks.every(chunk => chunk.text.length <= 20));
  assert.ok(chunks.some(chunk => chunk.text.includes(family)));
  assert.ok(chunks.every(chunk => !chunk.text.includes('\uFFFD')));
  const mentionChunk = chunks.find(chunk => chunk.mentions.length > 0);
  assert.ok(mentionChunk);
  assert.equal(
    mentionChunk?.text.slice(
      mentionChunk.mentions[0]!.pos,
      mentionChunk.mentions[0]!.pos + mentionChunk.mentions[0]!.len,
    ),
    '@Nguyễn Văn An',
  );
});

test('reply auto-mention only targets incoming group messages', () => {
  assert.deepEqual(buildReplyAutoMention({
    group: true,
    replyIsTelegramOriginated: false,
    uid: 'u1',
    displayName: 'Alice',
  }), {
    prefix: '@Alice ',
    mention: { pos: 0, uid: 'u1', len: 6 },
  });
  assert.equal(buildReplyAutoMention({
    group: true,
    replyIsTelegramOriginated: true,
    uid: 'u1',
    displayName: 'Alice',
  }), null);
});
