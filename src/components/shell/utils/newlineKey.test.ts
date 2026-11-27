import assert from 'node:assert/strict';
import test from 'node:test';

import { isShiftEnter, NEWLINE_SEQUENCE } from './newlineKey';

const key = (overrides: Partial<KeyboardEvent>) =>
  ({ key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...overrides }) as KeyboardEvent;

test('Shift+Enter is a line break; Enter and other combinations are not', () => {
  assert.equal(isShiftEnter(key({ shiftKey: true })), true);
  assert.equal(isShiftEnter(key({})), false);
  assert.equal(isShiftEnter(key({ shiftKey: true, ctrlKey: true })), false);
  assert.equal(isShiftEnter(key({ shiftKey: true, altKey: true })), false);
  assert.equal(isShiftEnter(key({ shiftKey: true, metaKey: true })), false);
  assert.equal(isShiftEnter(key({ key: 'a', shiftKey: true })), false);
});

test('the line break is Ctrl+J, which the Claude prompt takes as a new line', () => {
  assert.equal(NEWLINE_SEQUENCE, '\x0a');
});
