import assert from 'node:assert/strict';
import test from 'node:test';

import { ancestorIdsInTree, buildSessionTree, hideCollapsedRows } from '../../../../shared/sessionTree.js';

type S = { id: string; parentSessionId?: string | null };

const ids = (rows: { session: S; depth: number }[]) => rows.map((row) => `${'-'.repeat(row.depth)}${row.session.id}`);

test('children nest under their parent and families follow their newest member', () => {
  // Input is newest first, as the sidebar sorts it.
  const sessions: S[] = [
    { id: 'c1', parentSessionId: 'p' },
    { id: 'x' },
    { id: 'c2', parentSessionId: 'p' },
    { id: 'g', parentSessionId: 'c2' },
    { id: 'p' },
  ];
  const rows = buildSessionTree(sessions);
  assert.deepEqual(ids(rows), ['p', '-c1', '-c2', '--g', 'x']);
  const c1 = rows.find((row) => row.session.id === 'c1')!;
  const c2 = rows.find((row) => row.session.id === 'c2')!;
  const g = rows.find((row) => row.session.id === 'g')!;
  assert.equal(c1.isLastSibling, false);
  assert.equal(c2.isLastSibling, true);
  assert.equal(rows[0].hasChildren, true);
  assert.deepEqual(g.continuationDepths, []);
});

test('a missing parent leaves the child at top level', () => {
  const rows = buildSessionTree<S>([{ id: 'orphan', parentSessionId: 'gone' }, { id: 'a' }]);
  assert.deepEqual(ids(rows), ['orphan', 'a']);
  assert.equal(rows[0].parentId, null);
});

test('pinned sessions stay on top, even when derived', () => {
  const sessions: S[] = [
    { id: 'pinnedChild', parentSessionId: 'p' },
    { id: 'p' },
    { id: 'child', parentSessionId: 'p' },
    { id: 'old' },
  ];
  const rows = buildSessionTree(sessions, new Set(['pinnedChild']));
  assert.deepEqual(ids(rows), ['pinnedChild', 'p', '-child', 'old']);
});

test('cycles are cut without losing sessions', () => {
  const rows = buildSessionTree<S>([
    { id: 'a', parentSessionId: 'b' },
    { id: 'b', parentSessionId: 'a' },
    { id: 's', parentSessionId: 's' },
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(new Set(rows.map((row) => row.session.id)), new Set(['a', 'b', 's']));
});

test('continuation lines run through descendants of non-last siblings', () => {
  const rows = buildSessionTree<S>([
    { id: 'p' },
    { id: 'c1', parentSessionId: 'p' },
    { id: 'g1', parentSessionId: 'c1' },
    { id: 'c2', parentSessionId: 'p' },
  ]);
  assert.deepEqual(ids(rows), ['p', '-c1', '--g1', '-c2']);
  assert.deepEqual(rows[2].continuationDepths, [1]);
});

test('collapsing hides descendants and ancestors can be revealed', () => {
  const rows = buildSessionTree<S>([
    { id: 'p' },
    { id: 'c', parentSessionId: 'p' },
    { id: 'g', parentSessionId: 'c' },
    { id: 'q' },
  ]);
  assert.deepEqual(ids(hideCollapsedRows(rows, new Set(['p']))), ['p', 'q']);
  assert.deepEqual(ids(hideCollapsedRows(rows, new Set(['c']))), ['p', '-c', 'q']);
  assert.deepEqual([...ancestorIdsInTree(rows, 'g')], ['c', 'p']);
  assert.deepEqual([...ancestorIdsInTree(rows, null)], []);
});
