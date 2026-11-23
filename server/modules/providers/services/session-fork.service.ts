import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  forkSession as sdkForkSession,
  getSessionMessages as sdkGetSessionMessages,
} from '@anthropic-ai/claude-agent-sdk';

import { sessionsDb } from '@/modules/database/index.js';
import {
  extractTranscriptUuid,
  pickForkCutPoint,
  type TranscriptMessageLike,
} from '@/modules/providers/list/claude/claude-fork-utils.js';
import { emitSessionMetadataChanged } from '@/modules/providers/services/session-events.js';
import { encodeClaudeProjectDirectory } from '@/modules/providers/services/session-move.service.js';
import { AppError } from '@/shared/utils.js';

const MAX_TITLE_LENGTH = 200;
const DEFAULT_PARENT_TITLE = 'Session';

export type ForkSessionInput = {
  /** Session to fork. Must be an indexed Claude session. */
  sessionId: string;
  /**
   * Chat message id (`<uuid>` or `<uuid>_<n>`) to fork up to, inclusive.
   * Omitted: fork everything up to the last point with no tool call pending.
   */
  upToMessageId?: string | null;
  /** Title of the new session. Defaults to "<parent title> (fork)". */
  title?: string | null;
};

export type ForkSessionResult = {
  sessionId: string;
  parentSessionId: string;
  title: string;
  projectPath: string;
  jsonlPath: string | null;
  /** Transcript uuid the copy ends at. */
  upToMessageUuid: string;
  /** False when the requested message was not found and the default cut was used. */
  requestedMessageFound: boolean;
};

export type ForkSessionDependencies = {
  forkSession: (sessionId: string, options: { dir?: string; upToMessageId?: string; title?: string }) => Promise<{ sessionId: string }>;
  getSessionMessages: (sessionId: string, options: { dir?: string }) => Promise<TranscriptMessageLike[]>;
  claudeProjectsRoot: string;
};

const defaultDependencies = (): ForkSessionDependencies => ({
  forkSession: sdkForkSession,
  getSessionMessages: sdkGetSessionMessages as ForkSessionDependencies['getSessionMessages'],
  claudeProjectsRoot: path.join(os.homedir(), '.claude', 'projects'),
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeTitle(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, MAX_TITLE_LENGTH) : null;
}

/**
 * Chooses the transcript uuid the fork ends at.
 *
 * A requested message is honoured, but never past a point where a tool call is
 * still waiting for its result: the cut moves back to the last safe message so
 * the derived session never resumes into a dangling tool_use.
 */
export function resolveForkCut(
  messages: TranscriptMessageLike[],
  requestedUuid: string | null,
): { uuid: string | null; requestedMessageFound: boolean } {
  if (requestedUuid) {
    const index = messages.findIndex((entry) => entry.uuid === requestedUuid);
    if (index >= 0) {
      return { uuid: pickForkCutPoint(messages.slice(0, index + 1)), requestedMessageFound: true };
    }
  }
  return { uuid: pickForkCutPoint(messages), requestedMessageFound: !requestedUuid };
}

/**
 * Forks a Claude session into a new, resumable derived session and records
 * the parent so the sidebar can show it in the session tree.
 */
export async function forkClaudeSessionById(
  input: ForkSessionInput,
  overrides: Partial<ForkSessionDependencies> = {},
): Promise<ForkSessionResult> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  const parent = sessionsDb.getSessionById(input.sessionId);

  if (!parent) {
    throw new AppError(`Session "${input.sessionId}" was not found.`, {
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    });
  }
  if (parent.provider !== 'claude') {
    throw new AppError('Only Claude sessions can be forked.', {
      code: 'FORK_UNSUPPORTED_PROVIDER',
      statusCode: 400,
    });
  }
  if (!parent.project_path) {
    throw new AppError('The session has no project directory.', {
      code: 'FORK_NO_PROJECT',
      statusCode: 400,
    });
  }

  const projectPath = parent.project_path;
  const messages = await dependencies.getSessionMessages(input.sessionId, { dir: projectPath });
  const cut = resolveForkCut(messages, extractTranscriptUuid(input.upToMessageId));
  if (!cut.uuid) {
    throw new AppError('The session has no messages that can be forked yet.', {
      code: 'FORK_NOTHING_TO_COPY',
      statusCode: 400,
    });
  }

  const explicitTitle = normalizeTitle(input.title);
  const title = explicitTitle
    ?? normalizeTitle(`${parent.custom_name || DEFAULT_PARENT_TITLE} (fork)`)
    ?? `${DEFAULT_PARENT_TITLE} (fork)`;

  const { sessionId: childId } = await dependencies.forkSession(input.sessionId, {
    dir: projectPath,
    upToMessageId: cut.uuid,
    title,
  });

  const candidates = [
    parent.jsonl_path ? path.join(path.dirname(parent.jsonl_path), `${childId}.jsonl`) : null,
    path.join(dependencies.claudeProjectsRoot, encodeClaudeProjectDirectory(projectPath), `${childId}.jsonl`),
  ].filter((candidate): candidate is string => Boolean(candidate));

  let jsonlPath: string | null = null;
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      jsonlPath = candidate;
      break;
    }
  }

  const now = new Date().toISOString();
  sessionsDb.createSession(
    childId,
    'claude',
    projectPath,
    title,
    now,
    now,
    jsonlPath,
    // A generated "(fork)" title may still be improved by the title generator.
    explicitTitle ? 'user' : 'derived',
    input.sessionId,
  );
  emitSessionMetadataChanged({ sessionId: childId, provider: 'claude' });

  return {
    sessionId: childId,
    parentSessionId: input.sessionId,
    title,
    projectPath,
    jsonlPath,
    upToMessageUuid: cut.uuid,
    requestedMessageFound: cut.requestedMessageFound,
  };
}
