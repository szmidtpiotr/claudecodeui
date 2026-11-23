/**
 * Derived sessions started by an agent ("sesje pochodne"), the way the Claude
 * desktop app does them:
 *
 * 1. the parent agent starts a NEW, clean session in the same project with a
 *    task as its first prompt; it runs headless and is recorded as the
 *    parent's child (parent_session_id);
 * 2. when one of the child's headless turns ends, its final reply is sent
 *    back to the parent as a message — steered into the parent's running
 *    turn, or starting a new parent turn when the parent is idle;
 * 3. the parent can list its children and continue one.
 *
 * The runner (queryClaudeSDK) lives in server/claude-sdk.js, which this module
 * must not import; it registers itself through configureDerivedSessionsRuntime.
 */
import crypto from 'node:crypto';

import { getSessionMessages as sdkGetSessionMessages } from '@anthropic-ai/claude-agent-sdk';

import { sessionsDb } from '@/modules/database/index.js';
import { readLastAssistantText, type TranscriptMessageLike } from '@/modules/providers/list/claude/claude-fork-utils.js';
import { emitSessionMetadataChanged } from '@/modules/providers/services/session-events.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { WebSocketWriter } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import {
  buildDerivedReportMessage,
  buildDerivedSessionPrompt,
  type DerivedReportStatus,
} from '../../../../shared/derivedSessionReport.js';

const WS_CLOSED_STATE = 3;
const MAX_TITLE_LENGTH = 200;

/**
 * Report-started parent turns allowed per parent within RELAY_WINDOW_MS. A
 * parent and a child that keep answering each other (send_to_derived_session
 * → report → new parent turn → …) stop here instead of running forever.
 */
export const MAX_RELAY_TURNS_PER_WINDOW = 10;
export const RELAY_WINDOW_MS = 10 * 60 * 1000;

/** How long a delivery waits for the parent turn it started to come up. */
const TURN_START_WAIT_MS = 60 * 1000;
const TURN_START_POLL_MS = 50;

/** What queryClaudeSDK resolves to (older callers may get undefined). */
export type HeadlessRunResult = {
  status?: 'completed' | 'error' | 'aborted';
  sessionId?: string | null;
  resultText?: string | null;
  error?: string | null;
} | undefined | void;

export type DerivedSessionsRuntime = {
  /** Runs one Claude turn without a browser tab (queryClaudeSDK). */
  runHeadless: (prompt: string, options: Record<string, unknown>, writer: WebSocketWriter) => Promise<HeadlessRunResult>;
  isSessionActive: (sessionId: string) => boolean;
  /** Writes a message into a session's running turn (steerClaudeSDKSession). */
  steer: (sessionId: string, messageId: string, content: string) => { ok: boolean; reason?: string };
  /** Test seam; defaults to the SDK's transcript reader. */
  getSessionMessages?: (sessionId: string, options: { dir?: string }) => Promise<TranscriptMessageLike[]>;
  /** Test seam for the relay window. */
  now?: () => number;
};

let runtime: DerivedSessionsRuntime | null = null;

/** Headless turns this module started and that have not settled yet. */
const runningTurns = new Map<string, Promise<void>>();
/** Run options (model, effort, permission mode, tools) of each session's last run here. */
const rememberedRunOptions = new Map<string, Record<string, unknown>>();
/** Session a derived session's headless turns report to (its creator). */
const reportTargets = new Map<string, string>();
/** Serialises deliveries into one parent so two reports never start two turns. */
const deliveryQueues = new Map<string, Promise<unknown>>();
/** Start times of report-started turns per parent, for the relay limit. */
const relayTurnTimes = new Map<string, number[]>();
/** The user each session's headless output is attributed to (notifications). */
const sessionUsers = new Map<string, string | number | null>();

export function configureDerivedSessionsRuntime(next: DerivedSessionsRuntime | null): void {
  runtime = next;
}

/** Clears all in-memory state; tests only. */
export function resetDerivedSessionsStateForTests(): void {
  runningTurns.clear();
  rememberedRunOptions.clear();
  reportTargets.clear();
  deliveryQueues.clear();
  relayTurnTimes.clear();
  sessionUsers.clear();
}

function requireRuntime(): DerivedSessionsRuntime {
  if (!runtime) {
    throw new AppError('Derived sessions are not available: no Claude runner is registered.', {
      code: 'DERIVED_SESSIONS_UNAVAILABLE',
      statusCode: 503,
    });
  }
  return runtime;
}

/** A socket that is never open: output reaches only windows subscribed to the session. */
const detachedSocket: RealtimeClientConnection = { readyState: WS_CLOSED_STATE, send: () => {} };

