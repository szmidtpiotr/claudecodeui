import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  answerHook,
  issueSessionToken,
  prepareTerminalLaunch,
  resetDerivedSessionsHttpForTests,
  startDerivedSessionsHttpServer,
  stopDerivedSessionsHttpServer,
} from '@/modules/providers/services/derived-sessions-http.service.js';
import {
  checkShellQueuesForTests,
  configureDerivedSessionsRuntime,
  configureShellPresence,
  deliverDerivedReport,
  getPendingShellReportCount,
  releaseShellReports,
  resetDerivedSessionsStateForTests,
  sendToParentSession,
  waitForDeliveries,
  type HeadlessRunResult,
} from '@/modules/providers/services/derived-sessions.service.js';

const PROJECT = '/tmp/derived-http-project';

type Env = { dir: string; port: number; base: string };

async function withServer(run: (env: Env) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'derived-http-'));
  const saved = {
    db: process.env.DATABASE_PATH,
    secret: process.env.DERIVED_SESSIONS_SECRET_FILE,
    config: process.env.DERIVED_SESSIONS_CONFIG_DIR,
  };
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  process.env.DERIVED_SESSIONS_SECRET_FILE = path.join(dir, 'secret');
  process.env.DERIVED_SESSIONS_CONFIG_DIR = path.join(dir, 'shell-mcp');
  await initializeDatabase();
  resetDerivedSessionsStateForTests();
  resetDerivedSessionsHttpForTests();
  const port = await startDerivedSessionsHttpServer(0);
  assert.ok(port);
  try {
    await run({ dir, port, base: `http://127.0.0.1:${port}` });
  } finally {
    await stopDerivedSessionsHttpServer();
    configureDerivedSessionsRuntime(null);
    resetDerivedSessionsStateForTests();
    resetDerivedSessionsHttpForTests();
    closeConnection();
    for (const [key, value] of [['DATABASE_PATH', saved.db], ['DERIVED_SESSIONS_SECRET_FILE', saved.secret], ['DERIVED_SESSIONS_CONFIG_DIR', saved.config]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

/** A runner whose headless turns end only when the test says so. */
function fakeRuntime() {
  const active = new Set<string>();
  const runs: Array<{ prompt: string; options: Record<string, any>; finish: () => void }> = [];
  const steers: Array<{ sessionId: string; content: string }> = [];
  configureDerivedSessionsRuntime({
    runHeadless: (prompt, options) => new Promise<HeadlessRunResult>((resolve) => {
      const id = String(options.sessionId ?? options.newSessionId);
      active.add(id);
      runs.push({
        prompt,
        options,
        finish: () => { active.delete(id); resolve({ status: 'completed', sessionId: id, resultText: 'done' }); },
      });
    }),
    isSessionActive: (id) => active.has(id),
    steer: (sessionId, _messageId, content) => {
      if (!active.has(sessionId)) return { ok: false, reason: 'no_active_turn' };
      steers.push({ sessionId, content });
      return { ok: true };
    },
    getSessionMessages: async () => [],
  });
  return { active, runs, steers };
}

/** Parents "open in a terminal", plus the pending-count notifications. */
function fakeShell(open: string[]) {
  const openSet = new Set(open);
  const notices: Array<{ sessionId: string; count: number }> = [];
  configureShellPresence({
    isOpen: (id) => openSet.has(id),
    onPendingChanged: (sessionId, count) => notices.push({ sessionId, count }),
  });
  return { openSet, notices };
}

async function connect(base: string, headers: Record<string, string>) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  return client;
}

const authFor = (sessionId: string, token = issueSessionToken(sessionId)) => ({
  Authorization: `Bearer ${token}`,
  'X-Ccui-Session': sessionId,
});

async function rawPost(base: string, route: string, headers: Record<string, string>, body: unknown = {}) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
};

const parseTool = (result: any) => JSON.parse(result.content[0].text);

test('requests without a valid token for the session are refused', async () => {
  await withServer(async ({ base }) => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main');
    sessionsDb.createSession('other', 'claude', PROJECT, 'Other');

    // No token at all.
    const none = await rawPost(base, '/mcp', { 'X-Ccui-Session': 'root' }, INIT);
    assert.equal(none.status, 401);

    // A made-up token.
    const forged = await rawPost(base, '/mcp', authFor('root', 'AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'), INIT);
    assert.equal(forged.status, 403);

    // A real token, but issued for another conversation.
    const otherToken = issueSessionToken('other');
    const crossed = await rawPost(base, '/mcp', authFor('root', otherToken), INIT);
    assert.equal(crossed.status, 403);

    // The hooks are guarded the same way.
    assert.equal((await rawPost(base, '/hooks/stop', { 'X-Ccui-Session': 'root' })).status, 401);
    assert.equal((await rawPost(base, '/hooks/stop', authFor('root', otherToken))).status, 403);

    // The right token for the session passes.
    const ok = await rawPost(base, '/mcp', authFor('root'), INIT);
    assert.equal(ok.status, 200);
  });
});

