import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveZaloLinkContent,
  normalizeZaloPollOptions,
  resolveZaloPhotoContent,
  resolveZaloFallbackDetail,
  resolveZaloTextBody,
} from '../src/zalo/message-content.js';

test('Zalo link content prefers canonical href and title', () => {
  assert.deepEqual(resolveZaloLinkContent({
    href: 'https://example.com/canonical',
    src: 'https://example.com/fallback',
    title: 'Example',
  }), {
    href: 'https://example.com/canonical',
    title: 'Example',
  });
});

test('Zalo link content falls back to src or msg for link-only payloads', () => {
  assert.deepEqual(resolveZaloLinkContent({ src: ' https://example.com/src ', desc: ' Source ' }), {
    href: 'https://example.com/src',
    title: 'Source',
  });
  assert.deepEqual(resolveZaloLinkContent({ msg: 'https://example.com/msg' }), {
    href: 'https://example.com/msg',
    title: 'https://example.com/msg',
  });
});

test('Zalo link content rejects payloads without a usable URL', () => {
  assert.equal(resolveZaloLinkContent({ href: ' ', src: '' }), null);
});

test('Zalo rich-text objects use title as their visible message body', () => {
  const media = { title: 'Thông báo định dạng', action: 'rtf' };
  assert.equal(resolveZaloTextBody(null, media, media), 'Thông báo định dạng');
  assert.equal(resolveZaloTextBody('Tin thường', 'Tin thường', {}), 'Tin thường');
});

test('Zalo photos prefer HD, retain normal and thumbnail fallbacks, and caption from title', () => {
  assert.deepEqual(resolveZaloPhotoContent({
    href: ' https://cdn.example/normal.jpg ',
    thumb: 'https://cdn.example/thumb.jpg',
    title: 'Chú thích chính',
    description: 'Chú thích cũ',
    params: JSON.stringify({ hd: 'https://cdn.example/hd.jpg' }),
  }), {
    urls: [
      'https://cdn.example/hd.jpg',
      'https://cdn.example/normal.jpg',
      'https://cdn.example/thumb.jpg',
    ],
    caption: 'Chú thích chính',
  });
});

test('Zalo photos fall back to description and reject empty media payloads', () => {
  assert.deepEqual(resolveZaloPhotoContent({
    href: 'https://cdn.example/photo.jpg',
    description: 'Mô tả',
    params: '{bad json',
  }), {
    urls: ['https://cdn.example/photo.jpg'],
    caption: 'Mô tả',
  });
  assert.equal(resolveZaloPhotoContent({ href: ' ', thumb: '' }), null);
});

test('malformed Zalo media retains a useful fallback detail', () => {
  assert.equal(resolveZaloFallbackDetail({
    title: ' ',
    description: ' Nội dung xem trước ',
    action: 'recommended.link',
  }), 'Nội dung xem trước');
  assert.equal(resolveZaloFallbackDetail({}), undefined);
});

test('Zalo poll options fit Telegram limits without empty choices', () => {
  const options = normalizeZaloPollOptions([
    { content: 'A'.repeat(101) },
    { content: '   ' },
  ]);
  assert.equal(Array.from(options[0]!).length, 100);
  assert.match(options[0]!, /…$/);
  assert.equal(options[1], 'Lựa chọn 2');
});
