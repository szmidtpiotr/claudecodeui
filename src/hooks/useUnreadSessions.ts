import { useCallback, useState } from 'react';
import type { Project, LLMProvider } from '../types/app';

export type UnreadSessionEntry = {
  sessionId: string;
  sessionName: string;
  projectId: string;
  projectName: string;
  lastActivity: string; // ISO
  provider: LLMProvider;
  pinned: boolean;
};

const READS_KEY = 'unread-session-reads';
const PINS_KEY = 'unread-session-pins';
const MAX_AGE_DAYS = 7;

function getReads(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(READS_KEY) || '{}'); } catch { return {}; }
}
function getPins(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(PINS_KEY) || '[]')); } catch { return new Set(); }
}

export function useUnreadSessions(projects: Project[]) {
  const [, forceUpdate] = useState(0);
  const refresh = useCallback(() => forceUpdate(n => n + 1), []);

  const markRead = useCallback((sessionId: string) => {
    const reads = getReads();
    reads[sessionId] = Date.now();
    localStorage.setItem(READS_KEY, JSON.stringify(reads));
    refresh();
  }, [refresh]);

  const togglePin = useCallback((sessionId: string) => {
    const pins = getPins();
    if (pins.has(sessionId)) pins.delete(sessionId);
    else pins.add(sessionId);
    localStorage.setItem(PINS_KEY, JSON.stringify([...pins]));
    refresh();
  }, [refresh]);

  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  const unreadEntries: UnreadSessionEntry[] = [];
  const reads = getReads();
  const pins = getPins();

  for (const project of projects) {
    const allSessions = [
      ...(project.sessions || []).map(s => ({ ...s, __provider: 'claude' as LLMProvider })),
      ...(project.cursorSessions || []).map(s => ({ ...s, __provider: 'cursor' as LLMProvider })),
      ...(project.codexSessions || []).map(s => ({ ...s, __provider: 'codex' as LLMProvider })),
      ...(project.geminiSessions || []).map(s => ({ ...s, __provider: 'gemini' as LLMProvider })),
      ...(project.opencodeSessions || []).map(s => ({ ...s, __provider: 'opencode' as LLMProvider })),
    ];

    for (const session of allSessions) {
      const lastActivity = session.lastActivity || session.updated_at || session.createdAt || session.created_at;
      if (!lastActivity) continue;
      const activityMs = new Date(lastActivity).getTime();
      if (isNaN(activityMs) || activityMs < cutoff) continue;

      const lastRead = reads[session.id] ?? 0;
      const pinned = pins.has(session.id);

      if (activityMs > lastRead || pinned) {
        unreadEntries.push({
          sessionId: session.id,
          sessionName: (typeof session.summary === 'string' && session.summary.trim().length > 0
            ? session.summary
            : typeof session.name === 'string' && session.name.trim().length > 0
              ? session.name
              : typeof session.title === 'string' && session.title.trim().length > 0
                ? session.title
                : 'Unnamed session'),
          projectId: project.projectId,
          projectName: project.displayName || project.path?.split('/').pop() || 'Project',
          lastActivity,
          provider: session.__provider,
          pinned,
        });
      }
    }
  }

  // Sort: pinned first, then newest first
  unreadEntries.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
  });

  return { unreadEntries, unreadCount: unreadEntries.length, markRead, togglePin, pinnedSessionIds: getPins() };
}
