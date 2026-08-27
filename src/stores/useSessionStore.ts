/**
 * Session-keyed message store.
 *
 * Holds per-session state in a Map keyed by sessionId.
 * Session switch = change activeSessionId pointer. No clearing. Old data stays.
 * WebSocket handler = store.appendRealtime(msg.sessionId, msg). One line.
 * No localStorage for messages. Backend JSONL is the source of truth.
 */

import { startTransition, useCallback, useMemo, useRef, useState } from 'react';

import { authenticatedFetch } from '../utils/api';
import type { LLMProvider } from '../types/app';
import { removeOptimisticUserEchoes } from './sessionMessageReconciliation';
import {
  buildSessionMessagesUrl,
  hasReachedCachedTailTimeBoundary,
  mergeLatestServerPage,
  mergeOlderServerPage,
  planLatestPageBridge,
  resolveLatestPagePagination,
  SESSION_MESSAGES_PAGE_SIZE,
} from './sessionMessagePagination';
import type { SessionMessagesRequestOptions } from './sessionMessagePagination';

// ─── NormalizedMessage (mirrors server/adapters/types.js) ────────────────────

export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_cancelled'
  | 'session_created'
  | 'interactive_prompt'
  | 'task_notification'
  | 'sudo_password_request'
  | 'sudo_password_cancelled';

export interface NormalizedMessage {
  id: string;
  sessionId: string;
  timestamp: string;
  provider: LLMProvider;
  kind: MessageKind;

  // kind-specific fields (flat for simplicity)
  role?: 'user' | 'assistant';
  content?: string;
  /**
   * Mirrors optional transcript metadata from the server.
   *
   * These fields are currently used by Claude history normalization so local
   * slash commands, local stdout, and compact summaries do not disappear when
   * the session store hydrates from REST history.
   */
  displayText?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  images?: Array<{ path?: string; data?: string; name?: string }>;
  files?: Array<{ path?: string; name?: string; mimeType?: string; size?: number }>;
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content: string; isError: boolean; toolUseResult?: unknown } | null;
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  newSessionId?: string;
  status?: string;
  summary?: string;
  exitCode?: number;
  actualSessionId?: string;
  parentToolUseId?: string;
  subagentTools?: unknown[];
  isFinal?: boolean;
  // Cursor-specific ordering
  sequence?: number;
  rowid?: number;
}

// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

export interface SessionSlot {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  merged: NormalizedMessage[];
  /** @internal Cache-invalidation refs for computeMerged */
  _lastServerRef: NormalizedMessage[];
  _lastRealtimeRef: NormalizedMessage[];
  /**
   * @internal Serializes history reads for this session so an older-page
   * request calculates its offset after any latest-page refresh completes.
   */
  _historyMutationQueue: Promise<void>;
  status: SessionStatus;
  fetchedAt: number;
  total: number;
  hasMore: boolean;
  offset: number;
  tokenUsage: unknown;
}

const EMPTY: NormalizedMessage[] = [];
const SESSION_HISTORY_REQUEST_TIMEOUT_MS = 30_000;

function createEmptySlot(): SessionSlot {
  return {
    serverMessages: EMPTY,
    realtimeMessages: EMPTY,
    merged: EMPTY,
    _lastServerRef: EMPTY,
    _lastRealtimeRef: EMPTY,
    status: 'idle',
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    tokenUsage: null,
    _historyMutationQueue: Promise.resolve(),
  };
}

type SessionHistoryPage = {
  messages: NormalizedMessage[];
  total: number;
  hasMore: boolean;
  tokenUsage?: unknown;
};