/** The run options a derived turn inherits; never the cwd, session, images or prompt state. */
export function pickInheritedRunOptions(options: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const inherited: Record<string, unknown> = {};
  if (!options) {
    return inherited;
  }
  for (const key of ['permissionMode', 'toolsSettings', 'model', 'effort']) {
    if (options[key] !== undefined) {
      inherited[key] = options[key];
    }
  }
  return inherited;
}

/**
 * Remembers what a session last ran with, so a turn this module starts later
 * in it (a report reaching an idle parent) runs the same way. The per-session
 * model/permission choice otherwise lives only in the browser.
 */
export function rememberSessionRunOptions(sessionId: string | null | undefined, options: Record<string, unknown> | null | undefined): void {
  if (!sessionId || !options) {
    return;
  }
  const inherited = pickInheritedRunOptions(options);
  if (Object.keys(inherited).length > 0) {
    rememberedRunOptions.set(sessionId, inherited);
  }
}

export function getRememberedRunOptions(sessionId: string): Record<string, unknown> | null {
  return rememberedRunOptions.get(sessionId) ?? null;
}

export function isDerivedTurnRunning(sessionId: string): boolean {
  return runningTurns.has(sessionId) || Boolean(runtime?.isSessionActive(sessionId));
}

/** Settles when the headless turn this module started in a session ends (tests, e2e). */
export function waitForDerivedTurn(sessionId: string): Promise<void> {
  return runningTurns.get(sessionId) ?? Promise.resolve();
}

