import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  abortClaudeSDKSession,
  createSteerTracker,
  listPendingSteers,
  queryClaudeSDK,
  setClaudeQueryImplForTests,
  steerClaudeSDKSession,
} from './claude-sdk.js';
import { handleSteerRequest } from './modules/websocket/services/chat-websocket.service.js';
import {
  ClaudeSessionsProvider,
  readSteeredMessageAttachment,
} from './modules/providers/list/claude/claude-sessions.provider.js';

/*
 * Steering: a message sent while a Claude turn runs is written into the CLI's
 * still-open stdin (priority `next`) and shown only when the CLI echoes it
 * (`--replay-user-messages`), i.e. when Claude actually read it. These drive
 * the real run loop against a scripted CLI.
 */

type AnyRecord = Record<string, any>;

const SESSION = 'steer-session-1';

/** Lets a test wait until the scripted CLI reaches a given point. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

type CliScript = (cli: {
  /** Next message written to the CLI's stdin, or null once stdin is closed. */
  read: () => Promise<AnyRecord | null>;
  /** Next stdin message if one is already waiting, without blocking. */
  readIfQueued: () => Promise<AnyRecord | null>;
}) => AsyncGenerator<AnyRecord>;

/**
 * Installs a fake SDK `query` that runs `script` as the CLI. Captures the
 * options the runner passed so tests can check them.
 */
