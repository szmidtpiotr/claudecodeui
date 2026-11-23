import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { createDerivedSessionHandlers } from '@/modules/providers/list/claude/claude-derived-sessions-mcp.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import {
  configureDerivedSessionsRuntime,
  deliverDerivedReport,
  MAX_RELAY_TURNS_PER_WINDOW,
  rememberSessionRunOptions,
  resetDerivedSessionsStateForTests,
  waitForDeliveries,
  waitForDerivedTurn,
  type HeadlessRunResult,
} from '@/modules/providers/services/derived-sessions.service.js';

import {
  buildDerivedReportMessage,
  parseDerivedReportMessage,
  truncateReportText,
} from '../../../../shared/derivedSessionReport.js';

const PROJECT = '/workspace/demo';

async function withIsolatedDatabase(run: (dir: string) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'derived-mcp-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  resetDerivedSessionsStateForTests();
  try {
    await run(dir);
  } finally {
    configureDerivedSessionsRuntime(null);
    resetDerivedSessionsStateForTests();
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

type Run = {
  prompt: string;
  options: Record<string, any>;
  writerSession: string | null;
  finish: (result?: HeadlessRunResult) => void;
};

/**
 * A scripted runner: every headless run is recorded, marks its session active
 * while it lasts, and ends when the test calls `finish`.
 */
function fakeRuntime() {
  const active = new Set<string>();
  const runs: Run[] = [];
  const steers: Array<{ sessionId: string; messageId: string; content: string }> = [];
  let nextRun: (run: Run) => void = () => {};
  let clock = 0;

  configureDerivedSessionsRuntime({
    runHeadless: (prompt, options, writer) => new Promise<HeadlessRunResult>((resolve) => {
      const id = String(options.sessionId ?? options.newSessionId);
      active.add(id);
      const run: Run = {
        prompt,
        options,
        writerSession: writer.getSessionId(),
        finish: (result) => {
          active.delete(id);
          resolve(result ?? { status: 'completed', sessionId: id, resultText: 'done' });
        },
      };
      runs.push(run);
      nextRun(run);
    }),
    isSessionActive: (id) => active.has(id),
    steer: (sessionId, messageId, content) => {
      if (!active.has(sessionId)) return { ok: false, reason: 'no_active_turn' };
      steers.push({ sessionId, messageId, content });
      return { ok: true };
    },
    getSessionMessages: async () => [],
    now: () => clock,
  });

  return {
    active,
    runs,
    steers,
    advance: (ms: number) => { clock += ms; },
    /** Resolves with the next run that starts. */
    nextRun: () => new Promise<Run>((resolve) => { nextRun = resolve; }),
  };
}

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

function handlersFor(sessionId: string, parentOptions: Record<string, unknown> = {}) {
  return createDerivedSessionHandlers({ getCurrentSessionId: () => sessionId, parentOptions, userId: 7 });
}

test('create starts a fresh session with the task, records the parent and returns at once', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main work');
    const runtime = fakeRuntime();

    const result = parse(await handlersFor('root', { permissionMode: 'acceptEdits', model: 'haiku', effort: 'low', cwd: '/elsewhere', images: ['x'] })
      .createDerivedSession({ title: 'Check tests', task: 'Run the test suite' }));

    // Returned while the child's run is still going.
    assert.equal(runtime.runs.length, 1);
    assert.equal(result.state, 'running');
    assert.equal(result.parentSessionId, 'root');
    assert.equal(result.depth, 1);
    assert.match(result.sessionId, /^[0-9a-f-]{36}$/);

    const row = sessionsDb.getSessionById(result.sessionId);
    assert.equal(row?.parent_session_id, 'root');
    assert.equal(row?.custom_name, 'Check tests');
    assert.equal(row?.name_source, 'user');
    assert.equal(row?.project_path, PROJECT);

    const [run] = runtime.runs;
    assert.equal(run.writerSession, result.sessionId);
    // A new session under the recorded id — not a resume, not a fork.
    assert.equal(run.options.newSessionId, result.sessionId);
    assert.equal(run.options.sessionId, undefined);
    assert.equal(run.options.cwd, PROJECT);
    assert.equal(run.options.permissionMode, 'acceptEdits');
    assert.equal(run.options.model, 'haiku');
    assert.equal(run.options.effort, 'low');
    assert.equal(run.options.images, undefined);
    assert.match(run.prompt, /^\[Sesja pochodna\]/);
    assert.match(run.prompt, /„Main work” \(root\)/);
    assert.ok(run.prompt.endsWith('Run the test suite'));

    run.finish({ status: 'completed', sessionId: result.sessionId, resultText: 'ok' });
    await waitForDerivedTurn(result.sessionId);
  });
});

