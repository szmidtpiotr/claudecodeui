import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import {
  encodeClaudeProjectDirectory,
  moveSessionToProject,
} from '@/modules/providers/services/session-move.service.js';
import { AppError } from '@/shared/utils.js';

type SessionStub = {
  session_id: string;
  provider: string;
  project_path: string | null;
  jsonl_path: string | null;
  custom_name: string | null;
  isArchived: number;
  created_at: string;
  updated_at: string;
};

type Harness = {
  root: string;
  claudeProjectsRoot: string;
  sourcePath: string;
  updates: Array<{ sessionId: string; projectPath: string; jsonlPath: string }>;
  restore: () => void;
};

const SOURCE_PROJECT = '/workspace/source-project';
const TARGET_PROJECT = '/workspace/target-project';
const SESSION_ID = 'session-1';

function buildSession(overrides: Partial<SessionStub> = {}): SessionStub {
  return {
    session_id: SESSION_ID,
    provider: 'claude',
    project_path: SOURCE_PROJECT,
    jsonl_path: null,
    custom_name: 'Some session',
    isArchived: 0,
    created_at: '2026-09-01T10:00:00.000Z',
    updated_at: '2026-09-02T10:00:00.000Z',
    ...overrides,
  };
}

const TRANSCRIPT_LINES = [
  JSON.stringify({ type: 'user', sessionId: SESSION_ID, cwd: SOURCE_PROJECT, message: { content: 'hi' } }),
  'not-json-but-must-survive',
  JSON.stringify({ type: 'assistant', sessionId: SESSION_ID, cwd: SOURCE_PROJECT }),
  JSON.stringify({ type: 'custom-title', customTitle: 'Some session', sessionId: SESSION_ID }),
];

/**
 * Builds an isolated ~/.claude/projects tree plus stubbed repositories so each
 * test exercises the real filesystem work without touching the user's data.
 */
async function setupHarness(session: SessionStub = buildSession()): Promise<Harness> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-move-'));
  const claudeProjectsRoot = path.join(root, 'projects');
  const sourceDirectory = path.join(claudeProjectsRoot, encodeClaudeProjectDirectory(SOURCE_PROJECT));
  await fsp.mkdir(sourceDirectory, { recursive: true });

  const sourcePath = path.join(sourceDirectory, `${SESSION_ID}.jsonl`);
  await fsp.writeFile(sourcePath, `${TRANSCRIPT_LINES.join('\n')}\n`, 'utf8');

  const storedSession = { ...session, jsonl_path: session.jsonl_path ?? sourcePath };
  const updates: Harness['updates'] = [];

  const originalGetSessionById = sessionsDb.getSessionById;
  const originalUpdateSessionProject = sessionsDb.updateSessionProject;
  const originalGetProjectPathById = projectsDb.getProjectPathById;

  sessionsDb.getSessionById = () => storedSession as ReturnType<typeof originalGetSessionById>;
  sessionsDb.updateSessionProject = (sessionId: string, projectPath: string, jsonlPath: string) => {
    updates.push({ sessionId, projectPath, jsonlPath });
    return true;
  };
  projectsDb.getProjectPathById = (projectId: string) =>
    projectId === 'target-project-id' ? TARGET_PROJECT : null;

  return {
    root,
    claudeProjectsRoot,
    sourcePath,
    updates,
    restore: () => {
      sessionsDb.getSessionById = originalGetSessionById;
      sessionsDb.updateSessionProject = originalUpdateSessionProject;
      projectsDb.getProjectPathById = originalGetProjectPathById;
    },
  };
}

async function teardown(harness: Harness): Promise<void> {
  harness.restore();
  await fsp.rm(harness.root, { recursive: true, force: true });
}

test('moves the transcript into the target project and rewrites every cwd', async () => {
  const harness = await setupHarness();
  try {
    const result = await moveSessionToProject(SESSION_ID, 'target-project-id', {
      claudeProjectsRoot: harness.claudeProjectsRoot,
      isSessionActive: () => false,
    });

    assert.equal(result.moved, true);
    assert.equal(result.projectPath, TARGET_PROJECT);
    assert.equal(
      result.jsonlPath,
      path.join(
        harness.claudeProjectsRoot,
        encodeClaudeProjectDirectory(TARGET_PROJECT),
        `${SESSION_ID}.jsonl`,
      ),
    );

    // The synchronizer rebuilds project_path from cwd, so a stale cwd would
    // silently pull the session back into its old project on the next scan.
    const moved = await fsp.readFile(result.jsonlPath, 'utf8');
    const lines = moved.split('\n').filter((line) => line.length > 0);
    assert.equal(lines.length, TRANSCRIPT_LINES.length);
    assert.equal(lines[1], 'not-json-but-must-survive');
    assert.equal(JSON.parse(lines[0]).cwd, TARGET_PROJECT);
    assert.equal(JSON.parse(lines[2]).cwd, TARGET_PROJECT);
    assert.equal(JSON.parse(lines[0]).message.content, 'hi');
    // Entries without a cwd stay byte-identical.
    assert.equal(lines[3], TRANSCRIPT_LINES[3]);

    assert.deepEqual(harness.updates, [
      { sessionId: SESSION_ID, projectPath: TARGET_PROJECT, jsonlPath: result.jsonlPath },
    ]);
    assert.equal(await fsp.access(harness.sourcePath).then(() => true, () => false), false);
  } finally {
    await teardown(harness);
  }
});

