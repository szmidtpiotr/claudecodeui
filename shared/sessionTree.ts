/**
 * Builds the derived-session tree shown in a project's sidebar list.
 *
 * Shared by the client (rendering) and the server test runner (tests), so it
 * stays a dependency-free pure function.
 *
 * Rules:
 * - A session nests under its parent only when the parent is in the same list.
 *   A parent that is missing, archived or on a page not loaded yet leaves the
 *   child at top level.
 * - Pinned sessions always stay at top level, in their input order, so "pin to
 *   top" keeps working for derived sessions too.
 * - Unpinned top-level families are ordered by their most recent member (the
 *   lowest input index), so a busy derived session lifts its parent up.
 * - Siblings keep the input order (newest first in the sidebar).
 * - A cycle in corrupt data is cut at one edge; no session is ever dropped.
 */

export type SessionTreeInput = {
  id: string;
  parentSessionId?: string | null;
};

export type SessionTreeRow<T extends SessionTreeInput> = {
  session: T;
  /** Parent this row is rendered under, or null at top level. */
  parentId: string | null;
  depth: number;
  hasChildren: boolean;
  /** Last child of its parent (connector line stops here). */
  isLastSibling: boolean;
  /** Depths of ancestors whose vertical connector continues past this row. */
  continuationDepths: number[];
};

type Node<T extends SessionTreeInput> = {
  session: T;
  index: number;
  parentId: string | null;
  children: Node<T>[];
  rank: number;
};

export function buildSessionTree<T extends SessionTreeInput>(
  sessions: T[],
  pinnedIds: ReadonlySet<string> = new Set(),
): SessionTreeRow<T>[] {
  const nodes = new Map<string, Node<T>>();
  sessions.forEach((session, index) => {
    if (!nodes.has(session.id)) {
      nodes.set(session.id, { session, index, parentId: null, children: [], rank: index });
    }
  });

  for (const node of nodes.values()) {
    const parentId = node.session.parentSessionId;
    if (!parentId || parentId === node.session.id || pinnedIds.has(node.session.id)) {
      continue;
    }
    if (nodes.has(parentId)) {
      node.parentId = parentId;
    }
  }

  // Sever one edge per cycle.
  const checked = new Set<string>();
  for (const node of nodes.values()) {
    const path = new Set<string>();
    let current: Node<T> | undefined = node;
    while (current && !checked.has(current.session.id)) {
      path.add(current.session.id);
      if (current.parentId && path.has(current.parentId)) {
        current.parentId = null;
        break;
      }
      current = current.parentId ? nodes.get(current.parentId) : undefined;
    }
    for (const id of path) checked.add(id);
  }

  const roots: Node<T>[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // Post-order: each node's rank becomes the best rank in its subtree.
  const order: Node<T>[] = [];
  const pending = [...roots];
  while (pending.length) {
    const node = pending.pop()!;
    order.push(node);
    pending.push(...node.children);
  }
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const node = order[index];
    node.children.sort((a, b) => a.index - b.index);
    if (node.parentId) {
      const parent = nodes.get(node.parentId)!;
      parent.rank = Math.min(parent.rank, node.rank);
    }
  }

  const pinnedRoots = roots.filter((node) => pinnedIds.has(node.session.id)).sort((a, b) => a.index - b.index);
  const otherRoots = roots
    .filter((node) => !pinnedIds.has(node.session.id))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  const orderedRoots = [...pinnedRoots, ...otherRoots];

  const rows: SessionTreeRow<T>[] = [];
  const stack = orderedRoots
    .map((node) => ({ node, depth: 0, isLastSibling: true, continuation: [] as number[] }))
    .reverse();
  while (stack.length) {
    const { node, depth, isLastSibling, continuation } = stack.pop()!;
    rows.push({
      session: node.session,
      parentId: node.parentId,
      depth,
      hasChildren: node.children.length > 0,
      isLastSibling,
      continuationDepths: continuation,
    });
    // Children of a non-last sibling see this row's connector continuing.
    const childContinuation = depth > 0 && !isLastSibling ? [...continuation, depth] : continuation;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push({
        node: node.children[index],
        depth: depth + 1,
        isLastSibling: index === node.children.length - 1,
        continuation: childContinuation,
      });
    }
  }
  return rows;
}

/**
 * Drops the descendants of collapsed sessions from an already built row list.
 */
export function hideCollapsedRows<T extends SessionTreeInput>(
  rows: SessionTreeRow<T>[],
  collapsedIds: ReadonlySet<string>,
): SessionTreeRow<T>[] {
  const visible: SessionTreeRow<T>[] = [];
  let hiddenBelowDepth = Infinity;
  for (const row of rows) {
    if (row.depth > hiddenBelowDepth) continue;
    hiddenBelowDepth = row.hasChildren && collapsedIds.has(row.session.id) ? row.depth : Infinity;
    visible.push(row);
  }
  return visible;
}

/** Ids of every ancestor of `targetId` inside the rows (to reveal a selected child). */
export function ancestorIdsInTree<T extends SessionTreeInput>(rows: SessionTreeRow<T>[], targetId: string | null): Set<string> {
  const result = new Set<string>();
  if (!targetId) return result;
  const parents = new Map(rows.map((row) => [row.session.id, row.parentId]));
  let parentId = parents.get(targetId) ?? null;
  while (parentId && !result.has(parentId)) {
    result.add(parentId);
    parentId = parents.get(parentId) ?? null;
  }
  return result;
}
