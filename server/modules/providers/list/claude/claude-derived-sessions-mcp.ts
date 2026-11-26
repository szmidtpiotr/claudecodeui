/**
 * In-process MCP server that lets the Claude agent of a chat session start
 * derived sessions ("sesje pochodne") like the Claude desktop app does: a new,
 * clean session in the same project runs a task on its own and its final
 * reply comes back to this session automatically as a message.
 *
 * One server instance is created per chat turn (queryClaudeSDK call), so the
 * per-turn creation counter lives in its closure. Unattended runs (agent API,
 * commit messages) never receive it. A CLI started in the Shell tab reaches
 * the same tools over HTTP: see derived-sessions-http.service.ts. Forks (the Fork button) are a separate
 * thing: see session-fork.service.ts.
 */
import { createSdkMcpServer, getSessionMessages as sdkGetSessionMessages, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { sessionsDb } from '@/modules/database/index.js';
import {
  checkDerivedSessionGuardrails,
  readLastAssistantText,
  type TranscriptMessageLike,
} from '@/modules/providers/list/claude/claude-fork-utils.js';
import {
  createFreshDerivedSession,
  getParentSessionId,
  isDerivedTurnRunning,
  listDerivedSessions,
  sendToDerivedSession,
  sendToParentSession,
  type ReportDelivery,
} from '@/modules/providers/services/derived-sessions.service.js';

import { MAX_SESSION_MESSAGE_LENGTH } from '../../../../../shared/derivedSessionReport.js';

export const DERIVED_SESSIONS_SERVER_NAME = 'derived-sessions';
export const DERIVED_SESSIONS_ALLOWED_TOOLS = [
  `mcp__${DERIVED_SESSIONS_SERVER_NAME}__create_derived_session`,
  `mcp__${DERIVED_SESSIONS_SERVER_NAME}__get_derived_session_status`,
  `mcp__${DERIVED_SESSIONS_SERVER_NAME}__list_derived_sessions`,
  `mcp__${DERIVED_SESSIONS_SERVER_NAME}__send_to_derived_session`,
];
/** Only for runs in a session that has a parent. */
export const SEND_TO_PARENT_TOOL = `mcp__${DERIVED_SESSIONS_SERVER_NAME}__send_to_parent_session`;

/** The derived-sessions tools a run may use without asking; send_to_parent_session only with a parent. */
export function derivedSessionsAllowedTools(hasParent: boolean): string[] {
  return hasParent ? [...DERIVED_SESSIONS_ALLOWED_TOOLS, SEND_TO_PARENT_TOOL] : [...DERIVED_SESSIONS_ALLOWED_TOOLS];
}

/** How long send_to_parent_session waits for the delivery before answering "queued". */
const SEND_TO_PARENT_WAIT_MS = 20 * 1000;

const MAX_STATUS_TEXT_LENGTH = 4000;

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

export type DerivedSessionsContext = {
  /** Id of the session the agent is running in (known once the run started). */
  getCurrentSessionId: () => string | null;
  /** Options of the parent run that a derived run inherits (model, permission mode, tools, effort). */
  parentOptions: Record<string, unknown>;
  userId: string | number | null;
  /**
   * The session's parent, looked up when the run starts. send_to_parent_session
   * is registered only when it is set. Undefined = look it up now.
   */
  parentSessionId?: string | null;
  /** Test seam. */
  getSessionMessages?: (sessionId: string, options: { dir?: string }) => Promise<TranscriptMessageLike[]>;
};

const text = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createDerivedSessionHandlers(context: DerivedSessionsContext) {
  const getMessages = context.getSessionMessages
    ?? (sdkGetSessionMessages as unknown as NonNullable<DerivedSessionsContext['getSessionMessages']>);
  let createdThisTurn = 0;

  /** The current session, and that `sessionId` is one of its derived sessions. */
  function resolveDescendant(sessionId: string): { currentSessionId: string } | ToolResult {
    const currentSessionId = context.getCurrentSessionId();
    if (!currentSessionId) {
      return text('The current session has no id yet.', true);
    }
    if (!sessionsDb.getSessionAncestorIds(sessionId).includes(currentSessionId)) {
      return text(`Session ${sessionId} is not a derived session of the current session.`, true);
    }
    return { currentSessionId };
  }

  async function createDerivedSession(args: { title: string; task: string }): Promise<ToolResult> {
    const currentSessionId = context.getCurrentSessionId();
    if (!currentSessionId) {
      return text('The current session has no id yet, so it cannot start a derived session.', true);
    }

    const currentDepth = sessionsDb.getSessionAncestorIds(currentSessionId).length;
    const refusal = checkDerivedSessionGuardrails({ createdThisTurn, currentDepth });
    if (refusal) {
      return text(refusal, true);
    }
    createdThisTurn += 1;

    try {
      const created = createFreshDerivedSession({
        parentSessionId: currentSessionId,
        title: args.title,
        task: args.task,
        runOptions: context.parentOptions,
        userId: context.userId,
      });
      return text({
        sessionId: created.sessionId,
        title: created.title,
        parentSessionId: currentSessionId,
        depth: currentDepth + 1,
        state: 'running',
        note: 'The derived session started working on the task in the background and is listed under this session in the sidebar. '
          + 'When its turn ends, its final reply arrives here automatically as a message starting with "[Sesja pochodna". '
          + 'You do not need to poll; continue with other work or end your turn.',
      });
    } catch (error) {
      createdThisTurn -= 1;
      return text(`Could not create the derived session: ${describeError(error)}`, true);
    }
  }

  async function getDerivedSessionStatus(args: { sessionId: string }): Promise<ToolResult> {
    const resolved = resolveDescendant(args.sessionId);
    if ('content' in resolved) {
      return resolved;
    }

    const row = sessionsDb.getSessionById(args.sessionId);
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
      status: isDerivedTurnRunning(args.sessionId) ? 'running' : 'idle',
      lastAssistantText,
    });
  }

  async function listDerived(): Promise<ToolResult> {
    const currentSessionId = context.getCurrentSessionId();
    if (!currentSessionId) {
      return text('The current session has no id yet.', true);
    }
    return text({ parentSessionId: currentSessionId, derivedSessions: listDerivedSessions(currentSessionId) });
  }

  async function sendToDerived(args: { sessionId: string; message: string }): Promise<ToolResult> {
    const resolved = resolveDescendant(args.sessionId);
    if ('content' in resolved) {
      return resolved;
    }
    try {
      const sent = sendToDerivedSession({
        parentSessionId: resolved.currentSessionId,
        childSessionId: args.sessionId,
        message: args.message,
        runOptions: context.parentOptions,
        userId: context.userId,
      });
      return text({
        sessionId: args.sessionId,
        delivery: sent.mode === 'steered' ? 'into_running_turn' : 'new_turn',
        note: 'The derived session continues in the background; its final reply will arrive here automatically.',
      });
    } catch (error) {
      return text(`Could not send to the derived session: ${describeError(error)}`, true);
    }
  }

  async function sendToParent(args: { message: string }): Promise<ToolResult> {
    const currentSessionId = context.getCurrentSessionId();
    if (!currentSessionId) {
      return text('The current session has no id yet.', true);
    }
    let delivery: Promise<ReportDelivery>;
    try {
      delivery = sendToParentSession({ childSessionId: currentSessionId, message: args.message, userId: context.userId });
    } catch (error) {
      return text(`Could not send to the parent session: ${describeError(error)}`, true);
    }
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      delivery,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), SEND_TO_PARENT_WAIT_MS); }),
    ]);
    clearTimeout(timer);
    const parentSessionId = getParentSessionId(currentSessionId);
    if (!outcome) {
      return text({ parentSessionId, delivery: 'queued', note: 'The message is queued and will reach the parent session shortly.' });
    }
    if (outcome.mode === 'queued') {
      return text({
        parentSessionId,
        delivery: 'queued',
        note: 'The parent session is open in a terminal; the message waits there and reaches it at its next turn.',
      });
    }
    if (outcome.mode === 'dropped') {
      const why = outcome.reason === 'relay_limit'
        ? 'the parent session received too many messages from derived sessions recently; try again later'
        : outcome.reason === 'parent_missing' ? 'the parent session no longer exists' : (outcome.detail ?? 'unknown error');
      return text(`The message was not delivered: ${why}.`, true);
    }
    return text({
      parentSessionId,
      delivery: outcome.mode === 'steered' ? 'into_running_turn' : 'new_turn',
      note: 'Delivered to the parent session. Do not wait for an answer; tell the user it was sent.',
    });
  }

  return {
    createDerivedSession,
    getDerivedSessionStatus,
    listDerivedSessions: listDerived,
    sendToDerivedSession: sendToDerived,
    sendToParentSession: sendToParent,
  };
}

