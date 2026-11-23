import assert from 'node:assert/strict';
import test from 'node:test';

import { toElicitationResult } from './claude-sdk.js';

/**
 * An MCP server's request for input ("elicitation") is answered through the
 * permission round trip. These pin how the panel's decision becomes the MCP
 * result: no answer is `cancel`, a denial is `decline`, and only typed form
 * fields go back on `accept`.
 */

test('no answer or an aborted request is cancel, never an invented accept', () => {
  assert.deepEqual(toElicitationResult(null, 'form'), { action: 'cancel' });
  assert.deepEqual(toElicitationResult({ cancelled: true }, 'form'), { action: 'cancel' });
});

test('a denial is decline', () => {
  assert.deepEqual(toElicitationResult({ allow: false }, 'form'), { action: 'decline' });
  assert.deepEqual(toElicitationResult({ allow: false }, 'url'), { action: 'decline' });
});

test('a URL request is accepted without content', () => {
  assert.deepEqual(toElicitationResult({ allow: true, updatedInput: { content: { a: 1 } } }, 'url'), { action: 'accept' });
});

test('a form accept keeps only flat primitives and string lists', () => {
  const result = toElicitationResult({
    allow: true,
    updatedInput: {
      content: {
        target: 'prod',
        count: 3,
        confirm: false,
        tags: ['a', 'b'],
        nested: { no: true },
        mixed: ['a', 1],
        missing: null,
      },
    },
  }, 'form');
  assert.deepEqual(result, {
    action: 'accept',
    content: { target: 'prod', count: 3, confirm: false, tags: ['a', 'b'] },
  });
});

test('a form accept with no content sends an empty object', () => {
  assert.deepEqual(toElicitationResult({ allow: true }, undefined), { action: 'accept', content: {} });
});