test('refuses to move a session that is still running', async () => {
  const harness = await setupHarness();
  try {
    await assert.rejects(
      moveSessionToProject(SESSION_ID, 'target-project-id', {
        claudeProjectsRoot: harness.claudeProjectsRoot,
        isSessionActive: () => true,
      }),
      (error: unknown) =>
        error instanceof AppError && error.code === 'SESSION_BUSY' && error.statusCode === 409,
    );

    assert.equal(harness.updates.length, 0);
    assert.equal(await fsp.access(harness.sourcePath).then(() => true, () => false), true);
  } finally {
    await teardown(harness);
  }
});

test('refuses providers whose transcript layout is not Claude', async () => {
  const harness = await setupHarness(buildSession({ provider: 'codex' }));
  try {
    await assert.rejects(
      moveSessionToProject(SESSION_ID, 'target-project-id', {
        claudeProjectsRoot: harness.claudeProjectsRoot,
        isSessionActive: () => false,
      }),
      (error: unknown) =>
        error instanceof AppError
        && error.code === 'SESSION_MOVE_UNSUPPORTED_PROVIDER'
        && error.statusCode === 400,
    );
  } finally {
    await teardown(harness);
  }
});

test('reports an unknown target project instead of moving anything', async () => {
  const harness = await setupHarness();
  try {
    await assert.rejects(
      moveSessionToProject(SESSION_ID, 'missing-project-id', {
        claudeProjectsRoot: harness.claudeProjectsRoot,
        isSessionActive: () => false,
      }),
      (error: unknown) =>
        error instanceof AppError && error.code === 'PROJECT_NOT_FOUND' && error.statusCode === 404,
    );

    assert.equal(await fsp.access(harness.sourcePath).then(() => true, () => false), true);
  } finally {
    await teardown(harness);
  }
});

test('is a no-op when the session already belongs to the target project', async () => {
  const harness = await setupHarness(buildSession({ project_path: TARGET_PROJECT }));
  try {
    const result = await moveSessionToProject(SESSION_ID, 'target-project-id', {
      claudeProjectsRoot: harness.claudeProjectsRoot,
      isSessionActive: () => {
        throw new Error('the busy check must not run for a no-op move');
      },
    });

    assert.equal(result.moved, false);
    assert.equal(harness.updates.length, 0);
  } finally {
    await teardown(harness);
  }
});

test('fails when the transcript is gone from disk', async () => {
  const harness = await setupHarness();
  try {
    await fsp.rm(harness.sourcePath);

    await assert.rejects(
      moveSessionToProject(SESSION_ID, 'target-project-id', {
        claudeProjectsRoot: harness.claudeProjectsRoot,
        isSessionActive: () => false,
      }),
      (error: unknown) =>
        error instanceof AppError
        && error.code === 'SESSION_TRANSCRIPT_MISSING'
        && error.statusCode === 409,
    );
  } finally {
    await teardown(harness);
  }
});

test('never overwrites an existing transcript in the target project', async () => {
  const harness = await setupHarness();
  try {
    const targetDirectory = path.join(
      harness.claudeProjectsRoot,
      encodeClaudeProjectDirectory(TARGET_PROJECT),
    );
    await fsp.mkdir(targetDirectory, { recursive: true });
    await fsp.writeFile(path.join(targetDirectory, `${SESSION_ID}.jsonl`), 'existing\n', 'utf8');

    await assert.rejects(
      moveSessionToProject(SESSION_ID, 'target-project-id', {
        claudeProjectsRoot: harness.claudeProjectsRoot,
        isSessionActive: () => false,
      }),
      (error: unknown) =>
        error instanceof AppError
        && error.code === 'SESSION_TRANSCRIPT_CONFLICT'
        && error.statusCode === 409,
    );

    assert.equal(
      await fsp.readFile(path.join(targetDirectory, `${SESSION_ID}.jsonl`), 'utf8'),
      'existing\n',
    );
    assert.equal(await fsp.access(harness.sourcePath).then(() => true, () => false), true);
  } finally {
    await teardown(harness);
  }
});

test('rolls the copy back when the database update fails', async () => {
  const harness = await setupHarness();
  const originalUpdateSessionProject = sessionsDb.updateSessionProject;
  try {
    sessionsDb.updateSessionProject = () => {
      throw new Error('database is locked');
    };

    await assert.rejects(
      moveSessionToProject(SESSION_ID, 'target-project-id', {
        claudeProjectsRoot: harness.claudeProjectsRoot,
        isSessionActive: () => false,
      }),
      /database is locked/,
    );

    const targetPath = path.join(
      harness.claudeProjectsRoot,
      encodeClaudeProjectDirectory(TARGET_PROJECT),
      `${SESSION_ID}.jsonl`,
    );
    assert.equal(await fsp.access(targetPath).then(() => true, () => false), false);
    assert.equal(await fsp.access(harness.sourcePath).then(() => true, () => false), true);
  } finally {
    sessionsDb.updateSessionProject = originalUpdateSessionProject;
    await teardown(harness);
  }
});
