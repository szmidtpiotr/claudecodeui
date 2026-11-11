import { stat } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';

/**
 * How long a row is protected after its last update.
 *
 * A session that was just started can be indexed before its transcript is
 * flushed to disk (the Azure provider records the file path up front), so a
 * freshly touched row is never treated as orphaned.
 */
const RECENT_ACTIVITY_GRACE_MS = 10 * 60 * 1000;

/** Minimum gap between two full prune passes. */
const PRUNE_THROTTLE_MS = 5 * 60 * 1000;

export type SessionPruneResult = {
  removed: number;
  removedByProvider: Record<string, number>;
  /** Providers left untouched because their artifacts looked unavailable. */
  skippedProviders: string[];
  /** True when the pass was skipped because another one ran recently. */
  throttled: boolean;
};

type PruneOptions = {
  /** Runs the pass even when the throttle window has not elapsed. */
  force?: boolean;
};

type ProviderBucket = {
  present: number;
  orphaned: string[];
};

let lastPruneAt = 0;

async function transcriptExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function isWithinGracePeriod(updatedAt: string | null, now: number): boolean {
  if (!updatedAt) {
    return false;
  }

  const parsed = new Date(updatedAt).getTime();
  if (Number.isNaN(parsed)) {
    return false;
  }

  return now - parsed < RECENT_ACTIVITY_GRACE_MS;
}

function emptyResult(throttled: boolean): SessionPruneResult {
  return {
    removed: 0,
    removedByProvider: {},
    skippedProviders: [],
    throttled,
  };
}

export const sessionPruneService = {
  /**
   * Removes indexed sessions whose provider transcript is gone.
   *
   * Such a row carries nothing but a title: the conversation itself only ever
   * lived in the transcript file, so once the CLI's retention window deletes
   * it the thread can only open empty. Deleting the row is what makes it
   * disappear from the sidebar.
   *
   * Two guards keep an unreadable artifact directory from wiping real history:
   * a provider whose every transcript is missing is skipped entirely (that
   * looks like an unmounted or renamed home directory rather than retention),
   * and rows touched within the grace window are left alone.
   */
  async pruneSessionsWithMissingTranscripts(options: PruneOptions = {}): Promise<SessionPruneResult> {
    const now = Date.now();

    if (!options.force && now - lastPruneAt < PRUNE_THROTTLE_MS) {
      return emptyResult(true);
    }

    lastPruneAt = now;

    const rows = sessionsDb.listSessionTranscriptRefs();
    if (rows.length === 0) {
      return emptyResult(false);
    }

    const buckets = new Map<string, ProviderBucket>();

    for (const row of rows) {
      const bucket = buckets.get(row.provider) ?? { present: 0, orphaned: [] };
      buckets.set(row.provider, bucket);

      // A row with no recorded transcript cannot be verified, so it stays.
      if (!row.jsonl_path) {
        bucket.present += 1;
        continue;
      }

      if (await transcriptExists(row.jsonl_path)) {
        bucket.present += 1;
        continue;
      }

      if (isWithinGracePeriod(row.updated_at, now)) {
        bucket.present += 1;
        continue;
      }

      bucket.orphaned.push(row.session_id);
    }

    const removedByProvider: Record<string, number> = {};
    const skippedProviders: string[] = [];
    const idsToDelete: string[] = [];

    for (const [provider, bucket] of buckets) {
      if (bucket.orphaned.length === 0) {
        continue;
      }

      if (bucket.present === 0) {
        skippedProviders.push(provider);
        continue;
      }

      removedByProvider[provider] = bucket.orphaned.length;
      idsToDelete.push(...bucket.orphaned);
    }

    const removed = sessionsDb.deleteSessionsByIds(idsToDelete);

    if (removed > 0) {
      console.log('[Sessions] Pruned sessions whose transcript no longer exists', {
        removed,
        removedByProvider,
      });
    }

    if (skippedProviders.length > 0) {
      console.warn(
        '[Sessions] Skipped pruning providers whose transcripts all look unavailable',
        { skippedProviders },
      );
    }

    return {
      removed,
      removedByProvider,
      skippedProviders,
      throttled: false,
    };
  },

  /**
   * Removes the rows indexed from one transcript file that just disappeared.
   *
   * Returns the deleted session ids so the caller can tell clients which
   * threads vanished.
   */
  pruneSessionsForDeletedTranscript(filePath: string): string[] {
    const removedIds = sessionsDb.deleteSessionsByJsonlPath(filePath);

    if (removedIds.length > 0) {
      console.log('[Sessions] Removed sessions for a deleted transcript', {
        filePath,
        removedIds,
      });
    }

    return removedIds;
  },

  /** Test seam: clears the throttle so a following pass runs immediately. */
  resetThrottleForTests(): void {
    lastPruneAt = 0;
  },
};
