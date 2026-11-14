import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractReactionTargetMsgIds,
  TELEGRAM_TO_ZALO_REACTION,
  ZALO_TO_TELEGRAM_REACTION,
} from '../src/zalo/reaction.js';
import { reactionEventDedupeStore, reactionSummaryStore } from '../src/store/reactions.js';

test('reaction target extraction uses cMsgID when Zalo mobile emits gMsgID zero', () => {
  assert.deepEqual(extractReactionTargetMsgIds({
    msgId: 'reaction-event-id',
    cliMsgId: 'reaction-client-id',
    content: { rMsg: [{ gMsgID: 0, cMsgID: 1782286269667 }] },
  }), ['1782286269667']);
});

test('reaction target extraction prefers and deduplicates explicit target IDs', () => {
  assert.deepEqual(extractReactionTargetMsgIds({
    msgId: 'event-global',
    cliMsgId: 'event-client',
    content: { rMsg: [
      { gMsgID: 'target-global', cMsgID: 'target-client' },
      { gMsgID: 'target-global', cMsgID: 'target-client-2' },
    ] },
  }), ['target-global', 'target-client', 'target-client-2']);
});

test('reaction target extraction filters invalid IDs and supports legacy payloads', () => {
  assert.deepEqual(extractReactionTargetMsgIds({
    content: { rMsg: [{ gMsgID: ' 0 ', cMsgID: ' ' }] },
  }), []);
  assert.deepEqual(extractReactionTargetMsgIds({ msgId: ' m1 ', cliMsgId: 'c1' }), ['m1', 'c1']);
});

test('reaction mappings include native DM and tears-of-joy behavior', () => {
  assert.equal(ZALO_TO_TELEGRAM_REACTION['/-heart'], '❤');
  assert.equal(TELEGRAM_TO_ZALO_REACTION['😂'], ":')");
});

test('reaction action IDs preserve repeated taps and dedupe replayed events', () => {
  const action = `reaction-action-${process.pid}-${Date.now()}`;
  const input = { zaloId: 'group', targetMsgIds: ['m'], icon: '/-heart', actionId: action };
  assert.equal(reactionEventDedupeStore.isDuplicateZaloInbound(input), false);
  assert.equal(reactionEventDedupeStore.isDuplicateZaloInbound({ ...input, actionId: `${action}-2` }), false);
  assert.equal(reactionEventDedupeStore.isDuplicateZaloInbound(input), true);
  const entry = reactionSummaryStore.upsert(987654, '❤️', 'Alice');
  reactionSummaryStore.upsert(987654, '❤️', 'Alice');
  reactionSummaryStore.upsert(987654, '👍', 'Bob');
  assert.equal(reactionSummaryStore.buildText(entry), '❤️ ×2 Alice  👍 Bob');
});

test('reaction summaries escape untrusted HTML once without changing counts', () => {
  const entry = reactionSummaryStore.upsert(987655, '<icon>&', 'Alice <ops> & Bob');
  reactionSummaryStore.upsert(987655, '<icon>&', 'Alice <ops> & Bob');
  const expected = '&lt;icon&gt;&amp; ×2 Alice &lt;ops&gt; &amp; Bob';
  assert.equal(reactionSummaryStore.buildText(entry), expected);
  assert.equal(reactionSummaryStore.buildText(entry), expected);
});

test('reaction event dedupe recognizes equivalent target ordering', () => {
  const unique = `conversation-${process.pid}-${Date.now()}`;
  const input = {
    zaloId: unique,
    targetMsgIds: ['b', 'a', 'a'],
    icon: '/-heart',
    actorName: ' Nguyễn  Văn A ',
  };
  assert.equal(reactionEventDedupeStore.isDuplicateZaloInbound(input), false);
  assert.equal(reactionEventDedupeStore.isDuplicateZaloInbound({
    ...input,
    targetMsgIds: ['a', 'b'],
    actorName: 'nguyễn văn a',
  }), true);
});
