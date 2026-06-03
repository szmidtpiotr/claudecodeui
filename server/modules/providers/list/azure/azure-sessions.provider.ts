import fsSync from 'node:fs';
import readline from 'node:readline';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, generateMessageId, readObjectRecord, readOptionalString } from '@/shared/utils.js';

const PROVIDER = 'azure' as const;

export class AzureSessionsProvider implements IProviderSessions {
  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[] {
    const record = readObjectRecord(raw);
    if (!record) return [];
    const kind = readOptionalString(record.kind);
    if (!kind) return [];
    return [createNormalizedMessage({ ...record, kind: kind as NormalizedMessage['kind'], provider: PROVIDER, sessionId: sessionId || '' })];
  }

  async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session?.jsonl_path) return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };

    const messages: NormalizedMessage[] = [];
    try {
      const fileStream = fsSync.createReadStream(session.jsonl_path);
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const parsed = readObjectRecord(JSON.parse(line));
          if (!parsed || parsed.type === 'session_init') continue;
          const role = readOptionalString(parsed.role) as 'user' | 'assistant' | undefined;
          const content = readOptionalString(parsed.content);
          if (!role || !content) continue;
          messages.push(createNormalizedMessage({ kind: 'text', role, content, provider: PROVIDER, sessionId, timestamp: readOptionalString(parsed.timestamp), id: readOptionalString(parsed.id) || generateMessageId(role) }));
        } catch { /* skip */ }
      }
    } catch { return { messages: [], total: 0, hasMore: false, offset: 0, limit: null }; }

    const total = messages.length;
    const offset = options.offset ?? 0;
    const limit = options.limit ?? null;
    const sliced = limit !== null ? messages.slice(offset, offset + limit) : messages.slice(offset);
    return { messages: sliced, total, hasMore: limit !== null && offset + sliced.length < total, offset, limit };
  }
}
