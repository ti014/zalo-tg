import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractUndoTargetId,
  parseDeletedZaloMessages,
  parseEcard,
  parseGroupRename,
  parseMissedCall,
} from '../src/zalo/system-events.js';

test('system event parsers handle e-card and missed-call metadata', () => {
  assert.deepEqual(parseEcard({
    title: 'Sinh nhật',
    description: 'Chúc mừng',
    params: JSON.stringify({ notifyTxt: 'Một lời chúc' }),
    href: 'https://example.test/card.png',
  }), {
    title: 'Sinh nhật',
    description: 'Chúc mừng',
    notification: 'Một lời chúc',
    imageUrl: 'https://example.test/card.png',
  });
  assert.deepEqual(parseMissedCall({ action: 'recommened.misscall', params: '{"calltype":1}' }), { video: true });
  assert.equal(parseMissedCall({ action: 'other' }), null);
});

test('deleted-message parser accepts JSON and ignores malformed payloads', () => {
  assert.deepEqual(parseDeletedZaloMessages('[{"globalDelMsgId":"42"}]'), [{ globalDelMsgId: '42' }]);
  assert.deepEqual(parseDeletedZaloMessages('{bad'), []);
});

test('group rename and recall parsers accept provider compatibility variants', () => {
  assert.equal(parseGroupRename('update', { groupName: ' Nhóm mới ' }), 'Nhóm mới');
  assert.equal(parseGroupRename('update_setting', { name: 'Fallback' }), 'Fallback');
  assert.equal(parseGroupRename('join', { groupName: 'Ignored' }), null);
  assert.equal(extractUndoTargetId({
    data: { content: { globalMsgId: 0, cliMsgId: 'client-42' } },
  }), 'client-42');
  assert.equal(extractUndoTargetId({ data: { msgId: 'legacy-1' } }), 'legacy-1');
});