test('the terminal gets the same tools as the chat; send_to_parent_session only with a parent', async () => {
  await withServer(async ({ base }) => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main');
    sessionsDb.createSession('child', 'claude', PROJECT, 'Child', undefined, undefined, null, 'user', 'root');
    fakeRuntime();

    const rootClient = await connect(base, authFor('root'));
    const rootTools = (await rootClient.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(rootTools, ['create_derived_session', 'get_derived_session_status', 'list_derived_sessions', 'send_to_derived_session']);
    await rootClient.close();

    const childClient = await connect(base, authFor('child'));
    const childTools = (await childClient.listTools()).tools.map((t) => t.name);
    assert.ok(childTools.includes('send_to_parent_session'));
    await childClient.close();
  });
});

test('create, status, list and send work over HTTP and stay within the session tree', async () => {
  await withServer(async ({ base }) => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main');
    sessionsDb.createSession('stranger', 'claude', PROJECT, 'Unrelated');
    const runtime = fakeRuntime();
    const client = await connect(base, authFor('root'));

    const created = parseTool(await client.callTool({ name: 'create_derived_session', arguments: { title: 'Side task', task: 'Do X' } }));
    assert.equal(created.parentSessionId, 'root');
    assert.equal(runtime.runs.length, 1);
    assert.equal(sessionsDb.getSessionById(created.sessionId)?.parent_session_id, 'root');

    const status = parseTool(await client.callTool({ name: 'get_derived_session_status', arguments: { sessionId: created.sessionId } }));
    assert.equal(status.status, 'running');

    const listed = parseTool(await client.callTool({ name: 'list_derived_sessions', arguments: {} }));
    assert.deepEqual(listed.derivedSessions.map((s: any) => s.sessionId), [created.sessionId]);

    const sent = parseTool(await client.callTool({ name: 'send_to_derived_session', arguments: { sessionId: created.sessionId, message: 'Also Y' } }));
    assert.equal(sent.delivery, 'into_running_turn');

    // Not a descendant: refused, as in the chat.
    const foreign: any = await client.callTool({ name: 'get_derived_session_status', arguments: { sessionId: 'stranger' } });
    assert.equal(foreign.isError, true);
    await client.close();
  });
});

test('the per-turn limit spans the requests of a turn and starts over with the next prompt', async () => {
  await withServer(async ({ base }) => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main');
    fakeRuntime();
    const client = await connect(base, authFor('root'));
    const create = (n: number) => client.callTool({ name: 'create_derived_session', arguments: { title: `T${n}`, task: 'x' } });

    for (let n = 0; n < 5; n += 1) {
      const result: any = await create(n);
      assert.notEqual(result.isError, true, `creation ${n + 1} should pass`);
    }
    const sixth: any = await create(5);
    assert.equal(sixth.isError, true);
    assert.match(sixth.content[0].text, /5/);

    // The user's next message is a new turn.
    const hook = await rawPost(base, '/hooks/user-prompt-submit', authFor('root'), { session_id: 'root', hook_event_name: 'UserPromptSubmit' });
    assert.equal(hook.status, 200);
    const afterTurn: any = await create(6);
    assert.notEqual(afterTurn.isError, true);
    await client.close();
  });
});

