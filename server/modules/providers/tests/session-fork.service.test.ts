import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { forkClaudeSessionById, resolveForkCut } from '@/modules/providers/services/session-fork.service.js';

const PARENT = '7d05c682-8c3b-4e3a-afb3-f5f64b0f7eaf';
const CHILD = '9fa35359-0cee-45d8-a2b2-eb72783bbded';
const A1 = '5c866e22-6007-4127-b1be-b425c7da920a';
const A2 = '1477b49f-857b-4f5c-91e7-ab6f9cdd0b6c';

const MESSAGES = [
  { type: 'user', uuid: 'u1', message: { content: 'hi' } },
  { type: 'assistant', uuid: A1, message: { content: [{ type: 'text', text: 'hello' }] } },
  { type: 'user', uuid: 'u2', message: { content: 'next' } },
  { type: 'assistant', uuid: A2, message: { content: [{ type: 'tool_use', id: 't1' }] } },
];

test('resolveForkCut honours a requested message but never cuts past a pending tool call', () => {
  assert.deepEqual(resolveForkCut(MESSAGES, A1), { uuid: A1, requestedMessageFound: true });
  assert.deepEqual(resolveForkCut(MESSAGES, A2), { uuid: 'u2', requestedMessageFound: true });
  assert.deepEqual(resolveForkCut(MESSAGES, null), { uuid: 'u2', requestedMessageFound: true });
  assert.deepEqual(resolveForkCut(MESSAGES, 'missing'), { uuid: 'u2', requestedMessageFound: false });
});

test('forkClaudeSessionById forks via the SDK and records the parent', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-fork-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const transcriptDir = path.join(tempDirectory, 'projects', '-workspace-demo');
    await mkdir(transcriptDir, { recursive: true });
    const parentPath = path.join(transcriptDir, `${PARENT}.jsonl`);
    await writeFile(parentPath, '{}\n');
    sessionsDb.createSession(PARENT, 'claude', '/workspace/demo', 'Main work', undefined, undefined, parentPath, 'user');

    const calls: Array<{ sessionId: string; options: Record<string, unknown> }> = [];
    const result = await forkClaudeSessionById(
      { sessionId: PARENT, upToMessageId: `${A1}_0` },
      {
        claudeProjectsRoot: path.join(tempDirectory, 'projects'),
        getSessionMessages: async () => MESSAGES,
        forkSession: async (sessionId, options) => {
          calls.push({ sessionId, options });
          await writeFile(path.join(transcriptDir, `${CHILD}.jsonl`), '{}\n');
          return { sessionId: CHILD };
        },
      },
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      sessionId: PARENT,
      options: { dir: '/workspace/demo', upToMessageId: A1, title: 'Main work (fork)' },
    });
    assert.equal(result.sessionId, CHILD);
    assert.equal(result.title, 'Main work (fork)');
    assert.equal(result.jsonlPath, path.join(transcriptDir, `${CHILD}.jsonl`));

    const row = sessionsDb.getSessionById(CHILD);
    assert.equal(row?.parent_session_id, PARENT);
    assert.equal(row?.custom_name, 'Main work (fork)');
    assert.equal(row?.name_source, 'derived');

    await assert.rejects(
      forkClaudeSessionById({ sessionId: 'does-not-exist' }),
      /was not found/,
    );
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
