import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  buildDerivedTaskPrompt,
  checkDerivedSessionGuardrails,
  extractTranscriptUuid,
  MAX_DERIVED_SESSION_DEPTH,
  MAX_DERIVED_SESSIONS_PER_TURN,
  pickForkCutPoint,
  readForkedFromSessionId,
  readLastAssistantText,
} from '@/modules/providers/list/claude/claude-fork-utils.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';

const PARENT = '7d05c682-8c3b-4e3a-afb3-f5f64b0f7eaf';
const CHILD = '9fa35359-0cee-45d8-a2b2-eb72783bbded';

test('readForkedFromSessionId reads the SDK fork marker and ignores junk', () => {
  assert.equal(
    readForkedFromSessionId({ sessionId: CHILD, forkedFrom: { sessionId: PARENT, messageUuid: 'x' } }),
    PARENT,
  );
  assert.equal(readForkedFromSessionId({ sessionId: CHILD }), null);
  assert.equal(readForkedFromSessionId({ sessionId: CHILD, forkedFrom: null }), null);
  assert.equal(readForkedFromSessionId({ sessionId: CHILD, forkedFrom: { sessionId: 42 } }), null);
  assert.equal(readForkedFromSessionId({ sessionId: CHILD, forkedFrom: { sessionId: CHILD } }), null);
  assert.equal(readForkedFromSessionId('nope'), null);
});

test('extractTranscriptUuid strips the per-block suffix of chat message ids', () => {
  assert.equal(extractTranscriptUuid(`${PARENT}_0`), PARENT);
  assert.equal(extractTranscriptUuid(PARENT), PARENT);
  assert.equal(extractTranscriptUuid('claude_12345'), null);
  assert.equal(extractTranscriptUuid(undefined), null);
});

test('pickForkCutPoint stops before an unanswered tool call', () => {
  const messages = [
    { type: 'user', uuid: 'u1', message: { content: 'hi' } },
    { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'hello' }] } },
    { type: 'user', uuid: 'u2', message: { content: 'make a derived session' } },
    { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', id: 't1' }] } },
    { type: 'user', uuid: 'u3', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
    { type: 'assistant', uuid: 'a3', message: { content: [{ type: 'text', text: 'now forking' }] } },
    { type: 'assistant', uuid: 'a4', message: { content: [{ type: 'tool_use', id: 't2' }] } },
  ];
  assert.equal(pickForkCutPoint(messages), 'a3');
  assert.equal(pickForkCutPoint(messages.slice(0, 5)), 'u3');
  assert.equal(pickForkCutPoint([{ type: 'assistant', uuid: 'x', message: { content: [{ type: 'tool_use', id: 't' }] } }]), null);
  assert.equal(pickForkCutPoint([]), null);
});

test('readLastAssistantText returns the newest assistant text', () => {
  assert.equal(
    readLastAssistantText([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'old' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'new' }, { type: 'tool_use', id: 'x' }] } },
      { type: 'user', message: { content: 'later prompt' } },
    ]),
    'new',
  );
  assert.equal(readLastAssistantText([{ type: 'user', message: { content: 'x' } }]), null);
});

test('guardrails cap derived sessions per turn and nesting depth', () => {
  assert.equal(checkDerivedSessionGuardrails({ createdThisTurn: 0, currentDepth: 0 }), null);
  assert.equal(
    checkDerivedSessionGuardrails({
      createdThisTurn: MAX_DERIVED_SESSIONS_PER_TURN - 1,
      currentDepth: MAX_DERIVED_SESSION_DEPTH - 1,
    }),
    null,
  );
  assert.match(
    checkDerivedSessionGuardrails({ createdThisTurn: MAX_DERIVED_SESSIONS_PER_TURN, currentDepth: 0 }) ?? '',
    /at most 5/,
  );
  assert.match(
    checkDerivedSessionGuardrails({ createdThisTurn: 0, currentDepth: MAX_DERIVED_SESSION_DEPTH }) ?? '',
    /levels deep/,
  );
});

test('buildDerivedTaskPrompt frames the task for the derived session', () => {
  const prompt = buildDerivedTaskPrompt({ parentSessionId: PARENT, parentTitle: 'Main work', task: '  Check the tests  ' });
  assert.match(prompt, /\[Derived session\]/);
  assert.match(prompt, /"Main work"/);
  assert.ok(prompt.endsWith('Check the tests'));
});

test('synchronizer records the parent from a forked transcript', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'fork-sync-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const filePath = path.join(tempDirectory, `${CHILD}.jsonl`);
    const rows = [
      {
        type: 'user', sessionId: CHILD, cwd: '/workspace/demo', uuid: 'r1',
        forkedFrom: { sessionId: PARENT, messageUuid: 'm1' },
        message: { role: 'user', content: 'hello' },
      },
      {
        type: 'assistant', sessionId: CHILD, cwd: '/workspace/demo', uuid: 'r2',
        forkedFrom: { sessionId: PARENT, messageUuid: 'm2' },
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      },
      { type: 'custom-title', sessionId: CHILD, customTitle: 'Side quest' },
    ];
    await writeFile(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

    const synchronizer = new ClaudeSessionSynchronizer();
    const sessionId = await synchronizer.synchronizeFile(filePath);

    assert.equal(sessionId, CHILD);
    const row = sessionsDb.getSessionById(CHILD);
    assert.equal(row?.parent_session_id, PARENT);
    assert.equal(row?.custom_name, 'Side quest');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
