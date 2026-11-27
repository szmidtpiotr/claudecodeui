/**
 * The derived-sessions tools for a Claude CLI started in the Shell tab.
 *
 * The chat runs the CLI through the Agent SDK and hands it the tools as an
 * in-process MCP server (claude-derived-sessions-mcp.ts). A terminal runs a
 * plain `claude`, which only reads config files, so the same tool set is
 * served here over HTTP on 127.0.0.1 and the terminal's CLI is started with
 * `--mcp-config` / `--settings` files that point at it:
 *
 * - POST /mcp                         the MCP endpoint (stateless streamable HTTP);
 * - POST /hooks/user-prompt-submit    a new turn: resets the per-turn limit and
 *                                     hands over reports waiting for the session;
 * - POST /hooks/post-tool-use         hands waiting reports into the running turn
 *                                     (like steering in the chat);
 * - POST /hooks/stop                  the turn ends with reports waiting: the
 *                                     parent goes on with them (relay-limited).
 *
 * Every request carries the conversation id (X-Ccui-Session) and a token bound
 * to it (Authorization: Bearer). Tokens are HMACs of a secret kept in a 0600
 * file, so a terminal that outlived a restart of this server (tmux keeps it)
 * keeps working; they live only in 0600 files and are never logged nor put on
 * a command line.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import {
  createDerivedSessionHandlers,
  createDerivedSessionsMcpServer,
  DERIVED_SESSIONS_ALLOWED_TOOLS,
  SEND_TO_PARENT_TOOL,
  type DerivedSessionHandlers,
  type DerivedSessionsContext,
} from '@/modules/providers/list/claude/claude-derived-sessions-mcp.js';
import {
  getParentSessionId,
  resolveChatRunOptions,
  takeShellReports,
  type QueuedShellReport,
} from '@/modules/providers/services/derived-sessions.service.js';

export const SESSION_HEADER = 'x-ccui-session';
const MAX_BODY_BYTES = 1024 * 1024;
const SAFE_SESSION_ID = /^[a-zA-Z0-9_.\-:]{1,120}$/;

type TerminalState = {
  userId: string | number | null;
  /** Per-turn handlers (the creation counter); replaced when a turn starts. */
  handlers: DerivedSessionHandlers | null;
  /**
   * The conversation the terminal's CLI last reported in a hook. It differs
   * from the token's after /clear or /resume inside the terminal; the tools
   * then refuse rather than act for a conversation the token is not for.
   */
  reportedSessionId: string | null;
};

const terminals = new Map<string, TerminalState>();
let secret: Buffer | null = null;
let listening: { port: number; server: http.Server } | null = null;

// ---------------------------------------------------------------------------
// Tokens

function secretPath(): string {
  return process.env.DERIVED_SESSIONS_SECRET_FILE
    || path.join(os.homedir(), '.config', 'claudecodeui', 'derived-sessions-http.secret');
}

function loadSecret(): Buffer {
  if (secret) {
    return secret;
  }
  const file = secretPath();
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) {
      secret = Buffer.from(existing, 'hex');
      return secret;
    }
  } catch {
    // created below
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fresh = crypto.randomBytes(32);
  fs.writeFileSync(file, fresh.toString('hex'), { mode: 0o600 });
  secret = fresh;
  return secret;
}

function mac(sessionId: string, nonce: string): string {
  return crypto.createHmac('sha256', loadSecret()).update(`${sessionId}\n${nonce}`).digest('base64url');
}

/** A new token for one terminal start of a conversation. */
export function issueSessionToken(sessionId: string): string {
  const nonce = crypto.randomBytes(16).toString('base64url');
  return `${nonce}.${mac(sessionId, nonce)}`;
}

export type TokenCheck = { ok: true; sessionId: string } | { ok: false; status: 401 | 403; reason: string };

