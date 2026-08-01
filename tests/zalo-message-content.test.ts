import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveZaloLinkContent,
  resolveZaloPhotoContent,
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
