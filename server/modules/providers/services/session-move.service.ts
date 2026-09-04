import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { once } from 'node:events';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { AppError, normalizeProjectPath } from '@/shared/utils.js';

export type MoveSessionToProjectResult = {
  sessionId: string;
  projectPath: string;
  jsonlPath: string;
  moved: boolean;
};

export type MoveSessionDependencies = {
  /** Root that holds one directory per project, i.e. ~/.claude/projects. */
  claudeProjectsRoot: string;
  /** Guards against relocating a transcript the CLI is still writing to. */
  isSessionActive: (sessionId: string) => Promise<boolean> | boolean;
};

/**
 * Mirrors Claude's own transcript directory naming: every character outside
 * `[A-Za-z0-9-]` becomes `-`. `claude --resume <id>` only finds a session when
 * the file lives in the directory derived from the cwd it was started with,
 * which is why moving a session has to relocate the file rather than just
 * re-point the database row.
 */
export function encodeClaudeProjectDirectory(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolved lazily so this module stays importable from tests and from the
 * database layer without pulling in the Claude SDK runtime.
 */
async function defaultIsSessionActive(sessionId: string): Promise<boolean> {
  try {
    const claudeSdk = (await import('@/claude-sdk.js')) as unknown as {
      isClaudeSDKSessionActive?: (id: string) => boolean;
    };
    return Boolean(claudeSdk.isClaudeSDKSessionActive?.(sessionId));
  } catch {
    // A missing/unloadable SDK module must not block the move outright.
    return false;
  }
}

/**
 * Rewrites the `cwd` recorded on every transcript entry to the target project.
 *
 * Lines that are not valid JSON objects are copied through verbatim so an
 * unparsable entry can never silently drop history.
 */
function rewriteTranscriptLine(line: string, projectPath: string): string {
  if (!line.trim()) {
    return line;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return line;
  }

  const entry = parsed as Record<string, unknown>;
  if (typeof entry.cwd !== 'string') {
    return line;
  }

  entry.cwd = projectPath;
  return JSON.stringify(entry);
}

/**
 * Streams the transcript into its new location with rewritten `cwd` values.
 *
 * Transcripts routinely reach tens of megabytes, so the file is processed line
 * by line instead of being read into memory. The target is opened with `wx` so
 * an unexpected pre-existing file is never overwritten.
 */
async function copyTranscriptWithRewrittenCwd(
  sourcePath: string,
  targetPath: string,
  projectPath: string,
): Promise<void> {
  const input = fs.createReadStream(sourcePath, { encoding: 'utf8' });
  const output = fs.createWriteStream(targetPath, { encoding: 'utf8', flags: 'wx' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!output.write(`${rewriteTranscriptLine(line, projectPath)}\n`)) {
        await once(output, 'drain');
      }
    }

    output.end();
    await once(output, 'finish');
  } catch (error) {
    lines.close();
    input.destroy();
    output.destroy();
    await fsp.rm(targetPath, { force: true });
    throw error;
  }
}

/**
 * Moves one Claude session into another project.
 *
 * The transcript is copied to the target project's directory first, then the
 * database row is re-pointed, and only afterwards is the source removed. A
 * failure at any step leaves the session readable in its original project.
 */
export async function moveSessionToProject(
  sessionId: string,
  targetProjectId: string,
  overrides: Partial<MoveSessionDependencies> = {},
): Promise<MoveSessionToProjectResult> {
  const dependencies: MoveSessionDependencies = {
    claudeProjectsRoot: path.join(os.homedir(), '.claude', 'projects'),
    isSessionActive: defaultIsSessionActive,
    ...overrides,
  };

  const session = sessionsDb.getSessionById(sessionId);
  if (!session) {
    throw new AppError(`Session "${sessionId}" was not found.`, {
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    });
  }

  // Every other provider stores transcripts in its own layout; supporting them
  // means teaching this service that layout, not reusing the Claude one.
  if (session.provider !== 'claude') {
    throw new AppError(`Moving ${session.provider} sessions between projects is not supported yet.`, {
      code: 'SESSION_MOVE_UNSUPPORTED_PROVIDER',
      statusCode: 400,
    });
  }

  const targetProjectPath = projectsDb.getProjectPathById(targetProjectId);
  if (!targetProjectPath) {
    throw new AppError(`Project "${targetProjectId}" was not found.`, {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  const normalizedTargetPath = normalizeProjectPath(targetProjectPath);
  const currentProjectPath = session.project_path ? normalizeProjectPath(session.project_path) : null;
  if (currentProjectPath === normalizedTargetPath) {
    return {
      sessionId,
      projectPath: normalizedTargetPath,
      jsonlPath: session.jsonl_path ?? '',
      moved: false,
    };
  }

  if (await dependencies.isSessionActive(sessionId)) {
    throw new AppError('This session is still running. Stop it before moving it to another project.', {
      code: 'SESSION_BUSY',
      statusCode: 409,
    });
  }

  const sourcePath = session.jsonl_path;
  if (!sourcePath || !(await fileExists(sourcePath))) {
    throw new AppError(`Transcript for session "${sessionId}" was not found on disk.`, {
      code: 'SESSION_TRANSCRIPT_MISSING',
      statusCode: 409,
    });
  }

  const targetDirectory = path.join(
    dependencies.claudeProjectsRoot,
    encodeClaudeProjectDirectory(normalizedTargetPath),
  );
  const targetPath = path.join(targetDirectory, path.basename(sourcePath));

  // Two distinct project paths can encode to the same directory name (the
  // encoding is lossy). Then the file already sits where it belongs and only
  // the recorded cwd has to change.
  if (path.resolve(targetPath) === path.resolve(sourcePath)) {
    await rewriteTranscriptInPlace(sourcePath, normalizedTargetPath);
    sessionsDb.updateSessionProject(sessionId, normalizedTargetPath, sourcePath);
    return { sessionId, projectPath: normalizedTargetPath, jsonlPath: sourcePath, moved: true };
  }

  if (await fileExists(targetPath)) {
    throw new AppError(`Target project already holds a transcript named "${path.basename(targetPath)}".`, {
      code: 'SESSION_TRANSCRIPT_CONFLICT',
      statusCode: 409,
    });
  }

  await fsp.mkdir(targetDirectory, { recursive: true });
  await copyTranscriptWithRewrittenCwd(sourcePath, targetPath, normalizedTargetPath);

  try {
    sessionsDb.updateSessionProject(sessionId, normalizedTargetPath, targetPath);
  } catch (error) {
    // The source file is still intact, so discarding the copy restores the
    // pre-move state exactly.
    await fsp.rm(targetPath, { force: true });
    throw error;
  }

  await fsp.rm(sourcePath, { force: true });

  return {
    sessionId,
    projectPath: normalizedTargetPath,
    jsonlPath: targetPath,
    moved: true,
  };
}

/**
 * Rewrites `cwd` without relocating the file, via a sibling temp file so a
 * crash mid-write cannot truncate the original transcript.
 */
async function rewriteTranscriptInPlace(filePath: string, projectPath: string): Promise<void> {
  const temporaryPath = `${filePath}.move-${process.pid}-${Date.now()}.tmp`;
  await copyTranscriptWithRewrittenCwd(filePath, temporaryPath, projectPath);

  try {
    await fsp.rename(temporaryPath, filePath);
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true });
    throw error;
  }
}
