import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { UNKNOWN_RUN_OPTIONS_MESSAGE } from '@/modules/providers/list/claude/claude-derived-sessions-mcp.js';
import { sanitizeChatRunOptions } from '@/modules/websocket/services/shell-websocket.service.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  answerHook,
  configureTerminalLinkOpener,
  issueSessionToken,
  prepareTerminalLaunch,
  resetDerivedSessionsHttpForTests,
  startDerivedSessionsHttpServer,
  stopDerivedSessionsHttpServer,
  terminalLaunchFingerprint,
} from '@/modules/providers/services/derived-sessions-http.service.js';
import {
  checkShellQueuesForTests,
  configureDerivedSessionsRuntime,
  configureShellPresence,
  deliverDerivedReport,
  getPendingShellReportCount,
  releaseShellReports,
  rememberSessionRunOptions,
  resolveChatRunOptions,
  resetDerivedSessionsStateForTests,
  sendToParentSession,
  SHELL_WAKE_PROMPT,
  MAX_RELAY_TURNS_PER_WINDOW,
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

/** The conversation ran in the Chat tab with these settings. */
const ranInChat = (sessionId: string, extra: Record<string, unknown> = {}) =>
  rememberSessionRunOptions(sessionId, { permissionMode: 'bypassPermissions', toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false }, cwd: PROJECT, ...extra });

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
    // No kept-alive connection a CLI could reuse just as it is closed.
    assert.equal(ok.headers.get('connection'), 'close');
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
    ranInChat('root');
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
    ranInChat('root');
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
    for (const file of [launch.mcpConfigPath, launch.settingsPath, path.join(path.dirname(launch.mcpConfigPath), 'link-headers')]) {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    assert.equal((await stat(launch.browserPath)).mode & 0o777, 0o700);
    assert.equal((await stat(path.dirname(launch.mcpConfigPath))).mode & 0o777, 0o700);

    const mcp = JSON.parse(await readFile(launch.mcpConfigPath, 'utf8'));
    const server = mcp.mcpServers['derived-sessions'];
    assert.equal(server.url, `http://127.0.0.1:${port}/mcp`);
    const token = server.headers.Authorization.replace('Bearer ', '');
    assert.ok(!launch.mcpConfigPath.includes(token) && !launch.settingsPath.includes(token));

    // The BROWSER script reads the token from its private file, never holds it.
    assert.ok(!(await readFile(launch.browserPath, 'utf8')).includes(token));

    const settings = JSON.parse(await readFile(launch.settingsPath, 'utf8'));
    assert.deepEqual(Object.keys(settings.hooks).sort(), ['PostToolUse', 'Stop', 'UserPromptSubmit']);
    assert.ok(settings.permissions.allow.includes('mcp__derived-sessions__create_derived_session'));

    assert.equal(prepareTerminalLaunch('bad id; rm -rf /', 3), null);
  });
});

test('a terminal derived session runs with the permission mode and tools the conversation uses in Chat', async () => {
  await withServer(async ({ base }) => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main');
    const runtime = fakeRuntime();
    ranInChat('root', { model: 'opus', effort: 'high' });

    const client = await connect(base, authFor('root'));
    const created = parseTool(await client.callTool({ name: 'create_derived_session', arguments: { title: 'Side', task: 'Do X' } }));
    assert.equal(runtime.runs[0].options.newSessionId, created.sessionId);
    assert.equal(runtime.runs[0].options.permissionMode, 'bypassPermissions');
    assert.deepEqual(runtime.runs[0].options.toolsSettings, { allowedTools: [], disallowedTools: [], skipPermissions: false });
    assert.equal(runtime.runs[0].options.model, 'opus');
    await client.close();
  });
});

test('unknown Chat settings: the terminal refuses to create a derived session instead of starting one that hangs', async () => {
  await withServer(async ({ base }) => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main');
    const runtime = fakeRuntime();

    const client = await connect(base, authFor('root'));
    const refused: any = await client.callTool({ name: 'create_derived_session', arguments: { title: 'Side', task: 'Do X' } });
    assert.equal(refused.isError, true);
    assert.equal(refused.content[0].text, UNKNOWN_RUN_OPTIONS_MESSAGE);
    assert.equal(runtime.runs.length, 0);
    assert.equal(sessionsDb.getChildSessions('root').length, 0, 'no session was created');

    // A model alone does not say how tools are approved.
    rememberSessionRunOptions('root', { model: 'opus', cwd: PROJECT });
    const stillRefused: any = await client.callTool({ name: 'create_derived_session', arguments: { title: 'Side', task: 'Do X' } });
    assert.equal(stillRefused.isError, true);
    await client.close();
  });
});