test('a report for a parent open in a terminal waits and is handed over exactly once', async () => {
  await withServer(async () => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main');
    sessionsDb.createSession('kid', 'claude', PROJECT, 'Kid', undefined, undefined, null, 'user', 'root');
    const runtime = fakeRuntime();
    const shell = fakeShell(['root']);

    const delivery = await deliverDerivedReport({ parentSessionId: 'root', childSessionId: 'kid', childTitle: 'Kid', status: 'completed', text: 'All done' });
    assert.equal(delivery.mode, 'queued');
    // No second CLI started on the parent's conversation.
    assert.equal(runtime.runs.length, 0);
    assert.equal(getPendingShellReportCount('root'), 1);
    assert.deepEqual(shell.notices.at(-1), { sessionId: 'root', count: 1 });

    // A subagent's tool call does not take it.
    assert.deepEqual(answerHook('post-tool-use', 'root', { session_id: 'root', agent_id: 'sub-1' }), {});
    assert.equal(getPendingShellReportCount('root'), 1);

    // The main turn's next tool call does, once.
    const first: any = answerHook('post-tool-use', 'root', { session_id: 'root' });
    assert.equal(first.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(first.hookSpecificOutput.additionalContext, /All done/);
    assert.deepEqual(answerHook('post-tool-use', 'root', { session_id: 'root' }), {});
    assert.deepEqual(answerHook('user-prompt-submit', 'root', { session_id: 'root' }), {});
    assert.equal(getPendingShellReportCount('root'), 0);
    assert.deepEqual(shell.notices.at(-1), { sessionId: 'root', count: 0 });
  });
});

test('reports waiting at the end of a terminal turn make the parent go on (Stop hook)', async () => {
  await withServer(async () => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main');
    sessionsDb.createSession('kid', 'claude', PROJECT, 'Kid', undefined, undefined, null, 'user', 'root');
    fakeRuntime();
    fakeShell(['root']);

    await deliverDerivedReport({ parentSessionId: 'root', childSessionId: 'kid', childTitle: 'Kid', status: 'completed', text: 'Result A' });
    await deliverDerivedReport({ parentSessionId: 'root', childSessionId: 'kid', childTitle: 'Kid', status: 'completed', text: 'Result B' });

    const stop: any = answerHook('stop', 'root', { session_id: 'root', stop_hook_active: false });
    assert.equal(stop.decision, 'block');
    assert.match(stop.reason, /Result A[\s\S]*Result B/);
    assert.deepEqual(answerHook('stop', 'root', { session_id: 'root', stop_hook_active: true }), {});
  });
});

test('the user prompt hook hands waiting reports to the next terminal turn', async () => {
  await withServer(async () => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main');
    sessionsDb.createSession('kid', 'claude', PROJECT, 'Kid', undefined, undefined, null, 'user', 'root');
    fakeRuntime();
    fakeShell(['root']);

    const sent = await sendToParentSession({ childSessionId: 'kid', message: 'Need a decision', userId: 1 });
    assert.equal(sent.mode, 'queued');
    const hook: any = answerHook('user-prompt-submit', 'root', { session_id: 'root' });
    assert.equal(hook.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(hook.hookSpecificOutput.additionalContext, /Need a decision/);
  });
});

