import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  abortClaudeSDKSession,
  createBackgroundTaskTracker,
  isClaudeSDKSessionActive,
  queryClaudeSDK,
  setBackgroundHoldLimitsForTests,
  setClaudeQueryImplForTests,
  steerClaudeSDKSession,
} from './claude-sdk.js';

/*
 * Background work: once a turn's `result` arrives, closing the CLI's stdin
 * starts its print-mode wind-down, which kills background tasks still running
 * after CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS (10 min). The runner therefore
 * keeps stdin open while the CLI reports background tasks, and closes it once
 * they are gone and their notification turn is done.
 */

type AnyRecord = Record<string, any>;

const SESSION = 'background-session-1';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

type CliScript = (cli: {
  /** Next message written to the CLI's stdin, or null once stdin is closed. */
  read: () => Promise<AnyRecord | null>;
  /** Resolves with null once stdin is closed (never, while it stays open). */
  closed: () => Promise<null>;
}) => AsyncGenerator<AnyRecord>;

function installFakeCli(script: CliScript) {
  const captured = { interrupted: false, closed: false };
  setClaudeQueryImplForTests(({ prompt }: { prompt: AsyncIterable<AnyRecord> }) => {
    const input = prompt[Symbol.asyncIterator]();
    const read = async () => {
      const step = await input.next();
      return step.done ? null : step.value;
    };
    let stopRun: (() => void) | null = null;
    const stopped = new Promise<void>((r) => { stopRun = r; });
    const generator = script({
      read,
      closed: async () => {
        // Only valid once every queued message has been read.
        const step = await input.next();
        assert.equal(step.done, true, 'expected stdin to close, got another message');
        return null;
      },
    });
    return {
      async next() {
        const step = await Promise.race([generator.next(), stopped.then(() => ({ done: true, value: undefined }))]);
        return step as IteratorResult<AnyRecord>;
      },
      [Symbol.asyncIterator]() { return this; },
      async interrupt() { captured.interrupted = true; },
      close() { captured.closed = true; stopRun?.(); },
    };
  });
  return captured;
}

function fakeWriter() {
  const sent: AnyRecord[] = [];
  return {
    sent,
    userId: null,
    send(message: AnyRecord) { sent.push(message); },
    setSessionId() {},
    completes() { return sent.filter((m) => m.kind === 'complete'); },
    statuses() { return sent.filter((m) => m.kind === 'status' && m.text !== 'token_budget').map((m) => m.text); },
    assistantTexts() { return sent.filter((m) => m.kind === 'text' && m.role === 'assistant').map((m) => m.content); },
  };
}

const init = () => ({ type: 'system', subtype: 'init', session_id: SESSION });
const assistant = (text: string) => ({
  type: 'assistant',
  session_id: SESSION,
  parent_tool_use_id: null,
  message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text }] },
});
const result = (text = 'done') => ({ type: 'result', subtype: 'success', session_id: SESSION, result: text, modelUsage: {} });
const tasksChanged = (...ids: string[]) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  session_id: SESSION,
  tasks: ids.map((id) => ({ task_id: id, task_type: id.startsWith('a') ? 'local_agent' : 'local_bash' })),
});
const taskStarted = (id: string) => ({ type: 'system', subtype: 'task_started', session_id: SESSION, task_id: id, task_type: 'local_bash' });
const taskDone = (id: string, status = 'completed') => ({ type: 'system', subtype: 'task_notification', session_id: SESSION, task_id: id, status });
const echo = (message: AnyRecord) => ({
  type: 'user',
  isReplay: true,
  uuid: message.uuid,
  session_id: SESSION,
  parent_tool_use_id: null,
  message: message.message,
});

/**
 * Waits `ms` and checks that stdin neither closed nor delivered anything
 * meanwhile; returns the still-pending read.
 */