test('the Chat settings survive a restart and fall back to the project', async () => {
  await withServer(async () => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main');
    sessionsDb.createSession('sibling', 'claude', PROJECT, 'Other conversation in the project');
    sessionsDb.createSession('elsewhere', 'claude', '/tmp/another-project', 'Other project');
    fakeRuntime();
    ranInChat('sibling');

    // Restart: the in-memory copy is gone, the database keeps it.
    resetDerivedSessionsStateForTests();
    assert.deepEqual(resolveChatRunOptions('sibling'), {
      source: 'session',
      options: { permissionMode: 'bypassPermissions', toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false } },
    });
    // A conversation that never ran in Chat uses its project's last Chat run.
    assert.equal(resolveChatRunOptions('root')?.source, 'project');
    assert.equal(resolveChatRunOptions('root')?.options.permissionMode, 'bypassPermissions');
    // Another project knows nothing.
    assert.equal(resolveChatRunOptions('elsewhere'), null);

    // The conversation's own choice wins over the project's.
    rememberSessionRunOptions('root', { permissionMode: 'acceptEdits', cwd: PROJECT });
    resetDerivedSessionsStateForTests();
    assert.equal(resolveChatRunOptions('root')?.options.permissionMode, 'acceptEdits');
  });
});

test('unattended runs are not taken as the Chat settings', async () => {
  await withServer(async () => {
    sessionsDb.createSession('api', 'claude', '/tmp/unattended-project', 'Agent API run');
    rememberSessionRunOptions('api', { permissionMode: 'bypassPermissions', cwd: '/tmp/unattended-project', unattended: true });
    resetDerivedSessionsStateForTests();
    assert.equal(resolveChatRunOptions('api'), null);
  });
});

test('the Shell tab keeps only valid Chat settings from the browser', () => {
  assert.deepEqual(
    sanitizeChatRunOptions({ permissionMode: 'bypassPermissions', toolsSettings: { allowedTools: ['Bash'], skipPermissions: true, extra: 'x' }, cwd: '/etc' }),
    { permissionMode: 'bypassPermissions', toolsSettings: { allowedTools: ['Bash'], skipPermissions: true } },
  );
  assert.equal(sanitizeChatRunOptions({ permissionMode: 'rootMode' }), null);
  assert.equal(sanitizeChatRunOptions('bypassPermissions'), null);
  assert.equal(sanitizeChatRunOptions({ toolsSettings: { allowedTools: [1, 2] } }), null);
});

test('the launch fingerprint is the same for every terminal and changes with what the CLI reads at start', async () => {
  let first: string | null = null;
  await withServer(async () => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main');
    first = terminalLaunchFingerprint();
    assert.match(first ?? '', /^[0-9a-f]{12}$/);
    // Per-terminal tokens are not part of it.
    prepareTerminalLaunch('root', 1);
    prepareTerminalLaunch('root', 1);
    assert.equal(terminalLaunchFingerprint(), first);
  });
  // Off: no tools, nothing to compare.
  assert.equal(terminalLaunchFingerprint(), null);
  // Another address in the config files (here: another port) is another contract.
  await withServer(async () => {
    assert.notEqual(terminalLaunchFingerprint(), first);
  });
});

