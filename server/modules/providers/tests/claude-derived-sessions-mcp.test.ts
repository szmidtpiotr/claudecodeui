import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { createDerivedSessionHandlers } from '@/modules/providers/list/claude/claude-derived-sessions-mcp.js';
import type { ForkSessionInput } from '@/modules/providers/services/session-fork.service.js';

async function withIsolatedDatabase(run: () => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'derived-mcp-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await run();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeFork() {
  let counter = 0;
  const calls: ForkSessionInput[] = [];
  const fork = async (input: ForkSessionInput) => {
    calls.push(input);
    counter += 1;
    const sessionId = `child-${counter}`;
    sessionsDb.createSession(sessionId, 'claude', '/workspace/demo', input.title ?? 'x', undefined, undefined, null, 'user', input.sessionId);
    return {
      sessionId,
      parentSessionId: input.sessionId,
      title: input.title ?? 'x',
      projectPath: '/workspace/demo',
      jsonlPath: null,
      upToMessageUuid: 'u',
      requestedMessageFound: true,
    };
  };
  return { fork, calls };
}

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

test('one turn may create at most 5 derived sessions', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('root', 'claude', '/workspace/demo', 'Root');
    const { fork } = fakeFork();
    const handlers = createDerivedSessionHandlers({
      getCurrentSessionId: () => 'root',
      parentOptions: {},
      userId: null,
      runHeadless: async () => undefined,
      isSessionActive: () => false,
      fork,
    });

    for (let index = 0; index < 5; index += 1) {
      const result = await handlers.createDerivedSession({ title: `Side ${index}` });
      assert.equal(result.isError, undefined);
    }
    const refused = await handlers.createDerivedSession({ title: 'One too many' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /at most 5/);
  });
});

test('nesting deeper than 3 levels is refused', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('d0', 'claude', '/workspace/demo', 'Root');
    sessionsDb.createSession('d1', 'claude', '/workspace/demo', 'D1', undefined, undefined, null, 'user', 'd0');
    sessionsDb.createSession('d2', 'claude', '/workspace/demo', 'D2', undefined, undefined, null, 'user', 'd1');
    sessionsDb.createSession('d3', 'claude', '/workspace/demo', 'D3', undefined, undefined, null, 'user', 'd2');
    const { fork, calls } = fakeFork();
    const base = { parentOptions: {}, userId: null, runHeadless: async () => undefined, isSessionActive: () => false, fork };

    const fromD2 = await createDerivedSessionHandlers({ ...base, getCurrentSessionId: () => 'd2' })
      .createDerivedSession({ title: 'ok' });
    assert.equal(parse(fromD2).depth, 3);

    const fromD3 = await createDerivedSessionHandlers({ ...base, getCurrentSessionId: () => 'd3' })
      .createDerivedSession({ title: 'too deep' });
    assert.equal(fromD3.isError, true);
    assert.match(fromD3.content[0].text, /levels deep/);
    assert.equal(calls.length, 1);
  });
});

test('a task starts a headless run in the derived session with inherited options', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('root', 'claude', '/workspace/demo', 'Root');
    const { fork, calls } = fakeFork();
    const runs: Array<{ prompt: string; options: Record<string, unknown>; writerSession: string | null }> = [];
    let resolveRun: () => void = () => {};
    const runDone = new Promise<void>((resolve) => { resolveRun = resolve; });

    const handlers = createDerivedSessionHandlers({
      getCurrentSessionId: () => 'root',
      parentOptions: { permissionMode: 'acceptEdits', model: 'sonnet', cwd: '/elsewhere', images: ['x'] },
      userId: 7,
      runHeadless: async (prompt, options, writer) => {
        runs.push({ prompt, options, writerSession: writer.getSessionId() });
        resolveRun();
      },
      isSessionActive: () => false,
      fork,
    });

    const result = parse(await handlers.createDerivedSession({ title: 'Check tests', task: 'Run the test suite' }));
    await runDone;

    assert.equal(calls[0].sessionId, 'root');
    assert.equal(calls[0].title, 'Check tests');
    assert.equal(result.taskStarted, true);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].writerSession, 'child-1');
    assert.match(runs[0].prompt, /Run the test suite$/);
    assert.deepEqual(runs[0].options, {
      permissionMode: 'acceptEdits',
      model: 'sonnet',
      cwd: '/workspace/demo',
      sessionId: 'child-1',
      sessionSummary: 'Check tests',
    });
  });
});

test('status is only available for descendants of the current session', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('root', 'claude', '/workspace/demo', 'Root');
    sessionsDb.createSession('child', 'claude', '/workspace/demo', 'Child', undefined, undefined, null, 'user', 'root');
    sessionsDb.createSession('stranger', 'claude', '/workspace/demo', 'Stranger');

    const handlers = createDerivedSessionHandlers({
      getCurrentSessionId: () => 'root',
      parentOptions: {},
      userId: null,
      runHeadless: async () => undefined,
      isSessionActive: (id) => id === 'child',
      getSessionMessages: async () => [{ type: 'assistant', message: { content: [{ type: 'text', text: 'All green' }] } }],
    });

    const status = parse(await handlers.getDerivedSessionStatus({ sessionId: 'child' }));
    assert.deepEqual(status, { sessionId: 'child', title: 'Child', status: 'running', lastAssistantText: 'All green' });

    const refused = await handlers.getDerivedSessionStatus({ sessionId: 'stranger' });
    assert.equal(refused.isError, true);
  });
});