function enqueueHistoryMutation<T>(
  slot: SessionSlot,
  operation: () => Promise<T>,
): Promise<T> {
  const result = slot._historyMutationQueue.then(operation);
  slot._historyMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function requestSessionHistoryPage(
  sessionId: string,
  options: SessionMessagesRequestOptions,
): Promise<SessionHistoryPage> {
  const response = await authenticatedFetch(buildSessionMessagesUrl(sessionId, options), {
    signal: AbortSignal.timeout(SESSION_HISTORY_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const body = await response.json();
  const data = body?.data ?? body;
  const messages: NormalizedMessage[] = Array.isArray(data.messages) ? data.messages : [];

  return {
    messages,
    total: typeof data.total === 'number' ? data.total : messages.length,
    hasMore: Boolean(data.hasMore),
    ...(
      data && typeof data === 'object' && 'tokenUsage' in data
        ? { tokenUsage: data.tokenUsage }
        : {}
    ),
  };
}

function readMessageTime(m: NormalizedMessage): number | null {
  const time = Date.parse(m.timestamp);
  return Number.isFinite(time) ? time : null;
}

function compareMessagesChronologically(a: NormalizedMessage, b: NormalizedMessage): number {
  const timeA = readMessageTime(a) ?? 0;
  const timeB = readMessageTime(b) ?? 0;
  if (timeA !== timeB) {
    return timeA - timeB;
  }
  return 0;
}

function compareMessagesByTimestamp(left: NormalizedMessage, right: NormalizedMessage): number {
  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);

  if (Number.isNaN(leftTime) || Number.isNaN(rightTime) || leftTime === rightTime) {
    return 0;
  }

  return leftTime - rightTime;
}

function rewriteMessageSessionId(
  msg: NormalizedMessage,
  fromSessionId: string,
  toSessionId: string,
): NormalizedMessage {
  const streamingSourceId = `__streaming_${fromSessionId}`;
  const nextId = msg.id === streamingSourceId ? `__streaming_${toSessionId}` : msg.id;

  if (msg.sessionId === toSessionId && nextId === msg.id) {
    return msg;
  }

  return {
    ...msg,
    id: nextId,
    sessionId: toSessionId,
  };
}

function mergeMessagesById(
  existing: NormalizedMessage[],
  incoming: NormalizedMessage[],
): NormalizedMessage[] {
  if (existing.length === 0) return incoming;
  if (incoming.length === 0) return existing;

  const merged = [...existing, ...incoming];
  const deduped: NormalizedMessage[] = [];
  const seen = new Set<string>();

  for (const msg of merged) {
    if (seen.has(msg.id)) {
      continue;
    }

    seen.add(msg.id);
    deduped.push(msg);
  }

  deduped.sort(compareMessagesByTimestamp);
  return deduped;
}

/**
 * Count how many user turns precede `message` in a chronologically merged view
 * of server + realtime rows. Used to match a realtime row to the correct turn
 * on disk when several turns share identical assistant text.
 */
function getUserTurnOrdinalBefore(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): number {
  const messageTime = readMessageTime(message);
  let userCount = 0;

  for (const candidate of [...serverMessages, ...realtimeMessages].sort(compareMessagesChronologically)) {
    if (candidate.id === message.id) {
      break;
    }

    const candidateTime = readMessageTime(candidate);
    if (
      messageTime !== null
      && candidateTime !== null
      && candidateTime > messageTime
    ) {
      break;
    }

    if (candidate.kind === 'text' && candidate.role === 'user') {
      userCount++;
    }
  }

  return Math.max(0, userCount - 1);
}

function findServerTurnRangeByOrdinal(
  serverMessages: NormalizedMessage[],
  turnOrdinal: number,
): { start: number; end: number } | null {
  let userCount = -1;
  let start = -1;

  for (let index = 0; index < serverMessages.length; index++) {
    const message = serverMessages[index];
    if (message.kind === 'text' && message.role === 'user') {
      userCount++;
      if (userCount === turnOrdinal) {
        start = index;
        break;
      }
    }
  }

  if (start < 0) {
    return null;
  }

  let end = serverMessages.length;
  for (let index = start + 1; index < serverMessages.length; index++) {
    if (serverMessages[index].kind === 'text' && serverMessages[index].role === 'user') {
      end = index;
      break;
    }
  }

  return { start, end };
}

function isAssistantTextEchoedInSameTurnOnServer(
  message: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): boolean {
  const assistantText = (message.content || '').trim();
  if (!assistantText) {
    return false;
  }

  const turnOrdinal = getUserTurnOrdinalBefore(message, serverMessages, realtimeMessages);
  const turnRange = findServerTurnRangeByOrdinal(serverMessages, turnOrdinal);
  if (!turnRange) {
    return false;
  }

  return serverMessages
    .slice(turnRange.start + 1, turnRange.end)
    .some((serverMessage) =>
      serverMessage.kind === 'text'
      && serverMessage.role === 'assistant'
      && (serverMessage.content || '').trim() === assistantText,
    );
}

/**
 * After `finalizeStreaming`, the client holds a synthetic assistant `text` row
 * while the sessions API soon returns the same reply with a different id.
 * Those sit back-to-back in merged order and look like duplicate bubbles until
 * a persisted-tail refresh reconciles realtime. Collapse same-text assistant rows and
 * stream_placeholder → text when content matches.
 */
function dedupeAdjacentAssistantEchoes(merged: NormalizedMessage[]): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (const m of merged) {
    const prev = out[out.length - 1];
    if (prev) {
      if (prev.kind === 'stream_delta' && m.kind === 'text' && m.role === 'assistant') {
        const ps = (prev.content || '').trim();
        const ms = (m.content || '').trim();
        if (ps.length > 0 && ps === ms) {
          out[out.length - 1] = m;
          continue;
        }
      }
      if (
        prev.kind === 'text'
        && m.kind === 'text'
        && prev.role === 'assistant'
        && m.role === 'assistant'
      ) {
        const ms = (m.content || '').trim();
        if (ms.length > 0 && ms === (prev.content || '').trim()) {
          continue;
        }
      }
    }
    out.push(m);
  }
  return out;
}

/**
 * After a server refresh, drop only the realtime rows the persisted transcript
 * already owns. Anything not yet on disk (common right after `complete`, while
 * JSONL indexing lags) stays in `realtimeMessages` so the chat pane never
 * flashes the empty "Continue your conversation" state.
 */
function pruneRealtimeSupersededByServer(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  if (realtimeMessages.length === 0) {
    return realtimeMessages;
  }

  const serverIds = new Set(serverMessages.map((message) => message.id));
  const reconciledRealtimeMessages = removeOptimisticUserEchoes(serverMessages, realtimeMessages);

  return reconciledRealtimeMessages.filter((message) => {
    if (serverIds.has(message.id)) {
      return false;
    }

    if (message.kind === 'stream_delta' || message.id === `__streaming_${message.sessionId}`) {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages)) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'assistant') {
      if (isAssistantTextEchoedInSameTurnOnServer(message, serverMessages, realtimeMessages)) {
        return false;
      }
      return true;
    }

    if (message.kind === 'text' && message.role === 'user') {
      return true;
    }

    if (message.kind === 'tool_use' && message.toolId) {
      if (serverMessages.some((serverMessage) => serverMessage.kind === 'tool_use' && serverMessage.toolId === message.toolId)) {
        return false;
      }
    }

    return true;
  });
}