test('a chat turn on the parent picks up the waiting reports, once', async () => {
  await withServer(async () => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main');
    sessionsDb.createSession('kid', 'claude', PROJECT, 'Kid', undefined, undefined, null, 'user', 'root');
    const runtime = fakeRuntime();
    fakeShell(['root']);

    await deliverDerivedReport({ parentSessionId: 'root', childSessionId: 'kid', childTitle: 'Kid', status: 'completed', text: 'Chat gets this' });
    // The user opens the conversation in Chat and sends a message: the chat
    // run registers itself as active and releases the queue into its turn.
    runtime.active.add('root');
    releaseShellReports('root');
    await waitForDeliveries('root');

    assert.equal(runtime.steers.length, 1);
    assert.match(runtime.steers[0].content, /Chat gets this/);
    assert.equal(runtime.runs.length, 0);
    assert.equal(getPendingShellReportCount('root'), 0);
    // The terminal no longer gets it.
    assert.deepEqual(answerHook('user-prompt-submit', 'root', { session_id: 'root' }), {});
  });
});

test('reports waiting for a terminal that was closed are delivered the chat way', async () => {
  await withServer(async () => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main');
    sessionsDb.createSession('kid', 'claude', PROJECT, 'Kid', undefined, undefined, null, 'user', 'root');
    const runtime = fakeRuntime();
    const shell = fakeShell(['root']);

    await deliverDerivedReport({ parentSessionId: 'root', childSessionId: 'kid', childTitle: 'Kid', status: 'completed', text: 'Late report' });
    checkShellQueuesForTests();
    assert.equal(runtime.runs.length, 0, 'still open: keeps waiting');

    shell.openSet.delete('root');
    checkShellQueuesForTests();
    await waitForDeliveries('root');
    assert.equal(runtime.runs.length, 1);
    assert.match(runtime.runs[0].prompt, /Late report/);
    assert.equal(runtime.runs[0].options.sessionId, 'root');
    checkShellQueuesForTests();
    assert.equal(runtime.runs.length, 1, 'delivered once');
  });
});

test('a terminal that switched conversation (/clear) neither takes reports nor acts for the old one', async () => {
  await withServer(async ({ base }) => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main');
    sessionsDb.createSession('kid', 'claude', PROJECT, 'Kid', undefined, undefined, null, 'user', 'root');
    const runtime = fakeRuntime();
    fakeShell(['root']);
    await deliverDerivedReport({ parentSessionId: 'root', childSessionId: 'kid', childTitle: 'Kid', status: 'completed', text: 'For root' });

    assert.deepEqual(answerHook('user-prompt-submit', 'root', { session_id: 'brand-new-after-clear' }), {});
    assert.equal(getPendingShellReportCount('root'), 1);

    const client = await connect(base, authFor('root'));
    const refused: any = await client.callTool({ name: 'create_derived_session', arguments: { title: 'x', task: 'y' } });
    assert.equal(refused.isError, true);
    assert.equal(runtime.runs.length, 0);
    await client.close();
  });
});

test('terminal launch files are private and the token stays out of the command line', async () => {
  await withServer(async ({ port }) => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main');
    const launch = prepareTerminalLaunch('root', 3);
    assert.ok(launch);
    for (const file of [launch.mcpConfigPath, launch.settingsPath]) {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    assert.equal((await stat(path.dirname(launch.mcpConfigPath))).mode & 0o777, 0o700);

    const mcp = JSON.parse(await readFile(launch.mcpConfigPath, 'utf8'));
    const server = mcp.mcpServers['derived-sessions'];
    assert.equal(server.url, `http://127.0.0.1:${port}/mcp`);
    const token = server.headers.Authorization.replace('Bearer ', '');
    assert.ok(!launch.mcpConfigPath.includes(token) && !launch.settingsPath.includes(token));

    const settings = JSON.parse(await readFile(launch.settingsPath, 'utf8'));
    assert.deepEqual(Object.keys(settings.hooks).sort(), ['PostToolUse', 'Stop', 'UserPromptSubmit']);
    assert.ok(settings.permissions.allow.includes('mcp__derived-sessions__create_derived_session'));

    assert.equal(prepareTerminalLaunch('bad id; rm -rf /', 3), null);
  });
});