/** Settles once every queued report delivery into a session has been handed over. */
export function waitForDeliveries(sessionId: string): Promise<unknown> {
  return deliveryQueues.get(sessionId) ?? Promise.resolve();
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createWriter(sessionId: string, userId: string | number | null): WebSocketWriter {
  const writer = new WebSocketWriter(detachedSocket, userId);
  // Registers the session id so every window that has the session open gets the stream.
  writer.setSessionId(sessionId);
  return writer;
}

type StartTurnInput = {
  sessionId: string;
  prompt: string;
  /** True for the first turn of a session that does not exist on disk yet. */
  isNew: boolean;
  /** Where this turn's final reply is reported; null = nowhere. */
  reportTo: string | null;
  runOptions: Record<string, unknown> | null;
  userId: string | number | null;
  /** Uuid of the prompt row, so the live echo and history reconcile. */
  promptUuid?: string;
};

/**
 * Starts one headless turn in a session and, when it ends, reports its final
 * reply to `reportTo`. Returns at once; the turn runs in the background.
 */
function startHeadlessTurn(input: StartTurnInput): void {
  const rt = requireRuntime();
  const row = sessionsDb.getSessionById(input.sessionId);
  if (!row?.project_path) {
    throw new AppError(`Session "${input.sessionId}" has no project directory.`, {
      code: 'DERIVED_NO_PROJECT',
      statusCode: 400,
    });
  }

  const writer = createWriter(input.sessionId, input.userId);
  if (input.userId !== null && input.userId !== undefined) {
    sessionUsers.set(input.sessionId, input.userId);
  }

  const options: Record<string, unknown> = {
    ...pickInheritedRunOptions(input.runOptions),
    cwd: row.project_path,
    sessionSummary: row.custom_name ?? undefined,
    ...(input.isNew ? { newSessionId: input.sessionId } : { sessionId: input.sessionId }),
    ...(input.promptUuid ? { promptUuid: input.promptUuid } : {}),
  };
  rememberSessionRunOptions(input.sessionId, options);

  // Tabs that have the session open show it working.
  writer.send({ type: 'session-status', sessionId: input.sessionId, provider: 'claude', isProcessing: true });

  const settled = Promise.resolve()
    .then(() => rt.runHeadless(input.prompt, options, writer))
    .then(
      (result): { status: DerivedReportStatus; text: string | null } | null => {
        if (result && result.status === 'error') {
          return { status: 'error', text: result.error ?? null };
        }
        if (result && result.status === 'aborted') {
          return { status: 'error', text: 'Tura została przerwana (Stop).' };
        }
        return { status: 'completed', text: result?.resultText ?? null };
      },
      (error: unknown) => ({ status: 'error' as const, text: errorText(error) }),
    )
    .then(async (outcome) => {
      runningTurns.delete(input.sessionId);
      emitSessionMetadataChanged({ sessionId: input.sessionId, provider: 'claude' });
      if (!input.reportTo || !outcome) {
        return;
      }
      let text = outcome.text;
      if (outcome.status === 'completed' && !text) {
        text = await readLastReply(input.sessionId, row.project_path ?? undefined);
      }
      const title = sessionsDb.getSessionById(input.sessionId)?.custom_name || input.sessionId;
      await deliverDerivedReport({
        parentSessionId: input.reportTo,
        childSessionId: input.sessionId,
        childTitle: title,
        status: outcome.status,
        text,
      });
    })
    .catch((error: unknown) => {
      runningTurns.delete(input.sessionId);
      console.error('[derived-sessions] turn bookkeeping failed', input.sessionId, error);
    });

  runningTurns.set(input.sessionId, settled);
  emitSessionMetadataChanged({ sessionId: input.sessionId, provider: 'claude' });
}

async function readLastReply(sessionId: string, dir: string | undefined): Promise<string | null> {
  const read = runtime?.getSessionMessages
    ?? (sdkGetSessionMessages as unknown as NonNullable<DerivedSessionsRuntime['getSessionMessages']>);
  try {
    return readLastAssistantText(await read(sessionId, { dir }));
  } catch {
    return null;
  }
}

export type CreateDerivedSessionInput = {
  parentSessionId: string;
  title: string;
  task: string;
  /** The parent run's options; the child runs with the same model/effort/permissions. */
  runOptions: Record<string, unknown> | null;
  userId: string | number | null;
};

export type CreateDerivedSessionResult = {
  sessionId: string;
  title: string;
  parentSessionId: string;
  projectPath: string;
};

/**
 * Creates a fresh derived session (no copy of the parent's history) and starts
 * its first turn with `task`. Returns as soon as the session is recorded.
 */
export function createFreshDerivedSession(input: CreateDerivedSessionInput): CreateDerivedSessionResult {
  requireRuntime();
  const parent = sessionsDb.getSessionById(input.parentSessionId);
  if (!parent) {
    throw new AppError(`Session "${input.parentSessionId}" was not found.`, { code: 'SESSION_NOT_FOUND', statusCode: 404 });
  }
  if (parent.provider !== 'claude' || !parent.project_path) {
    throw new AppError('Derived sessions need a Claude session with a project directory.', {
      code: 'DERIVED_UNSUPPORTED',
      statusCode: 400,
    });
  }
  const title = normalizeTitle(input.title);
  const task = input.task.trim();
  if (!title || !task) {
    throw new AppError('A derived session needs a title and a task.', { code: 'DERIVED_BAD_INPUT', statusCode: 400 });
  }

  rememberSessionRunOptions(input.parentSessionId, input.runOptions);

  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();
  // Recorded before the run starts: the child's transcript carries no
  // forkedFrom marker, so this row is the only record of its parent.
  sessionsDb.createSession(sessionId, 'claude', parent.project_path, title, now, now, null, 'user', input.parentSessionId);
  reportTargets.set(sessionId, input.parentSessionId);

  startHeadlessTurn({
    sessionId,
    prompt: buildDerivedSessionPrompt({
      parentSessionId: input.parentSessionId,
      parentTitle: parent.custom_name ?? null,
      task,
    }),
    isNew: true,
    reportTo: input.parentSessionId,
    runOptions: input.runOptions,
    userId: input.userId,
  });

  return { sessionId, title, parentSessionId: input.parentSessionId, projectPath: parent.project_path };
}

export type SendToDerivedSessionResult = { mode: 'steered' | 'new_turn'; messageId: string };

/**
 * Continues a derived session with a message from its parent: into its running
 * turn when it has one, otherwise as a new headless turn that reports back.
 */
export function sendToDerivedSession(input: {
  parentSessionId: string;
  childSessionId: string;
  message: string;
  runOptions: Record<string, unknown> | null;
  userId: string | number | null;
}): SendToDerivedSessionResult {
  const rt = requireRuntime();
  const messageId = crypto.randomUUID();
  const message = input.message.trim();
  if (!message) {
    throw new AppError('The message is empty.', { code: 'DERIVED_BAD_INPUT', statusCode: 400 });
  }
  reportTargets.set(input.childSessionId, input.parentSessionId);

  if (rt.isSessionActive(input.childSessionId)) {
    const steered = rt.steer(input.childSessionId, messageId, message);
    if (steered.ok) {
      return { mode: 'steered', messageId };
    }
  }
  if (runningTurns.has(input.childSessionId)) {
    throw new AppError('The derived session is starting a turn right now; try again in a moment.', {
      code: 'DERIVED_BUSY',
      statusCode: 409,
    });
  }

  startHeadlessTurn({
    sessionId: input.childSessionId,
    prompt: message,
    isNew: false,
    reportTo: input.parentSessionId,
    runOptions: getRememberedRunOptions(input.childSessionId) ?? input.runOptions,
    userId: input.userId,
    promptUuid: messageId,
  });
  return { mode: 'new_turn', messageId };
}

function takeRelayBudget(parentSessionId: string): boolean {
  const now = runtime?.now?.() ?? Date.now();
  const recent = (relayTurnTimes.get(parentSessionId) ?? []).filter((time) => now - time < RELAY_WINDOW_MS);
  if (recent.length >= MAX_RELAY_TURNS_PER_WINDOW) {
    relayTurnTimes.set(parentSessionId, recent);
    return false;
  }
  recent.push(now);
  relayTurnTimes.set(parentSessionId, recent);
  return true;
}

async function waitForTurnStart(sessionId: string, settled: Promise<void>): Promise<void> {
  const rt = requireRuntime();
  let done = false;
  void settled.finally(() => { done = true; });
  const deadline = Date.now() + TURN_START_WAIT_MS;
  while (!done && !rt.isSessionActive(sessionId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, TURN_START_POLL_MS));
  }
}

