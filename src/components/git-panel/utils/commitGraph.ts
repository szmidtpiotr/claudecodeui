import type { GitCommitSummary } from '../types/types';

export const GRAPH_COLORS = [
  '#3b82f6', // blue
  '#22c55e', // green
  '#f59e0b', // amber
  '#a855f7', // purple
  '#ef4444', // red
  '#14b8a6', // teal
  '#f97316', // orange
  '#ec4899', // pink
];

export type GraphRow = {
  lane: number;
  laneCount: number;
  color: string;
  // Segments drawn in this row: each is a line from (fromLane, top) to (toLane, bottom)
  edges: Array<{ fromLane: number; toLane: number; color: string }>;
  // Merge edges: lines from other lanes coming into this commit's lane
  mergeEdges: Array<{ fromLane: number; toLane: number; color: string }>;
};

function laneColor(lane: number): string {
  return GRAPH_COLORS[lane % GRAPH_COLORS.length];
}

/**
 * Compute lane assignments for a list of commits in topo-order.
 * Returns one GraphRow per commit.
 */
export function computeGraphRows(commits: GitCommitSummary[]): GraphRow[] {
  // lanes[i] = hash of the commit expected next in lane i (undefined = empty)
  const lanes: Array<string | undefined> = [];
  // laneColor[i] = color index for lane i
  const laneColors: number[] = [];
  let nextColorIndex = 0;

  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const { hash, parents } = commit;

    // Find which lane this commit occupies
    let myLane = lanes.indexOf(hash);
    if (myLane === -1) {
      // New branch starting here — open a new lane
      myLane = lanes.indexOf(undefined);
      if (myLane === -1) {
        myLane = lanes.length;
        lanes.push(hash);
        laneColors.push(nextColorIndex++);
      } else {
        lanes[myLane] = hash;
        laneColors[myLane] = nextColorIndex++;
      }
    }

    const myColor = laneColor(laneColors[myLane]);

    // Edges continuing below this row (before we update lanes)
    const edges: GraphRow['edges'] = [];
    const mergeEdges: GraphRow['mergeEdges'] = [];

    // For each lane currently active, figure out where it goes
    // after this commit row.
    const newLanes = [...lanes];
    const newLaneColors = [...laneColors];

    if (parents.length === 0) {
      // Root commit — close this lane
      newLanes[myLane] = undefined;
    } else {
      // First parent inherits this lane
      newLanes[myLane] = parents[0];

      // Additional parents (merge): find or allocate lanes for them
      for (let pi = 1; pi < parents.length; pi++) {
        const parentHash = parents[pi];
        // Check if parent already has a lane
        const existingLane = newLanes.indexOf(parentHash);
        if (existingLane !== -1) {
          // Already tracked — draw merge edge into that lane
          mergeEdges.push({ fromLane: myLane, toLane: existingLane, color: laneColor(newLaneColors[existingLane]) });
        } else {
          // Open new lane for this parent
          let newLane = newLanes.indexOf(undefined);
          if (newLane === -1) {
            newLane = newLanes.length;
            newLanes.push(parentHash);
            newLaneColors.push(nextColorIndex++);
          } else {
            newLanes[newLane] = parentHash;
            newLaneColors[newLane] = nextColorIndex++;
          }
          mergeEdges.push({ fromLane: myLane, toLane: newLane, color: laneColor(newLaneColors[newLane]) });
        }
      }
    }

    // Straight-through edges for non-merging active lanes
    for (let li = 0; li < Math.max(lanes.length, newLanes.length); li++) {
      if (li === myLane) continue;
      const before = lanes[li];
      const after = newLanes[li];
      if (before && before === after) {
        edges.push({ fromLane: li, toLane: li, color: laneColor(laneColors[li]) });
      } else if (before && !after) {
        // Lane closing — draw nothing extra (commit absorbed it)
      } else if (!before && after) {
        // Lane opening
      }
    }

    // Trim trailing undefined slots
    while (newLanes.length > 0 && newLanes[newLanes.length - 1] === undefined) {
      newLanes.pop();
      newLaneColors.pop();
    }

    const laneCount = Math.max(myLane + 1, newLanes.length, lanes.length);

    rows.push({
      lane: myLane,
      laneCount,
      color: myColor,
      edges,
      mergeEdges,
    });

    // Update state for next iteration
    lanes.length = newLanes.length;
    for (let i = 0; i < newLanes.length; i++) {
      lanes[i] = newLanes[i];
      laneColors[i] = newLaneColors[i];
    }
  }

  return rows;
}

/** Parse ref string like "HEAD -> main, origin/main, tag: v1.0" */
export function parseRefs(refs: string[]): { branches: string[]; tags: string[]; isHead: boolean } {
  const branches: string[] = [];
  const tags: string[] = [];
  let isHead = false;

  for (const ref of refs) {
    if (ref === 'HEAD') {
      isHead = true;
    } else if (ref.startsWith('HEAD -> ')) {
      isHead = true;
      branches.push(ref.slice('HEAD -> '.length));
    } else if (ref.startsWith('tag: ')) {
      tags.push(ref.slice('tag: '.length));
    } else {
      branches.push(ref);
    }
  }

  return { branches, tags, isHead };
}
