import assert from 'node:assert/strict';
import test from 'node:test';

import { consumeScrollSteps } from './touchScroll';

test('returns whole steps and keeps the rest for the next move', () => {
  assert.deepEqual(consumeScrollSteps(40, 17), { steps: 2, remainderPx: 6 });
});

test('keeps travel shorter than one step pending', () => {
  assert.deepEqual(consumeScrollSteps(10, 17), { steps: 0, remainderPx: 10 });
});

test('handles upward travel as negative steps', () => {
  assert.deepEqual(consumeScrollSteps(-40, 17), { steps: -2, remainderPx: -6 });
});

test('never divides by a zero or negative step', () => {
  assert.deepEqual(consumeScrollSteps(40, 0), { steps: 0, remainderPx: 0 });
});