async function staysOpenFor(read: () => Promise<AnyRecord | null>, ms: number) {
  let settled = false;
  const pending = read().then((value) => { settled = true; return value; });
  await new Promise((r) => setTimeout(r, ms));
  assert.equal(settled, false, 'stdin closed (or a message arrived) while background tasks were running');
  return { next: pending };
}

// The runner's timers are unref'd (they must not hold a server open); a test
// waiting on one keeps the event loop alive itself.
async function withEventLoopHeld<T>(work: () => Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    return await work();
  } finally {
    clearInterval(keepAlive);
  }
}

const runOptions = { sessionId: SESSION, cwd: process.cwd(), unattended: true, model: 'haiku' };

test.afterEach(() => {
  setClaudeQueryImplForTests(null);
  setBackgroundHoldLimitsForTests(null);
});

test('stdin stays open while a background task runs, then closes after its notification turn', async () => {
  const writer = fakeWriter();
  let activeWhileHeld = false;
  installFakeCli(async function* ({ read }) {
    await read();
    yield init();
    yield tasksChanged('a1');
    yield taskStarted('a1');
    yield result('launched');
    // Held: stdin open long after the turn's result, the session still active.
    const nextRead = await staysOpenFor(read, 60);
    activeWhileHeld = isClaudeSDKSessionActive(SESSION);
    // The agent finishes; the CLI runs its notification as a follow-up turn.
    yield taskDone('a1');
    yield tasksChanged();
    yield init();
    yield assistant('the agent reported back');
    yield result('reported');
    assert.equal(await nextRead.next, null, 'stdin closes after the notification turn');
  });

  const outcome = await queryClaudeSDK('start agent', runOptions, writer) as unknown as AnyRecord;
  assert.equal(activeWhileHeld, true);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.resultText, 'reported');
  assert.deepEqual(writer.assistantTexts(), ['the agent reported back']);
  assert.deepEqual(writer.statuses(), ['Waiting for 1 background task']);
  assert.equal(writer.completes().length, 1);
});

test('a turn without background tasks closes stdin at its result, as before', async () => {
  installFakeCli(async function* ({ read, closed }) {
    await read();
    yield init();
    yield result();
    assert.equal(await closed(), null);
  });
  const outcome = await queryClaudeSDK('hi', runOptions, fakeWriter()) as unknown as AnyRecord;
  assert.equal(outcome.status, 'completed');
});

test('a task that ended mid-turn delays the close for its notification turn', async () => {
  const writer = fakeWriter();
  installFakeCli(async function* ({ read }) {
    await read();
    yield init();
    yield tasksChanged('b1');
    yield tasksChanged();
    yield result('first');
    // The notification turn starts right after the result; stdin must still be open.
    const nextRead = await staysOpenFor(read, 30);
    yield init();
    yield assistant('bash finished');
    yield result('second');
    assert.equal(await nextRead.next, null);
  });
  const outcome = await queryClaudeSDK('x', runOptions, writer) as unknown as AnyRecord;
  assert.equal(outcome.resultText, 'second');
  assert.equal(writer.completes().length, 1);
});

test('tasks that end without a follow-up turn close stdin after the grace', async () => {
  setBackgroundHoldLimitsForTests({ notificationGraceMs: 40 });
  installFakeCli(async function* ({ read }) {
    await read();
    yield init();
    yield tasksChanged('b1');
    yield result();
    yield tasksChanged();
    assert.equal(await read(), null);
  });
  const outcome = await withEventLoopHeld(() => queryClaudeSDK('x', runOptions, fakeWriter())) as unknown as AnyRecord;
  assert.equal(outcome.status, 'completed');
});