function computeMerged(server: NormalizedMessage[], realtime: NormalizedMessage[]): NormalizedMessage[] {
  if (realtime.length === 0) {
    return dedupeAdjacentAssistantEchoes(server);
  }
  if (server.length === 0) {
    return dedupeAdjacentAssistantEchoes(realtime);
  }

  const serverIds = new Set(server.map((message) => message.id));
  const reconciledRealtime = removeOptimisticUserEchoes(server, realtime);
  const extra = reconciledRealtime.filter((message) => {
    if (serverIds.has(message.id)) {
      return false;
    }
    return true;
  });

  if (extra.length === 0) {
    return dedupeAdjacentAssistantEchoes(server);
  }

  // Interleave by timestamp so live rows stay with their turn instead of
  // piling up at the bottom after every refresh.
  return dedupeAdjacentAssistantEchoes(
    [...server, ...extra].sort(compareMessagesChronologically),
  );
}

/**
 * Recompute slot.merged only when the input arrays have actually changed
 * (by reference). Returns true if merged was recomputed.
 */
function recomputeMergedIfNeeded(slot: SessionSlot): boolean {
  if (slot.serverMessages === slot._lastServerRef && slot.realtimeMessages === slot._lastRealtimeRef) {
    return false;
  }
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot.merged = computeMerged(slot.serverMessages, slot.realtimeMessages);
  return true;
}

// ─── Stale threshold ─────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 30_000;

const MAX_REALTIME_MESSAGES = 500;