export type DerivedSessionHandlers = ReturnType<typeof createDerivedSessionHandlers>;

/**
 * The tool definitions of a run; send_to_parent_session only when the session
 * has a parent. `handlers` carries the per-turn state (the creation counter):
 * the chat builds one set per turn, the terminal (HTTP) path keeps one set per
 * turn across the many requests of that turn.
 */
export function buildDerivedSessionsTools(
  context: DerivedSessionsContext,
  handlers: DerivedSessionHandlers = createDerivedSessionHandlers(context),
) {
  const parentSessionId = context.parentSessionId === undefined
    ? getParentSessionId(context.getCurrentSessionId())
    : context.parentSessionId;

  const parentTools = parentSessionId
    ? [
      tool(
        'send_to_parent_session',
        'Send a message to the parent session ("sesja nadrzędna", the main session this derived session was started from). '
          + 'Use it when the user asks you to tell, send, pass on or report something to the parent or main session. '
          + 'The message arrives there as a message from this session and the parent agent reacts to it. '
          + 'Write the message so it makes sense without this conversation.',
        {
          message: z.string().min(1).max(MAX_SESSION_MESSAGE_LENGTH).describe('What the parent session should receive.'),
        },
        async (args) => handlers.sendToParentSession(args),
      ),
    ]
    : [];

  return [
      tool(
        'create_derived_session',
        'Start a derived session ("sesja pochodna"): a NEW, clean Claude session in the same project directory that works on '
          + '`task` on its own, in the background. It does NOT see this conversation, so the task must be self-contained. '
          + 'When its turn ends, its final reply is delivered back to this session automatically as a message starting with '
          + '"[Sesja pochodna" — no polling needed. Use it when the user asks for a derived, side, parallel or separate session, '
          + 'or to hand work off to one. Returns immediately with the new session id. Limits: at most 5 per turn and 3 levels of nesting.',
        {
          title: z.string().min(1).max(200).describe('Short title for the derived session, shown in the sidebar.'),
          task: z.string().min(1).max(20000).describe('Self-contained instruction the derived session starts working on.'),
        },
        async (args) => handlers.createDerivedSession(args),
      ),
      tool(
        'get_derived_session_status',
        'Check a derived session of this session: whether it is running and its latest assistant reply.',
        {
          sessionId: z.string().min(1).max(120).describe('Id returned by create_derived_session or list_derived_sessions.'),
        },
        async (args) => handlers.getDerivedSessionStatus(args),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'list_derived_sessions',
        'List the derived sessions of this session (created by you or forked by the user): id, title, state (running/idle) and last update.',
        {},
        async () => handlers.listDerivedSessions(),
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'send_to_derived_session',
        'Send a follow-up message to one of this session\'s derived sessions to continue its work. If it is running, the message '
          + 'joins its current turn; otherwise a new turn starts in the background. Its final reply again arrives here automatically.',
        {
          sessionId: z.string().min(1).max(120).describe('Id of the derived session.'),
          message: z.string().min(1).max(20000).describe('What the derived session should do next.'),
        },
        async (args) => handlers.sendToDerivedSession(args),
      ),
    ...parentTools,
  ];
}

export function createDerivedSessionsMcpServer(context: DerivedSessionsContext, handlers?: DerivedSessionHandlers) {
  return createSdkMcpServer({
    name: DERIVED_SESSIONS_SERVER_NAME,
    version: '2.1.0',
    tools: buildDerivedSessionsTools(context, handlers),
  });
}