test('a task is required and limits (5 per turn, depth 3) still apply', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('d0', 'claude', PROJECT, 'Root');
    sessionsDb.createSession('d1', 'claude', PROJECT, 'D1', undefined, undefined, null, 'user', 'd0');
    sessionsDb.createSession('d2', 'claude', PROJECT, 'D2', undefined, undefined, null, 'user', 'd1');
    sessionsDb.createSession('d3', 'claude', PROJECT, 'D3', undefined, undefined, null, 'user', 'd2');
    const runtime = fakeRuntime();

    const empty = await handlersFor('d0').createDerivedSession({ title: 'x', task: '   ' });
    assert.equal(empty.isError, true);

    const handlers = handlersFor('d0');
    for (let index = 0; index < 5; index += 1) {
      assert.equal((await handlers.createDerivedSession({ title: `Side ${index}`, task: 'do it' })).isError, undefined);
    }
    const refused = await handlers.createDerivedSession({ title: 'One too many', task: 'do it' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /at most 5/);

    // A new turn (new server instance) has a fresh per-turn budget.
    assert.equal((await handlersFor('d0').createDerivedSession({ title: 'Next turn', task: 'do it' })).isError, undefined);

    assert.equal(parse(await handlersFor('d2').createDerivedSession({ title: 'ok', task: 'do it' })).depth, 3);
    const tooDeep = await handlersFor('d3').createDerivedSession({ title: 'too deep', task: 'do it' });
    assert.equal(tooDeep.isError, true);
    assert.match(tooDeep.content[0].text, /levels deep/);

    assert.equal(runtime.runs.length, 7);
    for (const run of runtime.runs) run.finish();
  });
});

test('a finished child reports to an idle parent by starting a new parent turn', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main work');
    const runtime = fakeRuntime();
    rememberSessionRunOptions('root', { model: 'haiku', permissionMode: 'default', effort: 'low' });

    const created = parse(await handlersFor('root', { model: 'haiku' }).createDerivedSession({ title: 'Child', task: 'reply with child-ok' }));
    const parentTurn = runtime.nextRun();
    runtime.runs[0].finish({ status: 'completed', sessionId: created.sessionId, resultText: 'child-ok' });

    const run = await parentTurn;
    assert.equal(run.options.sessionId, 'root');
    assert.equal(run.options.newSessionId, undefined);
    assert.equal(run.options.cwd, PROJECT);
    assert.equal(run.options.model, 'haiku');
    assert.match(run.options.promptUuid, /^[0-9a-f-]{36}$/);
    const report = parseDerivedReportMessage(run.prompt);
    assert.deepEqual(report, { childSessionId: created.sessionId, childTitle: 'Child', status: 'completed', body: 'child-ok' });
    assert.equal(runtime.steers.length, 0);

    // The parent was not itself created by a tool, so its answer goes nowhere.
    const parentDone = waitForDerivedTurn('root');
    run.finish();
    await parentDone;
    assert.equal(runtime.runs.length, 2);
  });
});

test('a report reaches a running parent through steering, not a second turn', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main work');
    const runtime = fakeRuntime();
    runtime.active.add('root'); // the parent's own turn is running

    const created = parse(await handlersFor('root').createDerivedSession({ title: 'Child', task: 'x' }));
    runtime.runs[0].finish({ status: 'error', sessionId: created.sessionId, error: 'boom' });
    await waitForDerivedTurn(created.sessionId);

    assert.equal(runtime.runs.length, 1);
    assert.equal(runtime.steers.length, 1);
    assert.equal(runtime.steers[0].sessionId, 'root');
    const report = parseDerivedReportMessage(runtime.steers[0].content);
    assert.equal(report?.status, 'error');
    assert.equal(report?.body, 'boom');
  });
});