function installFakeCli(script: CliScript) {
  const captured: { options: AnyRecord | null; interrupted: boolean; closed: boolean } = {
    options: null,
    interrupted: false,
    closed: false,
  };
  setClaudeQueryImplForTests(({ prompt, options }: { prompt: AsyncIterable<AnyRecord>; options: AnyRecord }) => {
    captured.options = options;
    const input = prompt[Symbol.asyncIterator]();
    // At most one read in flight; readIfQueued peeks by racing a tick.
    let inFlight: Promise<IteratorResult<AnyRecord>> | null = null;
    const pull = () => {
      inFlight = inFlight ?? input.next();
      return inFlight;
    };
    const read = async () => {
      const step = await pull();
      inFlight = null;
      return step.done ? null : step.value;
    };
    const readIfQueued = async () => {
      const tick = new Promise<'empty'>((r) => setImmediate(() => r('empty')));
      const winner = await Promise.race([pull(), tick]);
      if (winner === 'empty') {
        return null;
      }
      inFlight = null;
      return winner.done ? null : winner.value;
    };
    let stopRun: (() => void) | null = null;
    const stopped = new Promise<void>((r) => { stopRun = r; });
    const generator = script({ read, readIfQueued });
    const iterator = {
      async next() {
        // A stopped CLI ends its output stream.
        const step = await Promise.race([generator.next(), stopped.then(() => ({ done: true, value: undefined }))]);
        return step as IteratorResult<AnyRecord>;
      },
      [Symbol.asyncIterator]() { return this; },
      async interrupt() { captured.interrupted = true; stopRun?.(); },
      close() { captured.closed = true; stopRun?.(); },
    };
    return iterator;
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
    steerStatuses() { return sent.filter((m) => m.type === 'steer-status'); },
    userTexts() { return sent.filter((m) => m.kind === 'text' && m.role === 'user'); },
    completes() { return sent.filter((m) => m.kind === 'complete'); },
  };
}

const init = () => ({ type: 'system', subtype: 'init', session_id: SESSION });
const echo = (message: AnyRecord) => ({
  type: 'user',
  isReplay: true,
  uuid: message.uuid ?? crypto.randomUUID(),
  session_id: SESSION,
  parent_tool_use_id: null,
  message: message.message,
});
const toolUse = () => ({
  type: 'assistant',
  session_id: SESSION,
  parent_tool_use_id: null,
  message: { role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 5' } }] },
});
const result = (text = 'done') => ({ type: 'result', subtype: 'success', session_id: SESSION, result: text, modelUsage: {} });

const runOptions = { sessionId: SESSION, cwd: process.cwd(), unattended: true, model: 'haiku' };

test.afterEach(() => {
  setClaudeQueryImplForTests(null);
});

test('the runner asks the CLI to echo the messages it reads', async () => {
  const captured = installFakeCli(async function* ({ read }) {
    await read();
    yield init();
    yield result();
  });
  await queryClaudeSDK('hi', runOptions, fakeWriter());
  assert.deepEqual(captured.options?.extraArgs, { 'replay-user-messages': null });
});

test('a message steered mid-turn is shown where Claude read it, and nothing else echoed is', async () => {
  const atTool = deferred();
  const steered = deferred();
  const writer = fakeWriter();
  installFakeCli(async function* ({ read }) {
    const prompt = await read();
    yield init();
    yield echo(prompt!); // the turn's own prompt, already on screen
    yield toolUse();
    atTool.resolve();
    await steered.promise;
    const steer = await read();
    assert.equal(steer?.priority, 'next');
    yield echo(steer!);
    yield result();
  });

  const run = queryClaudeSDK('run sleep', runOptions, writer);
  await atTool.promise;
  const messageId = crypto.randomUUID();
  assert.deepEqual(steerClaudeSDKSession(SESSION, messageId, 'the color is purple'), { ok: true });
  assert.deepEqual(listPendingSteers(SESSION), [{ messageId, content: 'the color is purple' }]);
  steered.resolve();
  await run;

  const userTexts = writer.userTexts();
  assert.equal(userTexts.length, 1, 'only the steered echo becomes a user bubble');
  assert.equal(userTexts[0].id, messageId);
  assert.equal(userTexts[0].content, 'the color is purple');
  assert.deepEqual(writer.steerStatuses().map((m) => m.state), ['pending', 'delivered']);
  assert.equal(writer.completes().length, 1);
});

test('a steer after the turn has ended is refused, so the client sends it as the next turn', async () => {
  installFakeCli(async function* ({ read }) {
    await read();
    yield init();
    yield result();
  });
  await queryClaudeSDK('hi', runOptions, fakeWriter());
  const outcome = steerClaudeSDKSession(SESSION, crypto.randomUUID(), 'too late');
  assert.equal(outcome.ok, false);
});

test('a turn that ends before reading the steer keeps stdin open for the follow-up turn', async () => {
  const atTool = deferred();
  const steered = deferred();
  const writer = fakeWriter();
  let stdinOpenAfterResult = false;
  installFakeCli(async function* ({ read, readIfQueued }) {
    await read();
    yield init();
    atTool.resolve();
    await steered.promise;
    // The CLI has the steer queued but the turn finishes without a tool call.
    yield result('first');
    const steer = await readIfQueued() ?? await read();
    stdinOpenAfterResult = steer !== null;
    yield init();
    yield echo(steer!);
    yield result('second');
    // Stdin closes once the follow-up turn is over.
    assert.equal(await read(), null);
  });

  const run = queryClaudeSDK('quick question', runOptions, writer);
  await atTool.promise;
  const messageId = crypto.randomUUID();
  assert.equal(steerClaudeSDKSession(SESSION, messageId, 'one more thing').ok, true);
  steered.resolve();
  await run;

  assert.equal(stdinOpenAfterResult, true);
  assert.deepEqual(writer.userTexts().map((m) => m.id), [messageId]);
  assert.deepEqual(writer.steerStatuses().map((m) => m.state), ['pending', 'delivered']);
  assert.equal(writer.completes().length, 1, 'the run reports complete once, after the follow-up turn');
});

test('stopping the run with a steer unread hands its text back', async () => {
  const atTool = deferred();
  const writer = fakeWriter();
  installFakeCli(async function* ({ read }) {
    await read();
    yield init();
    yield toolUse();
    atTool.resolve();
    // Never reaches another tool call; the user stops the run.
    await new Promise(() => {});
  });

  const run = queryClaudeSDK('long task', runOptions, writer);
  await atTool.promise;
  const messageId = crypto.randomUUID();
  assert.equal(steerClaudeSDKSession(SESSION, messageId, 'actually, stop and do X').ok, true);
  assert.equal(await abortClaudeSDKSession(SESSION), true);
  await run;

  const dropped = writer.steerStatuses().filter((m) => m.state === 'dropped');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].messageId, messageId);
  assert.equal(dropped[0].content, 'actually, stop and do X');
  assert.equal(dropped[0].reason, 'aborted');
  assert.equal(writer.userTexts().length, 0);
});

test('steer tracker: pending until echoed, takePending empties it', () => {
  const tracker = createSteerTracker();
  tracker.add('a', 'first');
  tracker.add('b', 'second');
  assert.equal(tracker.isSteered('a'), true);
  assert.equal(tracker.isSteered('zzz'), false);
  assert.equal(tracker.markDelivered('a'), true);
  assert.equal(tracker.markDelivered('a'), false);
  assert.equal(tracker.pendingCount(), 1);
  assert.deepEqual(tracker.takePending(), [{ messageId: 'b', content: 'second' }]);
  assert.equal(tracker.pendingCount(), 0);
  // Still recognised as ours if the echo arrives late.
  assert.equal(tracker.isSteered('b'), true);
});

