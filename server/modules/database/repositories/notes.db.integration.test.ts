import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { notesDb } from '@/modules/database/repositories/notes.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'notes-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('notesDb.getProjectNote returns null for unknown project', async () => {
  await withIsolatedDatabase(() => {
    const note = notesDb.getProjectNote('nonexistent-project-id');
    assert.equal(note, null);
  });
});

test('notesDb.upsertProjectNote creates note for new project', async () => {
  await withIsolatedDatabase(() => {
    notesDb.upsertProjectNote('project-abc', '# My Notes\n\nHello world');
    const note = notesDb.getProjectNote('project-abc');
    assert.ok(note);
    assert.equal(note.project_id, 'project-abc');
    assert.equal(note.content, '# My Notes\n\nHello world');
  });
});

test('notesDb.upsertProjectNote updates existing note content', async () => {
  await withIsolatedDatabase(() => {
    notesDb.upsertProjectNote('project-xyz', '# Initial');
    notesDb.upsertProjectNote('project-xyz', '# Updated\n\n- item 1\n- item 2');
    const note = notesDb.getProjectNote('project-xyz');
    assert.ok(note);
    assert.equal(note.content, '# Updated\n\n- item 1\n- item 2');
  });
});

test('notesDb.upsertProjectNote stores empty string content', async () => {
  await withIsolatedDatabase(() => {
    notesDb.upsertProjectNote('project-empty', '');
    const note = notesDb.getProjectNote('project-empty');
    assert.ok(note);
    assert.equal(note.content, '');
  });
});

test('notesDb.getProjectNote is isolated per project', async () => {
  await withIsolatedDatabase(() => {
    notesDb.upsertProjectNote('proj-a', '# Project A notes');
    notesDb.upsertProjectNote('proj-b', '# Project B notes');

    const noteA = notesDb.getProjectNote('proj-a');
    const noteB = notesDb.getProjectNote('proj-b');

    assert.equal(noteA?.content, '# Project A notes');
    assert.equal(noteB?.content, '# Project B notes');
  });
});