test('reports arriving together start one parent turn and join it', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main work');
    const runtime = fakeRuntime();
    sessionsDb.createSession('c1', 'claude', PROJECT, 'C1', undefined, undefined, null, 'user', 'root');
    sessionsDb.createSession('c2', 'claude', PROJECT, 'C2', undefined, undefined, null, 'user', 'root');

    const first = deliverDerivedReport({ parentSessionId: 'root', childSessionId: 'c1', childTitle: 'C1', status: 'completed', text: 'one' });
    const second = deliverDerivedReport({ parentSessionId: 'root', childSessionId: 'c2', childTitle: 'C2', status: 'completed', text: 'two' });
    assert.equal((await first).mode, 'new_turn');
    assert.equal((await second).mode, 'steered');
    assert.equal(runtime.runs.length, 1);
    runtime.runs[0].finish();
    await waitForDerivedTurn('root');
  });
});

test('report-started parent turns are capped so a parent and child cannot ping-pong forever', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main work');
    const runtime = fakeRuntime();
    const report = () => deliverDerivedReport({ parentSessionId: 'root', childSessionId: 'c', childTitle: 'C', status: 'completed', text: 't' });

    for (let index = 0; index < MAX_RELAY_TURNS_PER_WINDOW; index += 1) {
      assert.equal((await report()).mode, 'new_turn');
      runtime.runs.at(-1)!.finish();
      await waitForDerivedTurn('root');
    }
    assert.deepEqual(await report(), { mode: 'dropped', reason: 'relay_limit' });

    runtime.advance(11 * 60 * 1000);
    assert.equal((await report()).mode, 'new_turn');
    runtime.runs.at(-1)!.finish();
    await waitForDerivedTurn('root');
  });
});

test("a child's own derived sessions report to the child, which passes its answer on to its parent", async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main work');
    const runtime = fakeRuntime();

    const child = parse(await handlersFor('root').createDerivedSession({ title: 'Child', task: 'delegate' }));
    // While the child runs, its agent starts a grandchild.
    const grandchild = parse(await handlersFor(child.sessionId).createDerivedSession({ title: 'Grandchild', task: 'work' }));
    assert.equal(sessionsDb.getSessionById(grandchild.sessionId)?.parent_session_id, child.sessionId);

    // The child's first turn ends → report to root (a new root turn).
    let next = runtime.nextRun();
    runtime.runs[0].finish({ status: 'completed', sessionId: child.sessionId, resultText: 'waiting for grandchild' });
    const rootTurn = await next;
    assert.equal(rootTurn.options.sessionId, 'root');
    rootTurn.finish();
    await waitForDerivedTurn('root');

    // The grandchild ends → report to the child, not to root.
    next = runtime.nextRun();
    runtime.runs[1].finish({ status: 'completed', sessionId: grandchild.sessionId, resultText: 'grandchild-ok' });
    const childTurn = await next;
    assert.equal(childTurn.options.sessionId, child.sessionId);
    assert.equal(parseDerivedReportMessage(childTurn.prompt)?.childSessionId, grandchild.sessionId);

    // The child's report-started turn reports on up to root.
    next = runtime.nextRun();
    childTurn.finish({ status: 'completed', sessionId: child.sessionId, resultText: 'all done' });
    const rootAgain = await next;
    assert.equal(rootAgain.options.sessionId, 'root');
    assert.equal(parseDerivedReportMessage(rootAgain.prompt)?.body, 'all done');
    rootAgain.finish();
    await waitForDerivedTurn('root');
    await waitForDeliveries('root');
  });
});