// ─── Pagination helpers ───────────────────────────────────────────────────────

type LatestHistoryRefreshResult = {
  applied: boolean;
  changed: boolean;
  deferred: boolean;
};

type CanRequestHistory = () => boolean;

// Token usage is JSON response data, so compare its serialized value instead
// of treating each freshly parsed response object as a state change.
function hasEquivalentTokenUsage(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right);
}

function olderPagePrecedesCachedHistory(
  olderMessages: NormalizedMessage[],
  cachedMessages: NormalizedMessage[],
): boolean {
  const olderNewest = olderMessages[olderMessages.length - 1];
  const cachedOldest = cachedMessages[0];
  if (!olderNewest || !cachedOldest) return true;

  const olderTime = readMessageTime(olderNewest);
  const cachedTime = readMessageTime(cachedOldest);
  return olderTime === null || cachedTime === null || olderTime <= cachedTime;
}

/**
 * Fetches and atomically applies a bounded persisted-tail reconciliation.
 * Every request is finite. Claude/Codex bridge discovery may use more than one
 * bounded chunk because their response `total` omits paginated tool results.
 */
async function refreshLatestSlotFromServer(
  sessionId: string,
  slot: SessionSlot,
  limit: number,
  canRequest: CanRequestHistory = () => true,
): Promise<LatestHistoryRefreshResult> {
  if (!canRequest()) {
    return { applied: false, changed: false, deferred: true };
  }

  const previousServerMessages = slot.serverMessages;
  const previousTotal = slot.total;
  const previousHasMore = slot.hasMore;
  const latestPage = await requestSessionHistoryPage(sessionId, {
    limit,
    offset: 0,
  });

  let nextServerMessages: NormalizedMessage[] | null = null;
  let nextHasMore = previousHasMore;

  // A page with no older rows is the complete authoritative transcript. This
  // also removes cached rows after a provider-side truncation.
  if (!latestPage.hasMore) {
    nextServerMessages = latestPage.messages;
    nextHasMore = false;
  } else if (previousServerMessages.length === 0) {
    nextServerMessages = latestPage.messages;
    nextHasMore = true;
  } else {
    let fetchedWindow = latestPage.messages;
    let oldestFetchedPage = latestPage;
    let bridgeRowsFetched = 0;
    let reachedStartOfHistory = false;
    let mergedPage = mergeLatestServerPage(previousServerMessages, fetchedWindow);

    while (
      mergedPage.overlapLength === 0
      && !hasReachedCachedTailTimeBoundary(previousServerMessages, fetchedWindow)
    ) {
      const bridgeRequest = planLatestPageBridge(
        previousServerMessages,
        latestPage.messages,
        previousTotal,
        latestPage.total,
        bridgeRowsFetched,
      );
      if (!bridgeRequest) break;
      if (!canRequest()) {
        return { applied: false, changed: false, deferred: true };
      }

      const bridgePage = await requestSessionHistoryPage(sessionId, bridgeRequest);
      if (bridgePage.total !== latestPage.total) {
        console.warn(`[SessionStore] History changed while bridging ${sessionId}; retaining cached suffix.`);
        return { applied: false, changed: false, deferred: false };
      }
      if (bridgePage.messages.length === 0) break;

      const bridgeMerge = mergeOlderServerPage(fetchedWindow, bridgePage.messages);
      if (
        bridgeMerge.overlapLength > 0
        || !olderPagePrecedesCachedHistory(bridgePage.messages, fetchedWindow)
      ) {
        console.warn(`[SessionStore] History shifted while bridging ${sessionId}; retaining cached suffix.`);
        return { applied: false, changed: false, deferred: false };
      }

      fetchedWindow = bridgeMerge.messages;
      oldestFetchedPage = bridgePage;
      bridgeRowsFetched += bridgePage.messages.length;
      mergedPage = mergeLatestServerPage(previousServerMessages, fetchedWindow);

      if (!bridgePage.hasMore) {
        reachedStartOfHistory = true;
        break;
      }
    }

    if (reachedStartOfHistory) {
      nextServerMessages = fetchedWindow;
      nextHasMore = false;
    } else if (mergedPage.overlapLength > 0) {
      nextServerMessages = mergedPage.messages;
      nextHasMore = resolveLatestPagePagination(
        previousServerMessages.length,
        nextServerMessages.length,
        previousHasMore,
        oldestFetchedPage.hasMore,
      ).hasMore;
    }
  }

  let changed = false;
  if (
    latestPage.tokenUsage !== undefined
    && !hasEquivalentTokenUsage(latestPage.tokenUsage, slot.tokenUsage)
  ) {
    slot.tokenUsage = latestPage.tokenUsage;
    changed = true;
  }

  if (!nextServerMessages) {
    console.warn(`[SessionStore] Could not bridge latest history for ${sessionId}; retaining cached suffix.`);
    return { applied: false, changed, deferred: false };
  }

  slot.serverMessages = nextServerMessages;
  slot.total = latestPage.total;
  slot.offset = nextServerMessages.length;
  slot.hasMore = nextHasMore;
  slot.fetchedAt = Date.now();
  slot.realtimeMessages = pruneRealtimeSupersededByServer(
    slot.serverMessages,
    slot.realtimeMessages,
  );
  recomputeMergedIfNeeded(slot);

  return { applied: true, changed: true, deferred: false };
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSessionStore() {
  const storeRef = useRef(new Map<string, SessionSlot>());
  const sessionAliasesRef = useRef(new Map<string, string>());
  const activeSessionIdRef = useRef<string | null>(null);
  // Bump to force re-render — only when the active session's data changes
  const [, setTick] = useState(0);
  const notify = useCallback((sessionId: string) => {
    const aliases = sessionAliasesRef.current;
    let resolvedSessionId = sessionId;
    const visited = new Set<string>();

    while (aliases.has(resolvedSessionId) && !visited.has(resolvedSessionId)) {
      visited.add(resolvedSessionId);
      resolvedSessionId = aliases.get(resolvedSessionId)!;
    }

    if (resolvedSessionId === activeSessionIdRef.current) {
      // Use startTransition so streaming updates are low-priority — the browser
      // processes user input events (typing) before re-rendering the message list.
      startTransition(() => setTick(n => n + 1));
    }
  }, []);

  const resolveSessionId = useCallback((sessionId: string | null | undefined): string | null => {
    if (!sessionId) {
      return null;
    }

    const aliases = sessionAliasesRef.current;
    let resolvedSessionId = sessionId;
    const visited = new Set<string>();

    while (aliases.has(resolvedSessionId) && !visited.has(resolvedSessionId)) {
      visited.add(resolvedSessionId);
      resolvedSessionId = aliases.get(resolvedSessionId)!;
    }

    return resolvedSessionId;
  }, []);

  const setActiveSession = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = resolveSessionId(sessionId);
  }, [resolveSessionId]);

  const getSlot = useCallback((sessionId: string): SessionSlot => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const store = storeRef.current;
    if (!store.has(resolvedSessionId)) {
      store.set(resolvedSessionId, createEmptySlot());
    }
    return store.get(resolvedSessionId)!;
  }, [resolveSessionId]);

  const has = useCallback((sessionId: string) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    return storeRef.current.has(resolvedSessionId);
  }, [resolveSessionId]);

  /**
   * Fetch messages from the provider sessions endpoint and populate serverMessages.
   *
   * Provider and project metadata are resolved server-side from `sessionId`.
   */
  const fetchFromServer = useCallback(async (
    sessionId: string,
    opts: {
      provider?: LLMProvider;
      projectId?: string;
      projectPath?: string;
      limit?: number | null;
      offset?: number;
      canRequest?: CanRequestHistory;
    } = {},
  ) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    slot.status = 'loading';
    notify(resolvedSessionId);

    return enqueueHistoryMutation(slot, async () => {
      const { canRequest = () => true, provider: _p, projectId: _pId, projectPath: _pp, ...requestOptions } = opts;
      if (!canRequest()) {
        slot.status = 'idle';
        notify(resolvedSessionId);
        return null;
      }

      try {
        const data = await requestSessionHistoryPage(resolvedSessionId, requestOptions);
        slot.serverMessages = data.messages;
        slot.total = data.total;
        slot.hasMore = data.hasMore;
        slot.offset = (requestOptions.offset ?? 0) + data.messages.length;
        slot.fetchedAt = Date.now();
        slot.status = 'idle';
        slot.realtimeMessages = pruneRealtimeSupersededByServer(
          slot.serverMessages,
          slot.realtimeMessages,
        );
        recomputeMergedIfNeeded(slot);
        if (data.tokenUsage !== undefined) {
          slot.tokenUsage = data.tokenUsage;
        }

        notify(resolvedSessionId);
        return slot;
      } catch (error) {
        console.error(`[SessionStore] fetch failed for ${resolvedSessionId}:`, error);
        slot.status = 'error';
        notify(resolvedSessionId);
        return slot;
      }
    });
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Load older (paginated) messages and prepend to serverMessages.
   */
  const fetchMore = useCallback(async (
    sessionId: string,
    opts: {
      provider?: LLMProvider;
      projectId?: string;
      projectPath?: string;
      limit?: number;
      canRequest?: CanRequestHistory;
    } = {},
  ) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);

    return enqueueHistoryMutation(slot, async () => {
      let prependedCount = 0;
      let changed = false;
      const canRequest = opts.canRequest ?? (() => true);
      if (!slot.hasMore || !canRequest()) return { slot, prependedCount };

      try {
        // A tail-relative offset can shift while JSONL is still growing. One
        // bounded latest-page reconciliation realigns the cache, after which
        // the older-page request is retried once with the new raw-row offset.
        for (let attempt = 0; attempt < 2 && slot.hasMore; attempt++) {
          if (!canRequest()) break;

          const cachedMessages = slot.serverMessages;
          const expectedTotal = slot.total;
          const data = await requestSessionHistoryPage(resolvedSessionId, {
            limit: opts.limit ?? SESSION_MESSAGES_PAGE_SIZE,
            offset: slot.offset,
          });
          const olderMerge = mergeOlderServerPage(cachedMessages, data.messages);
          const shiftedWhileFetching = (
            data.total !== expectedTotal
            || olderMerge.overlapLength > 0
            || !olderPagePrecedesCachedHistory(data.messages, cachedMessages)
          );

          if (shiftedWhileFetching) {
            if (attempt > 0 || !canRequest()) break;
            const latestResult = await refreshLatestSlotFromServer(
              resolvedSessionId,
              slot,
              SESSION_MESSAGES_PAGE_SIZE,
              canRequest,
            );
            changed = changed || latestResult.changed;
            if (!latestResult.applied) break;
            continue;
          }

          slot.serverMessages = olderMerge.messages;
          slot.hasMore = data.hasMore;
          slot.total = data.total;
          slot.offset = slot.serverMessages.length;
          prependedCount = olderMerge.prependedCount;
          if (data.tokenUsage !== undefined) {
            slot.tokenUsage = data.tokenUsage;
          }
          recomputeMergedIfNeeded(slot);
          changed = true;
          break;
        }

        if (changed) notify(resolvedSessionId);
        return { slot, prependedCount };
      } catch (error) {
        console.error(`[SessionStore] fetchMore failed for ${resolvedSessionId}:`, error);
        if (changed) notify(resolvedSessionId);
        return { slot, prependedCount };
      }
    });
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Append a realtime (WebSocket) message to the correct session slot.
   * This works regardless of which session is actively viewed.
   */
  const appendRealtime = useCallback((sessionId: string, msg: NormalizedMessage) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    const normalizedMessage =
      msg.sessionId === resolvedSessionId
        ? msg
        : { ...msg, sessionId: resolvedSessionId };
    let updated = [...slot.realtimeMessages, normalizedMessage];
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(resolvedSessionId);
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Append multiple realtime messages at once (batch).
   */
  const appendRealtimeBatch = useCallback((sessionId: string, msgs: NormalizedMessage[]) => {
    if (msgs.length === 0) return;
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    const normalizedMessages = msgs.map((msg) =>
      msg.sessionId === resolvedSessionId
        ? msg
        : { ...msg, sessionId: resolvedSessionId },
    );
    let updated = [...slot.realtimeMessages, ...normalizedMessages];
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(resolvedSessionId);
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Refreshes only the persisted tail and stitches it onto the contiguous
   * cached suffix. Large turns request a small offset bridge rather than the
   * whole transcript, and the final state is applied atomically.
   */
  const refreshLatestFromServer = useCallback(async (
    sessionId: string,
    opts: {
      limit?: number;
      canRequest?: CanRequestHistory;
      // Legacy opts accepted but ignored (kept for call-site compatibility)
      provider?: LLMProvider;
      projectId?: string;
      projectPath?: string;
    } = {},
  ) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);

    return enqueueHistoryMutation(slot, async () => {
      try {
        const result = await refreshLatestSlotFromServer(
          resolvedSessionId,
          slot,
          opts.limit ?? SESSION_MESSAGES_PAGE_SIZE,
          opts.canRequest,
        );
        if (result.changed) notify(resolvedSessionId);
        return { slot, ...result };
      } catch (error) {
        console.error(`[SessionStore] latest refresh failed for ${resolvedSessionId}:`, error);
        return { slot, applied: false, changed: false, deferred: false };
      }
    });
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Update session status.
   */
  const setStatus = useCallback((sessionId: string, status: SessionStatus) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    slot.status = status;
    notify(resolvedSessionId);
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Check if a session's data is stale (>30s old).
   */
  const isStale = useCallback((sessionId: string) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = storeRef.current.get(resolvedSessionId);
    if (!slot) return true;
    return Date.now() - slot.fetchedAt > STALE_THRESHOLD_MS;
  }, [resolveSessionId]);

  /**
   * Update or create a streaming message (accumulated text so far).
   * Uses a well-known ID so subsequent calls replace the same message.
   */
  const updateStreaming = useCallback((sessionId: string, accumulatedText: string, msgProvider: LLMProvider) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = getSlot(resolvedSessionId);
    const streamId = `__streaming_${resolvedSessionId}`;
    const msg: NormalizedMessage = {
      id: streamId,
      sessionId: resolvedSessionId,
      timestamp: new Date().toISOString(),
      provider: msgProvider,
      kind: 'stream_delta',
      content: accumulatedText,
    };
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = msg;
    } else {
      slot.realtimeMessages = [...slot.realtimeMessages, msg];
    }
    recomputeMergedIfNeeded(slot);
    notify(resolvedSessionId);
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Finalize streaming: convert the streaming message to a regular text message.
   * The well-known streaming ID is replaced with a unique text message ID.
   */
  const finalizeStreaming = useCallback((sessionId: string) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = storeRef.current.get(resolvedSessionId);
    if (!slot) return;
    const streamId = `__streaming_${resolvedSessionId}`;
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      const stream = slot.realtimeMessages[idx];
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = {
        ...stream,
        id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind: 'text',
        role: 'assistant',
      };
      recomputeMergedIfNeeded(slot);
      notify(resolvedSessionId);
    }
  }, [notify, resolveSessionId]);

  /**
   * Clear realtime messages for a session (e.g., after stream completes and server fetch catches up).
   */
  const clearRealtime = useCallback((sessionId: string) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = storeRef.current.get(resolvedSessionId);
    if (slot) {
      slot.realtimeMessages = [];
      recomputeMergedIfNeeded(slot);
      notify(resolvedSessionId);
    }
  }, [notify, resolveSessionId]);

  const popLastUserMessage = useCallback((sessionId: string) => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    const slot = storeRef.current.get(resolvedSessionId);
    if (!slot) return;
    const messages = slot.realtimeMessages;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].kind === 'text' && messages[i].role === 'user') {
        slot.realtimeMessages = [...messages.slice(0, i), ...messages.slice(i + 1)];
        recomputeMergedIfNeeded(slot);
        notify(resolvedSessionId);
        return;
      }
    }
  }, [getSlot, notify, resolveSessionId]);

  /**
   * Get merged messages for a session (for rendering).
   */
  const getMessages = useCallback((sessionId: string): NormalizedMessage[] => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    return storeRef.current.get(resolvedSessionId)?.merged ?? [];
  }, [resolveSessionId]);

  /**
   * Get session slot (for status, pagination info, etc.).
   */
  const getSessionSlot = useCallback((sessionId: string): SessionSlot | undefined => {
    const resolvedSessionId = resolveSessionId(sessionId) ?? sessionId;
    return storeRef.current.get(resolvedSessionId);
  }, [resolveSessionId]);

  const replaceSessionId = useCallback((fromSessionId: string, toSessionId: string) => {
    const resolvedFromSessionId = resolveSessionId(fromSessionId) ?? fromSessionId;
    const resolvedToSessionId = resolveSessionId(toSessionId) ?? toSessionId;

    if (resolvedFromSessionId === resolvedToSessionId) {
      sessionAliasesRef.current.set(fromSessionId, resolvedToSessionId);
      return;
    }

    const store = storeRef.current;
    const sourceSlot = store.get(resolvedFromSessionId);
    const targetSlot = store.get(resolvedToSessionId) ?? createEmptySlot();

    if (sourceSlot) {
      const migratedServerMessages = sourceSlot.serverMessages.map((msg) =>
        rewriteMessageSessionId(msg, resolvedFromSessionId, resolvedToSessionId),
      );
      const migratedRealtimeMessages = sourceSlot.realtimeMessages.map((msg) =>
        rewriteMessageSessionId(msg, resolvedFromSessionId, resolvedToSessionId),
      );

      targetSlot.serverMessages = mergeMessagesById(targetSlot.serverMessages, migratedServerMessages);
      targetSlot.realtimeMessages = mergeMessagesById(targetSlot.realtimeMessages, migratedRealtimeMessages);
      if (targetSlot.realtimeMessages.length > MAX_REALTIME_MESSAGES) {
        targetSlot.realtimeMessages = targetSlot.realtimeMessages.slice(-MAX_REALTIME_MESSAGES);
      }
      targetSlot.status =
        sourceSlot.status === 'error'
          ? 'error'
          : sourceSlot.status === 'streaming' || targetSlot.status === 'streaming'
            ? 'streaming'
            : sourceSlot.status === 'loading' || targetSlot.status === 'loading'
              ? 'loading'
              : targetSlot.status;
      targetSlot.fetchedAt = Math.max(targetSlot.fetchedAt, sourceSlot.fetchedAt, Date.now());
      targetSlot.total = Math.max(
        targetSlot.total,
        sourceSlot.total,
        targetSlot.serverMessages.length,
        targetSlot.realtimeMessages.length,
      );
      targetSlot.hasMore = targetSlot.hasMore || sourceSlot.hasMore;
      targetSlot.offset = Math.max(targetSlot.offset, sourceSlot.offset);
      targetSlot.tokenUsage = targetSlot.tokenUsage ?? sourceSlot.tokenUsage;
      recomputeMergedIfNeeded(targetSlot);

      store.set(resolvedToSessionId, targetSlot);
      store.delete(resolvedFromSessionId);
    }

    sessionAliasesRef.current.set(resolvedFromSessionId, resolvedToSessionId);
    sessionAliasesRef.current.set(fromSessionId, resolvedToSessionId);

    for (const [aliasSessionId, targetSessionId] of sessionAliasesRef.current.entries()) {
      if (targetSessionId === resolvedFromSessionId) {
        sessionAliasesRef.current.set(aliasSessionId, resolvedToSessionId);
      }
    }

    if (activeSessionIdRef.current === resolvedFromSessionId) {
      activeSessionIdRef.current = resolvedToSessionId;
    }

    notify(resolvedToSessionId);
  }, [notify, resolveSessionId]);

  return useMemo(() => ({
    getSlot,
    has,
    fetchFromServer,
    fetchMore,
    appendRealtime,
    appendRealtimeBatch,
    refreshLatestFromServer,
    setActiveSession,
    setStatus,
    isStale,
    updateStreaming,
    finalizeStreaming,
    clearRealtime,
    popLastUserMessage,
    getMessages,
    getSessionSlot,
    replaceSessionId,
  }), [
    getSlot, has, fetchFromServer, fetchMore,
    appendRealtime, appendRealtimeBatch, refreshLatestFromServer,
    setActiveSession, setStatus, isStale, updateStreaming, finalizeStreaming,
    clearRealtime, popLastUserMessage, getMessages, getSessionSlot, replaceSessionId,
  ]);
}

export type SessionStore = ReturnType<typeof useSessionStore>;