const formPost = (base: string, headers: Record<string, string>, url: string) =>
  fetch(`${base}/open-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ url }).toString(),
  });

test('a link the terminal CLI opens goes to the browser tab of that conversation only', async () => {
  await withServer(async ({ base }) => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main');
    sessionsDb.createSession('other', 'claude', PROJECT, 'Other');
    const opened: Array<[string, string]> = [];
    let tabs = 1;
    configureTerminalLinkOpener((sessionId, url) => {
      opened.push([sessionId, url]);
      return tabs;
    });

    // Same guard as the tools: no token, another conversation's token.
    assert.equal((await formPost(base, { 'X-Ccui-Session': 'root' }, 'https://example.com/')).status, 401);
    assert.equal((await formPost(base, authFor('root', issueSessionToken('other')), 'https://example.com/')).status, 403);
    // Only web links.
    assert.equal((await formPost(base, authFor('root'), 'javascript:alert(1)')).status, 400);
    assert.equal((await formPost(base, authFor('root'), 'file:///etc/passwd')).status, 400);
    assert.deepEqual(opened, []);

    const ok = await formPost(base, authFor('root'), 'https://github.com/a/b/issues/10');
    assert.equal(ok.status, 200);
    assert.deepEqual(opened, [['root', 'https://github.com/a/b/issues/10']]);

    // No tab shows the terminal: a failure, so the CLI prints the link instead.
    tabs = 0;
    assert.equal((await formPost(base, authFor('root'), 'https://example.com/')).status, 409);
  });
});

test('the BROWSER script the CLI runs delivers the link and fails when nobody gets it', async () => {
  await withServer(async () => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main');
    const launch = prepareTerminalLaunch('root', 1);
    assert.ok(launch);
    const opened: string[] = [];
    let tabs = 1;
    configureTerminalLinkOpener((_sessionId, url) => {
      opened.push(url);
      return tabs;
    });
    const run = promisify(execFile);
    const link = 'https://example.com/a b?x=1&y=ą';
    await run(launch.browserPath, [link]);
    assert.deepEqual(opened, [new URL(link).href]);

    tabs = 0;
    await assert.rejects(run(launch.browserPath, ['https://example.com/']));
    await assert.rejects(run(launch.browserPath, []));
  });
});

test('an idle terminal is woken once for waiting reports, retried later, and stays within the relay limit', async () => {
  await withServer(async () => {
    sessionsDb.createSession('root', 'claude', PROJECT, 'Main');
    sessionsDb.createSession('kid', 'claude', PROJECT, 'Kid', undefined, undefined, null, 'user', 'root');
    let now = 1_000_000;
    configureDerivedSessionsRuntime({
      runHeadless: async () => ({ status: 'completed', sessionId: 'x', resultText: '' }),
      isSessionActive: () => false,
      steer: () => ({ ok: false, reason: 'no_active_turn' }),
      getSessionMessages: async () => [],
      now: () => now,
    });
    let idle = false;
    const wakes: Array<{ sessionId: string; prompt: string }> = [];
    configureShellPresence({
      isOpen: (id) => id === 'root',
      wake: (sessionId, prompt) => {
        if (!idle) return false;
        wakes.push({ sessionId, prompt });
        return true;
      },
    });
    const report = (text: string) => deliverDerivedReport({ parentSessionId: 'root', childSessionId: 'kid', childTitle: 'Kid', status: 'completed', text });

    // Busy (or the user typing): nothing typed, the report waits.
    assert.equal((await report('First')).mode, 'queued');
    assert.equal(wakes.length, 0);
    // The periodic check finds the terminal idle: woken once.
    idle = true;
    checkShellQueuesForTests();
    assert.deepEqual(wakes, [{ sessionId: 'root', prompt: SHELL_WAKE_PROMPT }]);
    // A second report before the woken turn took the first: no second prompt.
    await report('Second');
    checkShellQueuesForTests();
    assert.equal(wakes.length, 1);

    // The woken turn's prompt hook takes both, once.
    const taken: any = answerHook('user-prompt-submit', 'root', { session_id: 'root' });
    assert.match(taken.hookSpecificOutput.additionalContext, /First[\s\S]*Second/);
    assert.equal(getPendingShellReportCount('root'), 0);

    // The next report wakes it again at once.
    now += 1000;
    await report('Third');
    assert.equal(wakes.length, 2);
    answerHook('user-prompt-submit', 'root', { session_id: 'root' });

    // A woken turn that never took its reports: tried again after a minute.
    now += 1000;
    await report('Fourth');
    assert.equal(wakes.length, 3);
    now += 30_000;
    checkShellQueuesForTests();
    assert.equal(wakes.length, 3);
    now += 31_000;
    checkShellQueuesForTests();
    assert.equal(wakes.length, 4);
    answerHook('user-prompt-submit', 'root', { session_id: 'root' });

    // Wake-ups are report-started turns: the relay limit stops them, and the
    // reports wait for the user's next message.
    for (let i = wakes.length; i < MAX_RELAY_TURNS_PER_WINDOW; i++) {
      now += 1000;
      await report(`R${i}`);
      answerHook('user-prompt-submit', 'root', { session_id: 'root' });
    }
    assert.equal(wakes.length, MAX_RELAY_TURNS_PER_WINDOW);
    now += 1000;
    await report('Over the limit');
    checkShellQueuesForTests();
    assert.equal(wakes.length, MAX_RELAY_TURNS_PER_WINDOW);
    assert.equal(getPendingShellReportCount('root'), 1);
  });
});
