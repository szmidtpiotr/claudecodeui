/**
 * In-process MCP server that lets the Claude agent of a chat session create
 * derived sessions itself ("fork yourself and do X in a side session").
 *
 * One server instance is created per chat turn (queryClaudeSDK call), so the
 * per-turn creation counter lives in its closure. Unattended runs (agent API,
 * commit messages) never receive it.
 */
import { createSdkMcpServer, getSessionMessages as sdkGetSessionMessages, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildDerivedTaskPrompt,
  checkDerivedSessionGuardrails,
  readLastAssistantText,
  type TranscriptMessageLike,
} from '@/modules/providers/list/claude/claude-fork-utils.js';
import { forkClaudeSessionById } from '@/modules/providers/services/session-fork.service.js';
import { WebSocketWriter } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';

export const DERIVED_SESSIONS_SERVER_NAME = 'derived-sessions';
export const DERIVED_SESSIONS_ALLOWED_TOOLS = [
  `mcp__${DERIVED_SESSIONS_SERVER_NAME}__create_derived_session`,
  `mcp__${DERIVED_SESSIONS_SERVER_NAME}__get_derived_session_status`,
];

const MAX_STATUS_TEXT_LENGTH = 4000;
const WS_CLOSED_STATE = 3;

/** Derived sessions whose headless run was started here and has not settled yet. */
const startingDerivedRuns = new Set<string>();

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export type DerivedSessionsContext = {
  /** Id of the session the agent is running in (known once the run started). */
  getCurrentSessionId: () => string | null;
  /** Options of the parent run that a derived run inherits (model, permission mode, tools, effort). */
  parentOptions: Record<string, unknown>;
  userId: string | number | null;
  /** Runs one turn in a session without a browser tab (queryClaudeSDK). */
  runHeadless: (prompt: string, options: Record<string, unknown>, writer: WebSocketWriter) => Promise<unknown>;
  isSessionActive: (sessionId: string) => boolean;
  /** Test seams. */
  fork?: typeof forkClaudeSessionById;
  getSessionMessages?: (sessionId: string, options: { dir?: string }) => Promise<TranscriptMessageLike[]>;
};

const text = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/** A socket that is never open: output reaches only windows subscribed to the session. */
const detachedSocket: RealtimeClientConnection = { readyState: WS_CLOSED_STATE, send: () => {} };

function inheritedRunOptions(parentOptions: Record<string, unknown>): Record<string, unknown> {
  const inherited: Record<string, unknown> = {};
  for (const key of ['permissionMode', 'toolsSettings', 'model', 'effort']) {
    if (parentOptions[key] !== undefined) {
      inherited[key] = parentOptions[key];
    }
  }
  return inherited;
}

