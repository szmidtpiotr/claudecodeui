import assert from 'node:assert/strict';
import test from 'node:test';

import { arrowsForTravel } from './arrowPad';

test('sends nothing until the finger has moved a full step', () => {
  assert.deepEqual(arrowsForTravel(10, 3, 24), { direction: null, count: 0, restX: 10, restY: 3 });
});

test('moving right sends right arrows and keeps the leftover travel', () => {
  assert.deepEqual(arrowsForTravel(50, 4, 24), { direction: 'right', count: 2, restX: 2, restY: 0 });
});

test('moving left sends left arrows', () => {
  assert.deepEqual(arrowsForTravel(-30, 0, 24), { direction: 'left', count: 1, restX: -6, restY: 0 });
});

test('moving up sends up arrows', () => {
  assert.deepEqual(arrowsForTravel(5, -49, 24), { direction: 'up', count: 2, restX: 0, restY: -1 });
});

test('moving down sends down arrows', () => {
  assert.deepEqual(arrowsForTravel(0, 24, 24), { direction: 'down', count: 1, restX: 0, restY: 0 });
});

test('a crooked swipe follows the longer axis only', () => {
  assert.equal(arrowsForTravel(40, 30, 24).direction, 'right');
  assert.equal(arrowsForTravel(30, 40, 24).direction, 'down');
});
