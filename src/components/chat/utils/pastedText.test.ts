import assert from 'node:assert/strict';
import test from 'node:test';

import {
  blocksInInput,
  countLines,
  expandPastedText,
  nextPastedTextId,
  parseStoredBlocks,
  pastedTextMarker,
  removePastedTextMarker,
  shouldCollapsePaste,
} from './pastedText';

const limits = { minChars: 2000, minLines: 30 };

test('short pastes stay inline', () => {
  assert.equal(shouldCollapsePaste('hello\nworld', limits), false);
  assert.equal(shouldCollapsePaste('x'.repeat(2000), limits), false);
});

test('a paste over the character or line limit is collapsed', () => {
  assert.equal(shouldCollapsePaste('x'.repeat(2001), limits), true);
  assert.equal(shouldCollapsePaste(Array(31).fill('a').join('\n'), limits), true);
  assert.equal(shouldCollapsePaste(Array(30).fill('a').join('\n'), limits), false);
});

test('marker names the block and its line count', () => {
  assert.equal(pastedTextMarker({ id: 2, text: 'a\nb\r\nc' }), '[Pasted text #2 +3 lines]');
  assert.equal(countLines(''), 0);
});

test('expanding restores exactly what a plain paste would have given', () => {
  const block = { id: 1, text: 'line 1\nline $& 2' };
  const input = `look at this:\n${pastedTextMarker(block)}\nwhy?`;
  assert.equal(expandPastedText(input, [block]), 'look at this:\nline 1\nline $& 2\nwhy?');
});

test('a block whose marker was deleted is not sent and not listed', () => {
  const a = { id: 1, text: 'A' };
  const b = { id: 2, text: 'B' };
  const input = `${pastedTextMarker(b)} then ${pastedTextMarker(a)}`;
  assert.deepEqual(blocksInInput(input, [a, b]).map((x) => x.id), [2, 1]);
  const withoutA = removePastedTextMarker(input, a);
  assert.deepEqual(blocksInInput(withoutA, [a, b]).map((x) => x.id), [2]);
  assert.equal(expandPastedText(withoutA, [a, b]), 'B then ');
});

test('ids keep counting up and storage parsing tolerates junk', () => {
  assert.equal(nextPastedTextId([]), 1);
  assert.equal(nextPastedTextId([{ id: 4, text: '' }, { id: 2, text: '' }]), 5);
  assert.deepEqual(parseStoredBlocks('not json'), []);
  assert.deepEqual(parseStoredBlocks('[{"id":1,"text":"x"},{"id":"no"}]'), [{ id: 1, text: 'x' }]);
});
