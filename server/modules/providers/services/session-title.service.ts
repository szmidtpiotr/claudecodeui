import fsSync from 'node:fs';
import readline from 'node:readline';

import Anthropic from '@anthropic-ai/sdk';

import { appConfigDb, sessionsDb } from '@/modules/database/index.js';
import {
  buildAnthropicClientOptions,
  readCredentialToken,
} from '@/modules/providers/list/claude/claude-credentials.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { emitSessionMetadataChanged } from '@/modules/providers/services/session-events.js';
import type { LLMProvider, NormalizedMessage } from '@/shared/types.js';

const TITLE_MODEL = 'claude-haiku-4-5-20251001';
const TITLE_MAX_TOKENS = 48;

/** Longest title we will store; longer model output is rejected, not truncated. */
const MAX_TITLE_LENGTH = 70;

/** How much transcript the model sees. Enough for intent, cheap enough to run per session. */
const EXCERPT_MESSAGE_LIMIT = 6;
const EXCERPT_CHARS_PER_MESSAGE = 600;
const EXCERPT_TOTAL_CHARS = 2400;

/** Sessions retitled per automatic backlog pass, so a first run cannot fan out. */
const AUTO_TITLE_BATCH_SIZE = 5;

/**
 * An install that predates title generation has one derived title per historical
 * session, which a single pass would never clear. The backlog is drained on a
 * timer instead: a small batch per tick keeps the spend visible and gradual
 * rather than firing hundreds of requests at startup.
 */
const BACKLOG_DRAIN_INTERVAL_MS = 60_000;
let backlogDrainTimer: ReturnType<typeof setInterval> | null = null;
let backlogDrainInFlight = false;

const AUTO_TITLE_CONFIG_KEY = 'session_auto_title_enabled';

const SYSTEM_PROMPT = [
  'You write short titles for coding-assistant sessions.',
  'Given an excerpt of a conversation, reply with ONLY the title — no quotes, no punctuation at the end, no preamble.',
  'The title must describe what the session is actually about: the task, the bug, or the outcome.',
  'Use 3 to 8 words. Never mention "session", "chat", "conversation", or the assistant by name.',
  'Write the title in the same language the user writes in.',
].join(' ');

type TranscriptExcerpt = {
  text: string;
  /**
   * A session with no reply yet is only a prompt. Titling it would lock in a
   * title that describes the request rather than the work, so generation waits.
   */
  hasAssistantReply: boolean;
};

export type SessionTitleOutcome = {
  sessionId: string;
  title: string | null;
  source: 'ai' | 'derived' | null;
  /** Populated when no title was written, so callers can surface a reason. */
  reason?: string;
};

/**
 * Guards against two callers generating a title for the same session at once
 * (e.g. an automatic backlog pass overlapping a manual regenerate click).
 */
const inFlightSessions = new Set<string>();

/**
 * The transcript watcher re-indexes a session on every write, so an
 * unsuccessful attempt is remembered briefly. Without it a session that cannot
 * be titled (no credential, network down, model returns nothing usable) would
 * be retried once per message.
 */
const FAILED_ATTEMPT_COOLDOWN_MS = 10 * 60 * 1000;
const lastFailedAttemptAt = new Map<string, number>();

function isInFailureCooldown(sessionId: string): boolean {
  const failedAt = lastFailedAttemptAt.get(sessionId);
  if (failedAt === undefined) {
    return false;
  }

  if (Date.now() - failedAt < FAILED_ATTEMPT_COOLDOWN_MS) {
    return true;
  }

  lastFailedAttemptAt.delete(sessionId);
  return false;
}

/** Auto-titling costs tokens, so it is opt-out via app config rather than always-on. */
export function isAutoTitleEnabled(): boolean {
  return appConfigDb.get(AUTO_TITLE_CONFIG_KEY) !== 'false';
}

export function setAutoTitleEnabled(enabled: boolean): void {
  appConfigDb.set(AUTO_TITLE_CONFIG_KEY, enabled ? 'true' : 'false');
}

