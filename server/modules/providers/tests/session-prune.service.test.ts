import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sessionsDb } from '@/modules/database/index.js';
import { sessionPruneService } from '@/modules/providers/services/session-prune.service.js';

type TranscriptRef = {
  session_id: string;
  provider: string;
  jsonl_path: string | null;
  updated_at: string | null;
};

type Harness = {
  root: string;
  deleted: string[];
  deletedPaths: string[];
  restore: () => void;
};

const OLD_TIMESTAMP = '2026-01-01T10:00:00.000Z';

/**
 * Stubs the sessions repository so each case controls exactly which rows exist
 * and which transcripts are on disk, without touching the real index.
 */
async function setupHarness(rows: TranscriptRef[]): Promise<Harness> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-prune-'));
  const deleted: string[] = [];
  const deletedPaths: string[] = [];

  const originalList = sessionsDb.listSessionTranscriptRefs;
  const originalDeleteByIds = sessionsDb.deleteSessionsByIds;
  const originalDeleteByPath = sessionsDb.deleteSessionsByJsonlPath;

  sessionsDb.listSessionTranscriptRefs = () => rows;
  sessionsDb.deleteSessionsByIds = (sessionIds: string[]) => {
    deleted.push(...sessionIds);
    return sessionIds.length;
  };
  sessionsDb.deleteSessionsByJsonlPath = (jsonlPath: string) => {
    deletedPaths.push(jsonlPath);
    return rows.filter((row) => row.jsonl_path === jsonlPath).map((row) => row.session_id);
  };

  sessionPruneService.resetThrottleForTests();

  return {
    root,
    deleted,
    deletedPaths,
    restore: () => {
      sessionsDb.listSessionTranscriptRefs = originalList;
      sessionsDb.deleteSessionsByIds = originalDeleteByIds;
      sessionsDb.deleteSessionsByJsonlPath = originalDeleteByPath;
      sessionPruneService.resetThrottleForTests();
    },
  };
}

async function teardown(harness: Harness): Promise<void> {
  harness.restore();
  await fsp.rm(harness.root, { recursive: true, force: true });
}

async function writeTranscript(root: string, name: string): Promise<string> {
  const filePath = path.join(root, name);
  await fsp.writeFile(filePath, '{"type":"user"}\n', 'utf8');
  return filePath;
}

test('drops rows whose transcript is gone and keeps the ones still on disk', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-prune-files-'));
  const livePath = await writeTranscript(root, 'live.jsonl');
  const harness = await setupHarness([
    { session_id: 'live', provider: 'claude', jsonl_path: livePath, updated_at: OLD_TIMESTAMP },
    {
      session_id: 'gone',
      provider: 'claude',
      jsonl_path: path.join(root, 'gone.jsonl'),
      updated_at: OLD_TIMESTAMP,
    },
  ]);

  try {
    const result = await sessionPruneService.pruneSessionsWithMissingTranscripts();

    assert.equal(result.removed, 1);
    assert.deepEqual(harness.deleted, ['gone']);
    assert.deepEqual(result.removedByProvider, { claude: 1 });
    assert.deepEqual(result.skippedProviders, []);
  } finally {
    await teardown(harness);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('keeps a provider untouched when every one of its transcripts is missing', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-prune-missing-'));
  const harness = await setupHarness([
    {
      session_id: 'a',
      provider: 'claude',
      jsonl_path: path.join(root, 'a.jsonl'),
      updated_at: OLD_TIMESTAMP,
    },
    {
      session_id: 'b',
      provider: 'claude',
      jsonl_path: path.join(root, 'b.jsonl'),
      updated_at: OLD_TIMESTAMP,
    },
  ]);

  try {
    const result = await sessionPruneService.pruneSessionsWithMissingTranscripts();

    assert.equal(result.removed, 0);
    assert.deepEqual(harness.deleted, []);
    assert.deepEqual(result.skippedProviders, ['claude']);
  } finally {
    await teardown(harness);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('spares a just-started session whose transcript has not been written yet', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-prune-grace-'));
  const livePath = await writeTranscript(root, 'live.jsonl');
  const harness = await setupHarness([
    { session_id: 'live', provider: 'claude', jsonl_path: livePath, updated_at: OLD_TIMESTAMP },
    {
      session_id: 'starting',
      provider: 'claude',
      jsonl_path: path.join(root, 'starting.jsonl'),
      updated_at: new Date().toISOString(),
    },
  ]);

  try {
    const result = await sessionPruneService.pruneSessionsWithMissingTranscripts();

    assert.equal(result.removed, 0);
    assert.deepEqual(harness.deleted, []);
  } finally {
    await teardown(harness);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('rows without a recorded transcript are never pruned', async () => {
  const harness = await setupHarness([
    { session_id: 'no-path', provider: 'codex', jsonl_path: null, updated_at: OLD_TIMESTAMP },
  ]);

  try {
    const result = await sessionPruneService.pruneSessionsWithMissingTranscripts();

    assert.equal(result.removed, 0);
    assert.deepEqual(harness.deleted, []);
    assert.deepEqual(result.skippedProviders, []);
  } finally {
    await teardown(harness);
  }
});

test('a second pass inside the throttle window does no work', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'session-prune-throttle-'));
  const livePath = await writeTranscript(root, 'live.jsonl');
  const harness = await setupHarness([
    { session_id: 'live', provider: 'claude', jsonl_path: livePath, updated_at: OLD_TIMESTAMP },
    {
      session_id: 'gone',
      provider: 'claude',
      jsonl_path: path.join(root, 'gone.jsonl'),
      updated_at: OLD_TIMESTAMP,
    },
  ]);

  try {
    await sessionPruneService.pruneSessionsWithMissingTranscripts();
    const second = await sessionPruneService.pruneSessionsWithMissingTranscripts();

    assert.equal(second.throttled, true);
    assert.equal(second.removed, 0);
    assert.deepEqual(harness.deleted, ['gone']);
  } finally {
    await teardown(harness);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('an unlinked transcript removes every session indexed from it', async () => {
  const harness = await setupHarness([
    { session_id: 'one', provider: 'opencode', jsonl_path: '/tmp/opencode.db', updated_at: OLD_TIMESTAMP },
    { session_id: 'two', provider: 'opencode', jsonl_path: '/tmp/opencode.db', updated_at: OLD_TIMESTAMP },
    { session_id: 'other', provider: 'opencode', jsonl_path: '/tmp/other.db', updated_at: OLD_TIMESTAMP },
  ]);

  try {
    const removed = sessionPruneService.pruneSessionsForDeletedTranscript('/tmp/opencode.db');

    assert.deepEqual(removed, ['one', 'two']);
    assert.deepEqual(harness.deletedPaths, ['/tmp/opencode.db']);
  } finally {
    await teardown(harness);
  }
});