test('list, status and send work only on derived sessions of the current session', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Root');
    sessionsDb.createSession('stranger', 'claude', PROJECT, 'Stranger');
    const runtime = fakeRuntime();
    const handlers = createDerivedSessionHandlers({
      getCurrentSessionId: () => 'root',
      parentOptions: { model: 'haiku' },
      userId: null,
      getSessionMessages: async () => [{ type: 'assistant', message: { content: [{ type: 'text', text: 'All green' }] } }],
    });

    const child = parse(await handlers.createDerivedSession({ title: 'Child', task: 'x' }));
    const listed = parse(await handlers.listDerivedSessions());
    assert.equal(listed.derivedSessions.length, 1);
    assert.equal(listed.derivedSessions[0].sessionId, child.sessionId);
    assert.equal(listed.derivedSessions[0].state, 'running');
    assert.equal(listed.derivedSessions[0].title, 'Child');

    const status = parse(await handlers.getDerivedSessionStatus({ sessionId: child.sessionId }));
    assert.deepEqual(status, { sessionId: child.sessionId, title: 'Child', status: 'running', lastAssistantText: 'All green' });

    // Running → the message joins the child's turn.
    const steered = parse(await handlers.sendToDerivedSession({ sessionId: child.sessionId, message: 'also do y' }));
    assert.equal(steered.delivery, 'into_running_turn');
    assert.equal(runtime.steers[0].sessionId, child.sessionId);

    // Idle → a new child turn that reports back to root.
    let next = runtime.nextRun();
    runtime.runs[0].finish();
    const rootTurn = await next;
    rootTurn.finish();
    await waitForDerivedTurn('root');
    assert.equal(parse(await handlers.listDerivedSessions()).derivedSessions[0].state, 'idle');

    next = runtime.nextRun();
    const resumed = parse(await handlers.sendToDerivedSession({ sessionId: child.sessionId, message: 'now z' }));
    assert.equal(resumed.delivery, 'new_turn');
    const childTurn = await next;
    assert.equal(childTurn.prompt, 'now z');
    assert.equal(childTurn.options.sessionId, child.sessionId);
    next = runtime.nextRun();
    childTurn.finish({ status: 'completed', sessionId: child.sessionId, resultText: 'z done' });
    const reportTurn = await next;
    assert.equal(reportTurn.options.sessionId, 'root');
    assert.equal(parseDerivedReportMessage(reportTurn.prompt)?.body, 'z done');
    reportTurn.finish();
    await waitForDerivedTurn('root');

    for (const call of [
      handlers.getDerivedSessionStatus({ sessionId: 'stranger' }),
      handlers.sendToDerivedSession({ sessionId: 'stranger', message: 'hi' }),
    ]) {
      assert.equal((await call).isError, true);
    }
  });
});

test('a transcript sync never clears a parent recorded in the database', async () => {
  await withIsolatedDatabase(async (dir) => {
    const childId = '11111111-2222-4333-8444-555555555555';
    sessionsDb.createSession('root', 'claude', PROJECT, 'Root');
    sessionsDb.createSession(childId, 'claude', PROJECT, 'Child', undefined, undefined, null, 'user', 'root');

    // A fresh derived session's transcript has no forkedFrom marker.
    const filePath = path.join(dir, `${childId}.jsonl`);
    await writeFile(filePath, [
      { type: 'queue-operation', operation: 'enqueue', sessionId: childId },
      { type: 'user', sessionId: childId, cwd: PROJECT, uuid: 'r1', message: { role: 'user', content: '[Sesja pochodna] task' } },
      { type: 'assistant', sessionId: childId, cwd: PROJECT, uuid: 'r2', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');

    assert.equal(await new ClaudeSessionSynchronizer().synchronizeFile(filePath), childId);
    const row = sessionsDb.getSessionById(childId);
    assert.equal(row?.parent_session_id, 'root');
    assert.equal(row?.custom_name, 'Child');
    assert.equal(row?.jsonl_path, filePath);
  });
});

test('report messages round-trip and long replies are cut with a note', () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const message = buildDerivedReportMessage({ childSessionId: id, childTitle: 'Tytuł „z” cudzysłowem', status: 'completed', text: 'line 1\nline 2' });
  assert.ok(message.startsWith(`[Sesja pochodna „Tytuł „z” cudzysłowem” (${id}) zakończyła turę]\n`));
  assert.deepEqual(parseDerivedReportMessage(message), {
    childSessionId: id,
    childTitle: 'Tytuł „z” cudzysłowem',
    status: 'completed',
    body: 'line 1\nline 2',
  });
  assert.equal(parseDerivedReportMessage('[Sesja pochodna] Uruchomiła cię…'), null);
  assert.equal(parseDerivedReportMessage('hello'), null);

  const cut = truncateReportText('x'.repeat(5000), 4000);
  assert.ok(cut.startsWith('x'.repeat(4000) + '…'));
  assert.match(cut, /obcięta do 4000 z 5000 znaków/);
  assert.equal(truncateReportText('  short  '), 'short');
});
