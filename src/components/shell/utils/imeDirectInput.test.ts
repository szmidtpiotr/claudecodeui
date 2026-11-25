import assert from 'node:assert/strict';
import test from 'node:test';

import { diffTypedText } from './imeDirectInput';

const DEL = '\x7f';

test('sends just the new letter while a word is being typed', () => {
  assert.equal(diffTypedText('hel', 'hell'), 'l');
});

test('sends a backspace when a letter is deleted', () => {
  assert.equal(diffTypedText('hell', 'hel'), DEL);
});

test('rewrites only the changed tail when the keyboard corrects a word', () => {
  assert.equal(diffTypedText('git comit', 'git commit '), `${DEL}${DEL}mit `);
});

test('replaces everything when nothing is shared', () => {
  assert.equal(diffTypedText('abc', 'xyz'), `${DEL}${DEL}${DEL}xyz`);
});

test('sends nothing when the text did not change', () => {
  assert.equal(diffTypedText('same', 'same'), '');
});

test('types the whole text into an empty line', () => {
  assert.equal(diffTypedText('', 'ls -la'), 'ls -la');
});
