import assert from 'node:assert/strict';
import test from 'node:test';

import { recoverTaskNotificationRows } from '@/modules/providers/list/claude/claude-sessions.provider.js';

// Port of the "recover background-agent results" part of upstream 557109a2:
// Claude logs a background task's completion report either as a user-role turn,
// a `queue-operation` record, or (newer CLI builds) a `queued_command`
// attachment. Only the first shape used to reach the history view.

const notification = (toolUseId: string, summary = 'Agent finished') =>
  `<task-notification>\n<task-id>t-${toolUseId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>${summary}</summary>\n<result>All done</result>\n</task-notification>`;

const userRow = (content: string, uuid = 'u1') => ({
  type: 'user',
  uuid,
  timestamp: '2026-11-01T10:00:00.000Z',
  sessionId: 's1',
  message: { role: 'user', content },
});

const queueOperation = (operation: string, content: string) => ({
  type: 'queue-operation',
  operation,
  timestamp: '2026-11-01T10:00:01.000Z',
  sessionId: 's1',
  content,
});

const queuedCommand = (prompt: string, uuid = 'a1') => ({
  type: 'attachment',
  uuid,
  timestamp: '2026-11-01T10:00:02.000Z',
  sessionId: 's1',
  attachment: { type: 'queued_command', prompt, commandMode: 'task-notification' },
});

test('a notification logged only as a queue-operation becomes a user-role row', () => {
  const rows = recoverTaskNotificationRows([queueOperation('remove', notification('toolu_A'))]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'user');
  assert.equal(rows[0].message.role, 'user');
  assert.equal(rows[0].message.content, notification('toolu_A'));
  assert.equal(rows[0].timestamp, '2026-11-01T10:00:01.000Z');
  assert.equal(rows[0].uuid, 'task-notification:tool:toolu_A');
});

test('a notification logged only as a queued_command attachment becomes a user-role row', () => {
  const rows = recoverTaskNotificationRows([queuedCommand(notification('toolu_B'), 'att-uuid')]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].uuid, 'att-uuid');
  assert.equal(rows[0].message.content, notification('toolu_B'));
});

test('a notification already delivered as a user turn is not duplicated', () => {
  const rows = recoverTaskNotificationRows([
    queueOperation('enqueue', notification('toolu_C')),
    userRow(notification('toolu_C')),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].uuid, 'u1');
});

test('the same notification in several detached shapes is surfaced once', () => {
  const rows = recoverTaskNotificationRows([
    queueOperation('enqueue', notification('toolu_D')),
    queuedCommand(notification('toolu_D')),
    queueOperation('remove', notification('toolu_D')),
  ]);
  assert.equal(rows.length, 1);
});

test('unrelated rows pass through untouched and in order', () => {
  const assistant = { type: 'assistant', uuid: 'x', message: { role: 'assistant', content: 'hi' } };
  const plainQueue = queueOperation('enqueue', 'just a queued user prompt');
  const otherAttachment = { type: 'attachment', uuid: 'p', attachment: { type: 'queued_command', prompt: 'hello', commandMode: 'prompt' } };
  const input = [assistant, plainQueue, otherAttachment];
  assert.deepEqual(recoverTaskNotificationRows(input), input);
});

test('notifications without a tool-use id are keyed by task id', () => {
  const batch = '<task-notification>\n<task-id>a</task-id>\n<task-id>b</task-id>\n<status>completed</status>\n</task-notification>';
  const rows = recoverTaskNotificationRows([queueOperation('enqueue', batch), userRow(batch)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].uuid, 'u1');
});
