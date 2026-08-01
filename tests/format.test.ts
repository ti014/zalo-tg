import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMentionsHtml,
  applyZaloMarkupHtml,
  escapeHtml,
  formatGroupMsg,
  formatGroupMsgHtml,
  groupCaption,
  topicName,
  truncate,
} from '../src/utils/format.js';

function assertStrictlyNestedHtml(html: string): void {
  const stack: string[] = [];
  for (const match of html.matchAll(/<\/?(b|i|u|s)>/g)) {
    const token = match[0];
    const tag = match[1]!;
    if (token.startsWith('</')) assert.equal(stack.pop(), tag, `invalid nesting in ${html}`);
    else stack.push(tag);
  }
  assert.deepEqual(stack, []);
}

function stripSupportedTags(html: string): string {
  return html.replace(/<\/?(?:b|i|u|s)>/g, '');
}

test('truncate preserves grapheme boundaries and validates limits', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('A👨‍👩‍👧‍👦B', 2), 'A…');
  assert.equal(truncate('e\u0301x', 1), '…');
  assert.equal(truncate('abc', 0), '');
  assert.throws(() => truncate('abc', -1), /non-negative integer/);
});

test('escapeHtml and mention formatting reject unsafe or overlapping ranges', () => {
  assert.equal(escapeHtml('<a&b>'), '&lt;a&amp;b&gt;');
  assert.equal(
    applyMentionsHtml('abcdef', [
      { pos: 1, len: 3, type: 0 },
      { pos: 2, len: 2, type: 0 },
      { pos: 5, len: 0, type: 0 },
    ]),
    'a<b>bcd</b>ef',
  );
});

test('Zalo markup produces strictly nested Telegram HTML for crossing styles', () => {
  const html = applyZaloMarkupHtml('abcdef', undefined, [
    { start: 0, len: 4, st: 'b' },
    { start: 2, len: 4, st: 'i' },
  ]);
  assertStrictlyNestedHtml(html);
  assert.equal(stripSupportedTags(html), 'abcdef');
  assert.equal(html, '<b>ab<i>cd</i></b><i>ef</i>');
});

test('Zalo markup safely replaces mention labels', () => {
  const html = applyZaloMarkupHtml(
    'hello @old!',
    [{ pos: 6, len: 4, type: 0, label: '<New & Name>' }],
    [{ start: 0, len: 11, st: 'i' }],
  );
  assertStrictlyNestedHtml(html);
  assert.equal(stripSupportedTags(html), 'hello &lt;New &amp; Name&gt;!');
});

test('group and topic formatting remain escaped and grapheme-safe', () => {
  assert.equal(formatGroupMsg('<A>', 'x&y'), '<b>&lt;A&gt;:</b>\nx&amp;y');
  assert.equal(formatGroupMsgHtml('<A>', '<i>x</i>'), '<b>&lt;A&gt;:</b>\n<i>x</i>');
  assert.equal(groupCaption('<A>'), '<b>&lt;A&gt;</b>');
  assert.equal(topicName('Alice', 0), '👤 Alice');
  const name = topicName('a'.repeat(124) + '👨‍👩‍👧‍👦tail', 1);
  assert.equal(Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name)).length, 128);
});