test('websocket steer request: accepted, refused, and a bad id replaced', () => {
  const replies: AnyRecord[] = [];
  const writer = { send: (m: unknown) => { replies.push(m as AnyRecord); } };
  const calls: unknown[][] = [];
  const goodId = crypto.randomUUID();

  handleSteerRequest({ sessionId: 's', messageId: goodId, command: '  hello  ' }, writer, {
    steerClaudeSDKSession: (...args) => { calls.push(args); return { ok: true }; },
  });
  assert.deepEqual(calls[0], ['s', goodId, 'hello']);
  assert.equal(replies[0].state, 'pending');

  handleSteerRequest({ sessionId: 's', messageId: 'not-a-uuid', command: 'x' }, writer, {
    steerClaudeSDKSession: (...args) => { calls.push(args); return { ok: false, reason: 'turn_ended' }; },
  });
  assert.match(String(calls[1][1]), /^[0-9a-f-]{36}$/);
  assert.equal(replies[1].state, 'rejected');
  assert.equal(replies[1].reason, 'turn_ended');
  assert.equal(replies[1].content, 'x');

  // The older /btw wire message carries `content`.
  handleSteerRequest({ type: 'btw-inject', sessionId: 's', content: 'btw text' }, writer, {
    steerClaudeSDKSession: () => ({ ok: true }),
  });
  assert.equal(replies[2].content, 'btw text');

  // Empty text is ignored.
  handleSteerRequest({ sessionId: 's', command: '   ' }, writer, { steerClaudeSDKSession: () => ({ ok: true }) });
  assert.equal(replies.length, 3);
});

test('history: a steered message read mid-turn renders as the user message under its sent id', () => {
  const sourceId = crypto.randomUUID();
  const row = {
    type: 'attachment',
    uuid: 'row-uuid',
    timestamp: '2026-11-23T14:40:28.700Z',
    sessionId: SESSION,
    attachment: { type: 'queued_command', prompt: 'the color is purple', source_uuid: sourceId, commandMode: 'prompt', timestamp: '2026-11-23T14:40:24.000Z' },
  };
  const provider = new ClaudeSessionsProvider();
  const normalized = provider.normalizeMessage(row, SESSION);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].id, sourceId);
  assert.equal(normalized[0].role, 'user');
  assert.equal(normalized[0].content, 'the color is purple');
  assert.equal(normalized[0].timestamp, '2026-11-23T14:40:28.700Z');
});

test('history: task-notification and non-prompt queued commands are not user messages', () => {
  const notification = { type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>x</task-notification>', commandMode: 'task-notification' } };
  const promptShaped = { type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>x</task-notification>' } };
  const other = { type: 'attachment', attachment: { type: 'edited_text_file', filename: 'a' } };
  assert.equal(readSteeredMessageAttachment(notification), null);
  assert.equal(readSteeredMessageAttachment(promptShaped), null);
  assert.equal(readSteeredMessageAttachment(other), null);
  assert.deepEqual(new ClaudeSessionsProvider().normalizeMessage(other, SESSION), []);
});

test('a derived run starts a new session under a chosen id, tags its prompt and returns the final reply', async () => {
  const newId = crypto.randomUUID();
  const promptUuid = crypto.randomUUID();
  let prompt: AnyRecord | null = null;
  const captured = installFakeCli(async function* ({ read }) {
    prompt = await read();
    // Steering works from the first message: the run is registered up front.
    assert.equal(steerClaudeSDKSession(newId, crypto.randomUUID(), 'early').ok, true);
    yield { type: 'system', subtype: 'init', session_id: newId };
    yield { type: 'result', subtype: 'success', session_id: newId, result: 'child-ok', modelUsage: {} };
    await read(); // the steered message, run as a follow-up turn
    yield { type: 'system', subtype: 'init', session_id: newId };
    yield { type: 'result', subtype: 'success', session_id: newId, result: 'child-ok 2', modelUsage: {} };
  });

  const outcome = await queryClaudeSDK(
    'task',
    { newSessionId: newId, promptUuid, cwd: process.cwd(), unattended: true, model: 'haiku' },
    fakeWriter(),
  );
  assert.equal(captured.options?.sessionId, newId);
  assert.equal(captured.options?.resume, undefined);
  assert.equal(prompt!.uuid, promptUuid);
  assert.deepEqual(outcome, { status: 'completed', sessionId: newId, resultText: 'child-ok 2' });
});

test('a failed run resolves with the error instead of throwing', async () => {
  installFakeCli(async function* ({ read }) {
    await read();
    yield init();
    throw new Error('cli crashed');
  });
  const outcome = (await queryClaudeSDK('hi', runOptions, fakeWriter())) as AnyRecord | undefined;
  assert.equal(outcome?.status, 'error');
  assert.equal(outcome?.sessionId, SESSION);
});
