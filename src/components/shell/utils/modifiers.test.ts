import assert from 'node:assert/strict';
import test from 'node:test';

import { applyStickyModifiers } from './modifiers';

test('passes input through when no modifier is active', () => {
  assert.equal(applyStickyModifiers('c', { ctrl: false, alt: false }), 'c');
});

test('turns a letter into its control code with CTRL', () => {
  assert.equal(applyStickyModifiers('c', { ctrl: true, alt: false }), '\x03');
  assert.equal(applyStickyModifiers('r', { ctrl: true, alt: false }), '\x12');
});

test('treats an auto-capitalised letter like the lowercase one', () => {
  assert.equal(applyStickyModifiers('C', { ctrl: true, alt: false }), '\x03');
});

test('maps CTRL + punctuation the way a hardware keyboard does', () => {
  assert.equal(applyStickyModifiers('[', { ctrl: true, alt: false }), '\x1b');
  assert.equal(applyStickyModifiers('_', { ctrl: true, alt: false }), '\x1f');
});

test('prefixes ESC with ALT', () => {
  assert.equal(applyStickyModifiers('b', { ctrl: false, alt: true }), '\x1bb');
});

test('combines CTRL and ALT', () => {
  assert.equal(applyStickyModifiers('c', { ctrl: true, alt: true }), '\x1b\x03');
});

test('leaves pasted text and key sequences alone', () => {
  assert.equal(applyStickyModifiers('hello', { ctrl: true, alt: true }), 'hello');
  assert.equal(applyStickyModifiers('\x1b[A', { ctrl: true, alt: false }), '\x1b[A');
});

test('leaves characters without a control code unchanged under CTRL', () => {
  assert.equal(applyStickyModifiers('ą', { ctrl: true, alt: false }), 'ą');
  assert.equal(applyStickyModifiers('5', { ctrl: true, alt: false }), '5');
});