/** Checks the session header and the token that must have been issued for it. */
export function verifyRequestAuth(headers: http.IncomingHttpHeaders): TokenCheck {
  const auth = typeof headers.authorization === 'string' ? headers.authorization : '';
  const sessionId = typeof headers[SESSION_HEADER] === 'string' ? headers[SESSION_HEADER] as string : '';
  const match = /^Bearer ([A-Za-z0-9_-]{10,64})\.([A-Za-z0-9_-]{20,64})$/.exec(auth.trim());
  if (!match) {
    return { ok: false, status: 401, reason: 'missing or malformed token' };
  }
  if (!SAFE_SESSION_ID.test(sessionId)) {
    return { ok: false, status: 401, reason: 'missing session id' };
  }
  const expected = Buffer.from(mac(sessionId, match[1]));
  const given = Buffer.from(match[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    // Either a forged token or one issued for another conversation.
    return { ok: false, status: 403, reason: 'token is not valid for this session' };
  }
  return { ok: true, sessionId };
}

// ---------------------------------------------------------------------------
// Per-terminal state

function terminalFor(sessionId: string): TerminalState {
  let state = terminals.get(sessionId);
  if (!state) {
    state = { userId: null, handlers: null, reportedSessionId: null };
    terminals.set(sessionId, state);
  }
  return state;
}

/** Remembers who opened the terminal (notifications of derived turns). */
export function registerTerminalUser(sessionId: string, userId: string | number | null): void {
  terminalFor(sessionId).userId = userId;
}

function contextFor(sessionId: string, state: TerminalState): DerivedSessionsContext {
  return {
    getCurrentSessionId: () => sessionId,
    // A terminal has no per-run options of its own: a derived session runs
    // the way this conversation (else this project) runs in the chat, and is
    // refused when that is unknown.
    parentOptions: {},
    getParentOptions: () => resolveChatRunOptions(sessionId)?.options ?? null,
    userId: state.userId,
  };
}

function handlersFor(sessionId: string, state: TerminalState): DerivedSessionHandlers {
  if (!state.handlers) {
    state.handlers = createDerivedSessionHandlers(contextFor(sessionId, state));
  }
  return state.handlers;
}

/** A new turn of the terminal's conversation: the per-turn limit starts over. */
export function startTerminalTurn(sessionId: string): void {
  const state = terminalFor(sessionId);
  state.handlers = createDerivedSessionHandlers(contextFor(sessionId, state));
}

/** Clears all state; tests only. */
export function resetDerivedSessionsHttpForTests(): void {
  terminals.clear();
  secret = null;
}

// ---------------------------------------------------------------------------
// Report hand-over through hooks

function formatReports(reports: QueuedShellReport[]): string {
  const intro = reports.length === 1
    ? 'A message from a derived session arrived while you were working in this terminal:'
    : `${reports.length} messages from derived sessions arrived while you were working in this terminal:`;
  return [intro, ...reports.map((report) => report.content)].join('\n\n');
}

type HookInput = {
  session_id?: unknown;
  agent_id?: unknown;
  stop_hook_active?: unknown;
};

/**
 * Answers one of the terminal's hooks. Returns the JSON the CLI expects, or
 * an empty object when there is nothing to do.
 */
export function answerHook(event: string, sessionId: string, input: HookInput): Record<string, unknown> {
  const state = terminalFor(sessionId);
  if (typeof input.session_id === 'string' && input.session_id) {
    state.reportedSessionId = input.session_id;
  }
  // The terminal switched to another conversation (/clear, /resume): its
  // reports are not this conversation's business.
  if (state.reportedSessionId && state.reportedSessionId !== sessionId) {
    return {};
  }

  if (event === 'user-prompt-submit') {
    startTerminalTurn(sessionId);
    const reports = takeShellReports(sessionId);
    return reports.length === 0 ? {} : {
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: formatReports(reports) },
    };
  }

  // A subagent's tool call: the report belongs to the main conversation.
  if (typeof input.agent_id === 'string' && input.agent_id) {
    return {};
  }

  if (event === 'post-tool-use') {
    const reports = takeShellReports(sessionId);
    return reports.length === 0 ? {} : {
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: formatReports(reports) },
    };
  }

  if (event === 'stop') {
    // The parent goes on by itself: counted like a report-started turn.
    const reports = takeShellReports(sessionId, { turnStart: true });
    return reports.length === 0 ? {} : { decision: 'block', reason: formatReports(reports) };
  }

  return {};
}

// ---------------------------------------------------------------------------
// Config files for the terminal's CLI

function configRoot(): string {
  const port = listening?.port ?? 'off';
  return process.env.DERIVED_SESSIONS_CONFIG_DIR
    || path.join(os.homedir(), '.config', 'claudecodeui', 'shell-mcp', String(port));
}

export type TerminalLaunchConfig = { mcpConfigPath: string; settingsPath: string };

/**
 * Writes the --mcp-config and --settings files for a terminal that starts the
 * CLI on `sessionId`. Null when the HTTP server is not running (the terminal
 * then starts without the tools, as before).
 */