export function createDerivedSessionHandlers(context: DerivedSessionsContext) {
  const fork = context.fork ?? forkClaudeSessionById;
  const getMessages = context.getSessionMessages
    ?? (sdkGetSessionMessages as unknown as NonNullable<DerivedSessionsContext['getSessionMessages']>);
  let createdThisTurn = 0;

  async function createDerivedSession(args: { title: string; task?: string; fromMessage?: string }): Promise<ToolResult> {
    const currentSessionId = context.getCurrentSessionId();
    if (!currentSessionId) {
      return text('The current session has no id yet, so it cannot be forked.', true);
    }

    const currentDepth = sessionsDb.getSessionAncestorIds(currentSessionId).length;
    const refusal = checkDerivedSessionGuardrails({ createdThisTurn, currentDepth });
    if (refusal) {
      return text(refusal, true);
    }
    // Counted before the await so parallel calls in one turn cannot overshoot.
    createdThisTurn += 1;

    let forked;
    try {
      forked = await fork({
        sessionId: currentSessionId,
        upToMessageId: args.fromMessage ?? null,
        title: args.title,
      });
    } catch (error) {
      createdThisTurn -= 1;
      return text(`Could not create the derived session: ${error instanceof Error ? error.message : String(error)}`, true);
    }

    const task = typeof args.task === 'string' ? args.task.trim() : '';
    let started = false;
    if (task) {
      const parentTitle = sessionsDb.getSessionById(currentSessionId)?.custom_name ?? null;
      const writer = new WebSocketWriter(detachedSocket, context.userId);
      // Registers the session id so a window that opens it receives the stream.
      writer.setSessionId(forked.sessionId);
      startingDerivedRuns.add(forked.sessionId);
      started = true;
      void Promise.resolve()
        .then(() => context.runHeadless(
          buildDerivedTaskPrompt({ parentSessionId: currentSessionId, parentTitle, task }),
          {
            ...inheritedRunOptions(context.parentOptions),
            cwd: forked.projectPath,
            sessionId: forked.sessionId,
            sessionSummary: forked.title,
          },
          writer,
        ))
        .catch((error: unknown) => {
          console.error('[derived-sessions] headless run failed', forked.sessionId, error);
        })
        .finally(() => {
          startingDerivedRuns.delete(forked.sessionId);
        });
    }

    return text({
      sessionId: forked.sessionId,
      title: forked.title,
      parentSessionId: currentSessionId,
      depth: currentDepth + 1,
      taskStarted: started,
      note: started
        ? 'The derived session is running its task in the background and is listed under this session in the sidebar. Use get_derived_session_status to check on it.'
        : 'The derived session was created idle and is listed under this session in the sidebar; the user can open it to continue there.',
    });
  }

  async function getDerivedSessionStatus(args: { sessionId: string }): Promise<ToolResult> {
    const currentSessionId = context.getCurrentSessionId();
    if (!currentSessionId) {
      return text('The current session has no id yet.', true);
    }
    if (!sessionsDb.getSessionAncestorIds(args.sessionId).includes(currentSessionId)) {
      return text(`Session ${args.sessionId} is not a derived session of the current session.`, true);
    }

    const row = sessionsDb.getSessionById(args.sessionId);
    const running = startingDerivedRuns.has(args.sessionId) || context.isSessionActive(args.sessionId);
    let lastAssistantText: string | null = null;
    try {
      const messages = await getMessages(args.sessionId, { dir: row?.project_path ?? undefined });
      lastAssistantText = readLastAssistantText(messages);
    } catch {
      lastAssistantText = null;
    }
    if (lastAssistantText && lastAssistantText.length > MAX_STATUS_TEXT_LENGTH) {
      lastAssistantText = `${lastAssistantText.slice(0, MAX_STATUS_TEXT_LENGTH)}…`;
    }

    return text({
      sessionId: args.sessionId,
      title: row?.custom_name ?? null,
      status: running ? 'running' : 'idle',
      lastAssistantText,
    });
  }

  return { createDerivedSession, getDerivedSessionStatus };
}

export function createDerivedSessionsMcpServer(context: DerivedSessionsContext) {
  const handlers = createDerivedSessionHandlers(context);

  return createSdkMcpServer({
    name: DERIVED_SESSIONS_SERVER_NAME,
    version: '1.0.0',
    tools: [
      tool(
        'create_derived_session',
        'Create a derived (forked) session from the CURRENT conversation. Use this ONLY when the user explicitly asks '
          + 'for a derived, forked, branched or side session (e.g. "fork this into a new session", "do X in a derived session"). '
          + 'The new session copies this conversation up to now, gets the given title and appears under this session in the '
          + 'sidebar. If `task` is given, it immediately starts working on that task in the background, without blocking you. '
          + 'Limits: at most 5 per turn and 3 levels of nesting.',
        {
          title: z.string().min(1).max(200).describe('Short title for the derived session, shown in the sidebar.'),
          task: z.string().max(20000).optional().describe('Instruction the derived session should start working on right away. Omit to create it idle for the user to continue.'),
          fromMessage: z.string().max(200).optional().describe('Optional transcript message uuid to fork up to (inclusive). Omit to fork at the current point.'),
        },
        async (args) => handlers.createDerivedSession(args),
      ),
      tool(
        'get_derived_session_status',
        'Check a derived session created from this session: whether it is still running and its latest assistant reply.',
        {
          sessionId: z.string().min(1).max(120).describe('Id returned by create_derived_session.'),
        },
        async (args) => handlers.getDerivedSessionStatus(args),
        { annotations: { readOnlyHint: true } },
      ),
    ],
  });
}