export type ReportDelivery =
  | { mode: 'steered'; messageId: string }
  | { mode: 'new_turn'; messageId: string }
  | { mode: 'dropped'; reason: 'relay_limit' | 'parent_missing' | 'error'; detail?: string };

/**
 * Decides how a report reaches the parent and does it:
 * - the parent's turn is running here → steered in, read at its next tool call;
 * - otherwise → a new headless parent turn with the report as its prompt.
 * Deliveries into one parent run one after another, so a second report that
 * arrives while the first one's turn is starting joins that turn.
 */
export function deliverDerivedReport(input: {
  parentSessionId: string;
  childSessionId: string;
  childTitle: string;
  status: DerivedReportStatus;
  text: string | null;
}): Promise<ReportDelivery> {
  const content = buildDerivedReportMessage({
    childSessionId: input.childSessionId,
    childTitle: input.childTitle,
    status: input.status,
    text: input.text,
  });
  const parentId = input.parentSessionId;

  const run = async (): Promise<ReportDelivery> => {
    const rt = requireRuntime();
    const messageId = crypto.randomUUID();

    if (rt.isSessionActive(parentId)) {
      const steered = rt.steer(parentId, messageId, content);
      if (steered.ok) {
        return { mode: 'steered', messageId };
      }
    }
    // A turn of ours that is just ending (its input already closed) cannot
    // take the report; wait for it so two runs never share the session.
    const ending = runningTurns.get(parentId);
    if (ending) {
      await ending;
    }

    const parent = sessionsDb.getSessionById(parentId);
    if (!parent?.project_path) {
      console.warn(`[derived-sessions] report from ${input.childSessionId} dropped: parent ${parentId} not found`);
      return { mode: 'dropped', reason: 'parent_missing' };
    }
    if (!takeRelayBudget(parentId)) {
      console.warn(`[derived-sessions] report from ${input.childSessionId} not delivered: ${parentId} reached ${MAX_RELAY_TURNS_PER_WINDOW} report turns in ${RELAY_WINDOW_MS / 60000} min`);
      return { mode: 'dropped', reason: 'relay_limit' };
    }

    const userId = sessionUsers.get(input.childSessionId) ?? sessionUsers.get(parentId) ?? null;
    // Shown at once in every tab that has the parent open; the run's prompt
    // carries the same uuid, so history and the live view agree.
    const echoWriter = createWriter(parentId, userId);
    for (const message of sessionsService.normalizeMessage('claude', {
      type: 'user',
      uuid: messageId,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content },
    }, parentId)) {
      echoWriter.send(message);
    }

    startHeadlessTurn({
      sessionId: parentId,
      prompt: content,
      isNew: false,
      // A parent that is itself a derived session passes its answer on up.
      reportTo: reportTargets.get(parentId) ?? null,
      runOptions: getRememberedRunOptions(parentId),
      userId,
      promptUuid: messageId,
    });
    await waitForTurnStart(parentId, runningTurns.get(parentId) ?? Promise.resolve());
    return { mode: 'new_turn', messageId };
  };

  const previous = deliveryQueues.get(parentId) ?? Promise.resolve();
  const next = previous.then(run, run).catch((error: unknown): ReportDelivery => {
    console.error('[derived-sessions] report delivery failed', parentId, error);
    return { mode: 'dropped', reason: 'error', detail: errorText(error) };
  });
  deliveryQueues.set(parentId, next);
  void next.finally(() => {
    if (deliveryQueues.get(parentId) === next) {
      deliveryQueues.delete(parentId);
    }
  });
  return next;
}

export type DerivedSessionListItem = {
  sessionId: string;
  title: string | null;
  state: 'running' | 'idle';
  lastUpdate: string | null;
  createdAt: string | null;
};

/** Direct derived sessions of a session (agent-created and forks), oldest first. */
export function listDerivedSessions(parentSessionId: string): DerivedSessionListItem[] {
  return sessionsDb.getChildSessions(parentSessionId).map((row) => ({
    sessionId: row.session_id,
    title: row.custom_name ?? null,
    state: isDerivedTurnRunning(row.session_id) ? 'running' : 'idle',
    lastUpdate: row.updated_at ?? null,
    createdAt: row.created_at ?? null,
  }));
}
