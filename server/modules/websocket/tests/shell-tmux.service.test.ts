import assert from 'node:assert/strict';
import test from 'node:test';

import { isMouseReport, isTerminalOutdated, selectIdleSessions, tmuxSessionName } from '@/modules/websocket/services/shell-tmux.service.js';

const HOUR = 3600;
const NOW = 1_000_000;

test('closes a session nobody is attached to once it has been quiet past the limit', () => {
  const listing = `ccui-aaaa\t0\t${NOW - 13 * HOUR}\n`;
  assert.deepEqual(selectIdleSessions(listing, NOW, 12 * HOUR), ['ccui-aaaa']);
});

test('keeps a quiet session that a client is still attached to', () => {
  const listing = `ccui-aaaa\t1\t${NOW - 48 * HOUR}\n`;
  assert.deepEqual(selectIdleSessions(listing, NOW, 12 * HOUR), []);
});

test('keeps a detached session that printed something recently', () => {
  const listing = `ccui-aaaa\t0\t${NOW - 2 * HOUR}\n`;
  assert.deepEqual(selectIdleSessions(listing, NOW, 12 * HOUR), []);
});

test('never touches sessions that are not ours', () => {
  const listing = `dev new\t0\t${NOW - 99 * HOUR}\nccui-bbbb\t0\t${NOW - 99 * HOUR}\n`;
  assert.deepEqual(selectIdleSessions(listing, NOW, 12 * HOUR), ['ccui-bbbb']);
});

test('ignores blank and malformed lines', () => {
  assert.deepEqual(selectIdleSessions('\n\nccui-cccc\t0\tnot-a-number\n', NOW, 12 * HOUR), []);
});

test('gives the same conversation the same tmux name, and a tmux-safe one', () => {
  const name = tmuxSessionName('/home/claude/projects/x.y_3f1c:abc');
  assert.equal(name, tmuxSessionName('/home/claude/projects/x.y_3f1c:abc'));
  assert.match(name, /^ccui-[0-9a-f]{16}$/);
  assert.notEqual(name, tmuxSessionName('/home/claude/projects/x.y_other'));
});

test('a terminal started before the last chat turn is outdated', () => {
  assert.equal(isTerminalOutdated(1_000, 2_000), true);
});

test('a terminal started after the last chat turn is current', () => {
  assert.equal(isTerminalOutdated(3_000, 2_000), false);
});

test('a terminal is current when the chat never touched the conversation', () => {
  assert.equal(isTerminalOutdated(1_000, undefined), false);
});

test('tells scrolling reports from typed keys', () => {
  assert.equal(isMouseReport('\x1b[<64;10;5M'), true);
  assert.equal(isMouseReport('\x1b[B'), false);
  assert.equal(isMouseReport('a'), false);
});