test('a message sent while held is steered into the live process and runs as a turn', async () => {
  const held = deferred();
  const writer = fakeWriter();
  let steeredPriority: string | undefined;
  installFakeCli(async function* ({ read }) {
    await read();
    yield init();
    yield tasksChanged('a1');
    yield result('launched');
    held.resolve();
    // The user's message arrives on the open stdin and starts a turn.
    const steer = await read();
    steeredPriority = steer?.priority;
    yield echo(steer!);
    yield init();
    yield assistant('answering while the agent works');
    yield result('answered');
    // Still held for the agent.
    const nextRead = await staysOpenFor(read, 40);
    yield tasksChanged();
    yield init();
    yield assistant('agent done');
    yield result('final');
    assert.equal(await nextRead.next, null);
  });

  const run = queryClaudeSDK('start agent', runOptions, writer);
  await held.promise;
  const messageId = crypto.randomUUID();
  assert.deepEqual(steerClaudeSDKSession(SESSION, messageId, 'how is it going?'), { ok: true });
  const outcome = await run as unknown as AnyRecord;

  assert.equal(steeredPriority, 'next');
  assert.equal(outcome.resultText, 'final');
  const states = writer.sent.filter((m) => m.type === 'steer-status').map((m) => m.state);
  assert.deepEqual(states, ['pending', 'delivered']);
  assert.deepEqual(writer.assistantTexts(), ['answering while the agent works', 'agent done']);
  assert.equal(writer.completes().length, 1);
});

test('Stop while held kills the CLI even though interrupt() answers', async () => {
  const held = deferred();
  const writer = fakeWriter();
  const captured = installFakeCli(async function* ({ read }) {
    await read();
    yield init();
    yield tasksChanged('a1', 'b2');
    yield result('launched');
    held.resolve();
    await new Promise(() => {});
  });

  const run = queryClaudeSDK('start agents', runOptions, writer);
  await held.promise;
  assert.equal(await abortClaudeSDKSession(SESSION), true);
  const outcome = await run as unknown as AnyRecord;

  assert.equal(captured.interrupted, true);
  assert.equal(captured.closed, true, 'the process is closed, taking its background tasks with it');
  assert.equal(outcome.status, 'aborted');
  assert.equal(Boolean(isClaudeSDKSessionActive(SESSION)), false);
});

test('the hold is capped: stdin closes when the limit passes with tasks still running', async () => {
  setBackgroundHoldLimitsForTests({ maxMs: 50 });
  const started = Date.now();
  let closedAfter = 0;
  installFakeCli(async function* ({ read }) {
    await read();
    yield init();
    yield tasksChanged('a1');
    yield result();
    assert.equal(await read(), null);
    closedAfter = Date.now() - started;
  });
  const outcome = await withEventLoopHeld(() => queryClaudeSDK('x', runOptions, fakeWriter())) as unknown as AnyRecord;
  assert.equal(outcome.status, 'completed');
  assert.ok(closedAfter >= 45, `closed after ${closedAfter} ms`);
});

test('background task tracker: list updates are authoritative, terminal events remove', () => {
  const tracker = createBackgroundTaskTracker();
  assert.deepEqual(tracker.observe(tasksChanged('a1', 'b1')), { changed: true, ended: 0 });
  assert.equal(tracker.size(), 2);
  assert.deepEqual(tracker.observe(tasksChanged('a1', 'b1')), { changed: false, ended: 0 });
  assert.deepEqual(tracker.observe({ type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { status: 'killed' } }), { changed: true, ended: 1 });
  assert.deepEqual(tracker.ids(), ['a1']);
  assert.deepEqual(tracker.observe(taskStarted('b9')), { changed: true, ended: 0 });
  assert.deepEqual(tracker.observe({ type: 'system', subtype: 'task_progress', task_id: 'a1' }), { changed: false, ended: 0 });
  assert.deepEqual(tracker.observe(tasksChanged()), { changed: true, ended: 2 });
  assert.equal(tracker.size(), 0);
  assert.deepEqual(tracker.observe(taskDone('a1')), { changed: false, ended: 0 });
  assert.deepEqual(tracker.observe(result()), { changed: false, ended: 0 });
});
