/**
 * Pure helpers for derived (forked) Claude sessions.
 *
 * Kept free of database and SDK imports so the synchronizer, the fork service
 * and the agent tool can share them, and tests can exercise them directly.
 */

/** Most derived sessions one agent turn may create. */
export const MAX_DERIVED_SESSIONS_PER_TURN = 5;

/**
 * Deepest allowed derivation chain. A root session has depth 0, its derived
 * session depth 1, and so on; a session at this depth cannot derive further.
 */
export const MAX_DERIVED_SESSION_DEPTH = 3;

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Reads the parent session id from one transcript row.
 *
 * `forkSession` (SDK) stamps every copied row with
 * `forkedFrom: { sessionId, messageUuid }`. A marker that points at the row's
 * own session is ignored, which keeps a malformed file from becoming its own
 * parent.
 */
export function readForkedFromSessionId(row: unknown): string | null {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const record = row as Record<string, unknown>;
  const forkedFrom = record.forkedFrom;
  if (!forkedFrom || typeof forkedFrom !== 'object') {
    return null;
  }

  const parentId = (forkedFrom as Record<string, unknown>).sessionId;
  if (typeof parentId !== 'string' || !parentId.trim()) {
    return null;
  }

  const ownId = typeof record.sessionId === 'string' ? record.sessionId : null;
  return parentId === ownId ? null : parentId.trim();
}

/**
 * The client addresses chat rows with ids such as `<uuid>_0` (one transcript
 * row split per content block). The transcript only knows the bare uuid.
 */
export function extractTranscriptUuid(messageId: unknown): string | null {
  if (typeof messageId !== 'string') {
    return null;
  }
  const match = messageId.match(UUID_PATTERN);
  return match ? match[0] : null;
}

type TranscriptContentBlock = { type?: unknown; id?: unknown; tool_use_id?: unknown };

export type TranscriptMessageLike = {
  type?: unknown;
  uuid?: unknown;
  message?: unknown;
};

function readContentBlocks(entry: TranscriptMessageLike): TranscriptContentBlock[] {
  const message = entry.message as { content?: unknown } | undefined;
  return Array.isArray(message?.content) ? (message.content as TranscriptContentBlock[]) : [];
}

/**
 * Picks where a fork of a still-running session should end: the last message
 * after which no tool call is waiting for its result.
 *
 * When the agent forks the session it is running in, the transcript ends with
 * its own unanswered tool call. Copying that call would leave the derived
 * session resuming into a tool_use without a tool_result, so the cut stops
 * before it. Returns null when no such point exists.
 */
export function pickForkCutPoint(messages: TranscriptMessageLike[]): string | null {
  const openToolUses = new Set<string>();
  let cut: string | null = null;

  for (const entry of messages) {
    if (entry.type !== 'user' && entry.type !== 'assistant') {
      continue;
    }

    for (const block of readContentBlocks(entry)) {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        openToolUses.add(block.id);
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        openToolUses.delete(block.tool_use_id);
      }
    }

    if (openToolUses.size === 0 && typeof entry.uuid === 'string') {
      cut = entry.uuid;
    }
  }

  return cut;
}

/** Last assistant text in a transcript, used to report a derived session's result. */
export function readLastAssistantText(messages: TranscriptMessageLike[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (entry?.type !== 'assistant') {
      continue;
    }
    const message = entry.message as { content?: unknown } | undefined;
    if (typeof message?.content === 'string' && message.content.trim()) {
      return message.content.trim();
    }
    const texts = readContentBlocks(entry)
      .filter((block) => block.type === 'text' && typeof (block as { text?: unknown }).text === 'string')
      .map((block) => String((block as { text?: unknown }).text).trim())
      .filter(Boolean);
    if (texts.length > 0) {
      return texts.join('\n\n');
    }
  }
  return null;
}

export type DerivedSessionGuardInput = {
  /** Derived sessions already created during the current turn. */
  createdThisTurn: number;
  /** Depth of the session the agent is running in (root = 0). */
  currentDepth: number;
};

/** Returns a refusal message, or null when another derived session is allowed. */
export function checkDerivedSessionGuardrails({ createdThisTurn, currentDepth }: DerivedSessionGuardInput): string | null {
  if (createdThisTurn >= MAX_DERIVED_SESSIONS_PER_TURN) {
    return `Limit reached: a single turn may create at most ${MAX_DERIVED_SESSIONS_PER_TURN} derived sessions.`;
  }
  if (currentDepth + 1 > MAX_DERIVED_SESSION_DEPTH) {
    return `Limit reached: derived sessions may be nested at most ${MAX_DERIVED_SESSION_DEPTH} levels deep, and this session is already at depth ${currentDepth}.`;
  }
  return null;
}
