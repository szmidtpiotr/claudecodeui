import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import { findFilesRecursivelyCreatedAfter, normalizeSessionName, readFileTimestamps, readObjectRecord, readOptionalString } from '@/shared/utils.js';

const SESSIONS_DIR = path.join(os.homedir(), '.azure-openai', 'sessions');

export class AzureSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'azure' as const;

  async synchronize(since?: Date): Promise<number> {
    const files = await findFilesRecursivelyCreatedAfter(SESSIONS_DIR, '.jsonl', since ?? null);
    let processed = 0;
    for (const filePath of files) {
      if (await this.processFile(filePath)) processed++;
    }
    return processed;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) return null;
    return this.processFile(filePath);
  }

  private async processFile(filePath: string): Promise<string | null> {
    try {
      const content = await readFile(filePath, 'utf8');
      const firstLine = content.split('\n').find((l) => l.trim());
      if (!firstLine) return null;
      const parsed = readObjectRecord(JSON.parse(firstLine));
      if (!parsed || parsed.type !== 'session_init') return null;
      const sessionId = readOptionalString(parsed.sessionId);
      const projectPath = readOptionalString(parsed.projectPath);
      if (!sessionId || !projectPath) return null;
      const timestamps = await readFileTimestamps(filePath);
      const existing = sessionsDb.getSessionById(sessionId);
      const name = existing?.custom_name || normalizeSessionName(readOptionalString(parsed.firstMessage), 'Untitled Azure Session');
      sessionsDb.createSession(sessionId, this.provider, projectPath, name, timestamps.createdAt, timestamps.updatedAt, filePath);
      return sessionId;
    } catch { return null; }
  }
}