export function prepareTerminalLaunch(sessionId: string, userId: string | number | null): TerminalLaunchConfig | null {
  if (!listening || !SAFE_SESSION_ID.test(sessionId)) {
    return null;
  }
  registerTerminalUser(sessionId, userId);

  const base = `http://127.0.0.1:${listening.port}`;
  const headers = { Authorization: `Bearer ${issueSessionToken(sessionId)}`, 'X-Ccui-Session': sessionId };
  const dir = path.join(configRoot(), sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);

  const mcpConfig = {
    mcpServers: {
      'derived-sessions': { type: 'http', url: `${base}/mcp`, headers },
    },
  };
  const hook = (route: string) => [{ hooks: [{ type: 'http', url: `${base}/hooks/${route}`, headers, timeout: 10 }] }];
  const settings = {
    permissions: { allow: [...DERIVED_SESSIONS_ALLOWED_TOOLS, SEND_TO_PARENT_TOOL] },
    hooks: {
      UserPromptSubmit: hook('user-prompt-submit'),
      PostToolUse: [{ matcher: '*', hooks: hook('post-tool-use')[0].hooks }],
      Stop: hook('stop'),
    },
  };

  const mcpConfigPath = path.join(dir, 'mcp.json');
  const settingsPath = path.join(dir, 'settings.json');
  writePrivate(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
  writePrivate(settingsPath, JSON.stringify(settings, null, 2));
  return { mcpConfigPath, settingsPath };
}

function writePrivate(file: string, content: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
}

// ---------------------------------------------------------------------------
// HTTP server

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handleMcp(sessionId: string, req: http.IncomingMessage, res: http.ServerResponse, body: unknown): Promise<void> {
  const state = terminalFor(sessionId);
  // Built per request (stateless transport), but on this turn's handlers, so
  // the per-turn limit spans the turn; send_to_parent_session is listed only
  // while the conversation has a parent.
  const context: DerivedSessionsContext = { ...contextFor(sessionId, state), parentSessionId: getParentSessionId(sessionId) };
  const handlers = handlersFor(sessionId, state);
  const guarded = state.reportedSessionId && state.reportedSessionId !== sessionId
    ? refusingHandlers(handlers)
    : handlers;
  const server = createDerivedSessionsMcpServer(context, guarded).instance;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

function refusingHandlers(handlers: DerivedSessionHandlers): DerivedSessionHandlers {
  const refusal = async () => ({
    content: [{ type: 'text' as const, text: 'This terminal switched to another conversation (/clear or /resume). Open the conversation in the Shell tab again to use derived sessions.' }],
    isError: true,
  });
  return Object.fromEntries(Object.keys(handlers).map((key) => [key, refusal])) as unknown as DerivedSessionHandlers;
}

const HOOK_ROUTES = new Set(['user-prompt-submit', 'post-tool-use', 'stop']);

export async function handleDerivedSessionsHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const auth = verifyRequestAuth(req.headers);
  if (!auth.ok) {
    sendJson(res, auth.status, { error: auth.reason });
    return;
  }
  try {
    if (url.pathname === '/mcp') {
      if (req.method !== 'POST') {
        // Stateless server: no server-to-client stream, no session to delete.
        res.writeHead(405, { Allow: 'POST' }).end();
        return;
      }
      await handleMcp(auth.sessionId, req, res, await readBody(req));
      return;
    }
    const hookMatch = /^\/hooks\/([a-z-]+)$/.exec(url.pathname);
    if (hookMatch && HOOK_ROUTES.has(hookMatch[1]) && req.method === 'POST') {
      const input = (await readBody(req) ?? {}) as HookInput;
      sendJson(res, 200, answerHook(hookMatch[1], auth.sessionId, input));
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    console.error('[derived-sessions-http] request failed:', error instanceof Error ? error.message : String(error));
    sendJson(res, 500, { error: 'internal error' });
  }
}

/** The port the terminal tools listen on: DERIVED_SESSIONS_HTTP_PORT, else the server port + 10. */
export function resolveDerivedSessionsHttpPort(serverPort: number | string | undefined): number | null {
  const raw = process.env.DERIVED_SESSIONS_HTTP_PORT;
  if (raw === 'off' || raw === '0') {
    return null;
  }
  const explicit = Number(raw);
  if (raw && Number.isInteger(explicit) && explicit > 0) {
    return explicit;
  }
  const base = Number(serverPort);
  return Number.isInteger(base) && base > 0 ? base + 10 : null;
}

/**
 * Starts the server on 127.0.0.1. A fixed port, so a terminal started before
 * a restart of this server reaches it again. Failing to listen only disables
 * the tools in terminals; the rest of the app keeps working.
 */
export function startDerivedSessionsHttpServer(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      void handleDerivedSessionsHttpRequest(req, res);
    });
    server.once('error', (error) => {
      console.warn(`[derived-sessions-http] not started on 127.0.0.1:${port}: ${error.message}. Terminals start without derived-sessions tools.`);
      resolve(null);
    });
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actual = typeof address === 'object' && address ? address.port : port;
      listening = { port: actual, server };
      console.log(`[derived-sessions-http] terminal tools on 127.0.0.1:${actual}`);
      resolve(actual);
    });
  });
}

export function stopDerivedSessionsHttpServer(): Promise<void> {
  const current = listening;
  listening = null;
  if (!current) {
    return Promise.resolve();
  }
  return new Promise((resolve) => current.server.close(() => resolve()));
}
