import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSessionView } from './sessionView';

test('opens the remembered terminal view when the chat is showing', () => {
  assert.equal(resolveSessionView('shell', 'chat'), 'shell');
});

test('opens the remembered chat view when the terminal is showing', () => {
  assert.equal(resolveSessionView('chat', 'shell'), 'chat');
});

test('changes nothing when the remembered view is already showing', () => {
  assert.equal(resolveSessionView('shell', 'shell'), null);
});

test('changes nothing for a session with no remembered view', () => {
  assert.equal(resolveSessionView(undefined, 'chat'), null);
});

test('leaves the files and git tabs alone', () => {
  assert.equal(resolveSessionView('shell', 'files'), null);
  assert.equal(resolveSessionView('chat', 'git'), null);
});