function normalizeGeneratedTitle(raw: string): string | null {
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) {
    return null;
  }

  // Models occasionally wrap the answer in quotes or lead with "Title:".
  const unwrapped = firstLine
    .replace(/^(?:title|tytuł)\s*[:\-–]\s*/i, '')
    .replace(/^["'`«»]+|["'`«»]+$/g, '')
    .replace(/[.。]+$/, '')
    .trim();

  if (!unwrapped || unwrapped.length > MAX_TITLE_LENGTH) {
    return null;
  }

  return unwrapped;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Builds the transcript excerpt the model titles from.
 *
 * Only user and assistant text carries intent, so tool calls, thinking blocks,
 * and empty rows are dropped before the character budget is applied.
 */
function buildExcerpt(messages: NormalizedMessage[]): TranscriptExcerpt | null {
  const usable: string[] = [];
  let hasAssistantReply = false;
  let totalChars = 0;

  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue;
    }

    const text = collapseWhitespace(String(message.content ?? message.displayText ?? ''));
    if (!text) {
      continue;
    }

    const clipped = text.length > EXCERPT_CHARS_PER_MESSAGE
      ? `${text.slice(0, EXCERPT_CHARS_PER_MESSAGE)}…`
      : text;

    usable.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${clipped}`);
    hasAssistantReply = hasAssistantReply || message.role === 'assistant';
    totalChars += clipped.length;

    if (usable.length >= EXCERPT_MESSAGE_LIMIT || totalChars >= EXCERPT_TOTAL_CHARS) {
      break;
    }
  }

  if (usable.length === 0) {
    return null;
  }

  return { text: usable.join('\n\n'), hasAssistantReply };
}

async function loadTranscriptExcerpt(
  sessionId: string,
  provider: LLMProvider,
  projectPath: string,
): Promise<TranscriptExcerpt | null> {
  try {
    const history = await providerRegistry.resolveProvider(provider).sessions.fetchHistory(sessionId, {
      limit: EXCERPT_MESSAGE_LIMIT * 4,
      offset: 0,
      projectPath,
    });

    return buildExcerpt(history.messages ?? []);
  } catch {
    return null;
  }
}

/**
 * Reads a summary line Claude already wrote into the transcript.
 *
 * Claude records `type: "summary"` rows and compaction summaries that describe
 * the session in prose. They are the best free fallback when the API call is
 * unavailable — no credential, no network, or a rejected response.
 */
async function readTranscriptSummary(jsonlPath: string): Promise<string | null> {
  if (!jsonlPath || !fsSync.existsSync(jsonlPath)) {
    return null;
  }

  let latestSummary: string | null = null;

  try {
    const stream = fsSync.createReadStream(jsonlPath);
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (entry.type === 'summary' && typeof entry.summary === 'string' && entry.summary.trim()) {
        latestSummary = entry.summary.trim();
      }
    }
  } catch {
    return null;
  }

  if (!latestSummary) {
    return null;
  }

  const firstSentence = latestSummary.split(/(?<=[.!?])\s/)[0]?.trim() || latestSummary;
  return firstSentence.length > MAX_TITLE_LENGTH
    ? `${firstSentence.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
    : firstSentence;
}

async function requestTitleFromModel(excerpt: string): Promise<string | null> {
  const credential = await readCredentialToken();
  if (!credential) {
    return null;
  }

  try {
    const client = new Anthropic(buildAnthropicClientOptions(credential));
    const response = await client.messages.create({
      model: TITLE_MODEL,
      max_tokens: TITLE_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: excerpt }],
    });

    const text = (response.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .filter(Boolean)
      .join(' ');

    return normalizeGeneratedTitle(text);
  } catch (error) {
    // Titling is best-effort, but a silent catch makes an expired token or a
    // rejected model look identical to "the transcript had nothing to say".
    const status = (error as { status?: number })?.status;
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[Sessions] Title generation request failed', { status, message });
    return null;
  }
}

export const sessionTitleService = {
  isAutoTitleEnabled,
  setAutoTitleEnabled,

  /**
   * Generates and stores a descriptive title for one session.
   *
   * Titles the user set, and titles a previous run already generated, are left
   * alone unless `force` is passed (the manual "regenerate" action). The model
   * call is primary; a summary Claude already wrote into the transcript is the
   * fallback when the call cannot run or returns nothing usable.
   */
  async generateTitleForSession(
    sessionId: string,
    options: { force?: boolean } = {},
  ): Promise<SessionTitleOutcome> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      return { sessionId, title: null, source: null, reason: 'SESSION_NOT_FOUND' };
    }

    const isEligible = options.force === true
      || session.name_source === null
      || session.name_source === 'derived';
    if (!isEligible) {
      return { sessionId, title: null, source: null, reason: 'TITLE_NOT_ELIGIBLE' };
    }

    if (inFlightSessions.has(sessionId)) {
      return { sessionId, title: null, source: null, reason: 'TITLE_ALREADY_GENERATING' };
    }

    if (options.force !== true && isInFailureCooldown(sessionId)) {
      return { sessionId, title: null, source: null, reason: 'TITLE_ATTEMPT_COOLING_DOWN' };
    }

    inFlightSessions.add(sessionId);
    try {
      const excerpt = await loadTranscriptExcerpt(
        sessionId,
        session.provider as LLMProvider,
        session.project_path ?? '',
      );

      if (excerpt && !excerpt.hasAssistantReply && options.force !== true) {
        return { sessionId, title: null, source: null, reason: 'SESSION_HAS_NO_REPLY_YET' };
      }

      const provider = session.provider as LLMProvider;

      const generated = excerpt ? await requestTitleFromModel(excerpt.text) : null;
      if (generated) {
        lastFailedAttemptAt.delete(sessionId);
        sessionsDb.updateSessionCustomName(sessionId, generated, 'ai');
        emitSessionMetadataChanged({ sessionId, provider });
        return { sessionId, title: generated, source: 'ai' };
      }

      // The model produced nothing usable, so fall back — but still record the
      // failed attempt: the fallback keeps `derived`, which stays a candidate.
      lastFailedAttemptAt.set(sessionId, Date.now());

      const summaryTitle = await readTranscriptSummary(session.jsonl_path ?? '');
      if (summaryTitle && summaryTitle !== session.custom_name) {
        sessionsDb.updateSessionCustomName(sessionId, summaryTitle, 'derived');
        emitSessionMetadataChanged({ sessionId, provider });
        return { sessionId, title: summaryTitle, source: 'derived' };
      }

      return { sessionId, title: null, source: null, reason: 'NO_TITLE_AVAILABLE' };
    } finally {
      inFlightSessions.delete(sessionId);
    }
  },

  /**
   * Works through the backlog of machine-derived titles in small batches.
   *
   * Called after a session sync, so a long-running install catches up over
   * several passes instead of firing one request per historical session.
   */
  async generateMissingTitles(batchSize = AUTO_TITLE_BATCH_SIZE): Promise<SessionTitleOutcome[]> {
    if (!isAutoTitleEnabled()) {
      return [];
    }

    const candidates = sessionsDb.getSessionsNeedingGeneratedTitle(batchSize);
    const outcomes: SessionTitleOutcome[] = [];

    for (const candidate of candidates) {
      outcomes.push(await this.generateTitleForSession(candidate.session_id));
    }

    return outcomes;
  },

  /**
   * Starts the periodic backlog drain.
   *
   * The timer is unreferenced so it never keeps the process alive, and a tick
   * is skipped entirely while the previous one is still running.
   */
  startBacklogDrain(): void {
    if (backlogDrainTimer) {
      return;
    }

    backlogDrainTimer = setInterval(() => {
      if (backlogDrainInFlight || !isAutoTitleEnabled()) {
        return;
      }

      backlogDrainInFlight = true;
      void sessionTitleService
        .generateMissingTitles()
        .catch((error: unknown) => {
          console.warn('[Sessions] Session title backlog drain failed:', error);
        })
        .finally(() => {
          backlogDrainInFlight = false;
        });
    }, BACKLOG_DRAIN_INTERVAL_MS);

    backlogDrainTimer.unref?.();
  },

  stopBacklogDrain(): void {
    if (!backlogDrainTimer) {
      return;
    }

    clearInterval(backlogDrainTimer);
    backlogDrainTimer = null;
  },
};
