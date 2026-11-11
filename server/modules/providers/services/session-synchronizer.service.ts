import { scanStateDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionPruneService } from '@/modules/providers/services/session-prune.service.js';
import { sessionTitleService } from '@/modules/providers/services/session-title.service.js';
import type { LLMProvider } from '@/shared/types.js';

type SessionSynchronizeResult = {
  processedByProvider: Record<LLMProvider, number>;
  failures: string[];
  /** Orphaned rows dropped by the prune pass that follows a clean scan. */
  pruned: number;
};

/**
 * Orchestrates provider-specific session indexers and indexed-session lifecycle operations.
 */
export const sessionSynchronizerService = {
  /**
   * Runs all provider synchronizers and updates scan_state.last_scanned_at.
   */
  async synchronizeSessions(): Promise<SessionSynchronizeResult> {
    const lastScanAt = scanStateDb.getLastScannedAt();
    const scanBoundary = new Date();
    const processedByProvider: Record<LLMProvider, number> = {
      azure: 0,
      claude: 0,
      codex: 0,
      cursor: 0,
      gemini: 0,
      opencode: 0,
    };
    const failures: string[] = [];

    const results = await Promise.allSettled(
      providerRegistry.listProviders().map(async (provider) => ({
        provider: provider.id,
        processed: await provider.sessionSynchronizer.synchronize(lastScanAt ?? undefined),
      }))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        processedByProvider[result.value.provider] = result.value.processed;
        continue;
      }

      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push(reason);
    }

    if (failures.length === 0) {
      scanStateDb.updateLastScannedAt(scanBoundary);
    } else {
      console.warn(
        `[Sessions] Skipping scan_state cursor advance because ${failures.length} provider sync(s) failed.`,
      );
    }

    // Scanning only adds rows, so orphans left behind by the CLI's own
    // transcript retention are removed here. It is skipped after a failed scan
    // because a provider that just errored cannot be told apart from one whose
    // files are temporarily unreadable.
    let pruned = 0;
    if (failures.length === 0) {
      try {
        pruned = (await sessionPruneService.pruneSessionsWithMissingTranscripts()).removed;
      } catch (error: unknown) {
        console.warn('[Sessions] Session prune failed:', error);
      }
    }

    // Titling is a best-effort follow-up: a failed or disabled generator must
    // never make a successful session scan look like a failed one.
    void sessionTitleService.generateMissingTitles().catch((error: unknown) => {
      console.warn('[Sessions] Session title generation failed:', error);
    });

    return {
      processedByProvider,
      failures,
      pruned,
    };
  },

  /**
   * Indexes one provider artifact file without running a full provider rescan.
   */
  async synchronizeProviderFile(
    provider: LLMProvider,
    filePath: string
  ): Promise<{ provider: LLMProvider; indexed: boolean; sessionId: string | null }> {
    const resolvedProvider = providerRegistry.resolveProvider(provider);
    const sessionId = await resolvedProvider.sessionSynchronizer.synchronizeFile(filePath);

    // Retitle the session that just changed rather than waiting for the next
    // full scan, so a live conversation picks up a real title quickly.
    if (sessionId && sessionTitleService.isAutoTitleEnabled()) {
      void sessionTitleService.generateTitleForSession(sessionId).catch((error: unknown) => {
        console.warn(`[Sessions] Session title generation failed for ${sessionId}:`, error);
      });
    }

    return {
      provider,
      indexed: Boolean(sessionId),
      sessionId,
    };
  },
};
