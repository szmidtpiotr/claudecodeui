import { useCallback, useEffect, useState } from 'react';

import type { Project, LLMProvider } from '../types/app';
import { api } from '../utils/api';

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

// ---------------------------------------------------------------------------
// Pinned sessions — server-backed, shared across devices.
//
// Pins used to live in localStorage, which never synced between desktop and
// mobile and silently diverged (pins made on one device were invisible on the
// other, and stale entries reappeared on re-pin). They are now persisted on the
// server (GET/PUT /api/settings/pinned-sessions). A module-level cache keeps all
// hook instances in sync within a tab; a focus listener re-pulls so a pin made
// on another device shows up when the user returns to this one.
// ---------------------------------------------------------------------------

let pinsCache = new Set<string>();
let pinsLoaded = false;
let pinsLoading = false;
const pinSubscribers = new Set<() => void>();

function notifyPinSubscribers(): void {
  pinSubscribers.forEach((fn) => fn());
}

function readLegacyLocalPins(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PINS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

async function persistPins(ids: Set<string>): Promise<void> {
  try {
    await api.setPinnedSessions([...ids]);
  } catch (err) {
    console.error('Failed to persist pinned sessions:', err);
  }
}

async function loadPinsFromServer(): Promise<void> {
  if (pinsLoading) return;
  pinsLoading = true;
  try {
    const res = await api.getPinnedSessions();
    const data = await res.json();
    const serverIds: string[] = Array.isArray(data?.sessionIds) ? data.sessionIds : [];

    // One-time migration: fold any pins left in localStorage into the server
    // set so users do not lose pins made before the server-sync change.
    const legacy = readLegacyLocalPins();
    const merged = new Set<string>([...serverIds, ...legacy]);
    if (legacy.length > 0) {
      localStorage.removeItem(PINS_KEY);
      if (merged.size !== serverIds.length) {
        await persistPins(merged);
      }
    }

    pinsCache = merged;
    pinsLoaded = true;
    notifyPinSubscribers();
  } catch (err) {
    console.error('Failed to load pinned sessions:', err);
  } finally {
    pinsLoading = false;
  }
}

export function useUnreadSessions(projects: Project[]) {
  const [, forceUpdate] = useState(0);
  const refresh = useCallback(() => forceUpdate(n => n + 1), []);

  // Subscribe to pin-cache changes and load from the server once.
  useEffect(() => {
    pinSubscribers.add(refresh);
    if (!pinsLoaded) {
      void loadPinsFromServer();
    }
    const onFocus = () => { void loadPinsFromServer(); };
    window.addEventListener('focus', onFocus);
    return () => {
      pinSubscribers.delete(refresh);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const markRead = useCallback((sessionId: string) => {
    const reads = getReads();
    reads[sessionId] = Date.now();
    localStorage.setItem(READS_KEY, JSON.stringify(reads));
    refresh();
  }, [refresh]);

  const togglePin = useCallback((sessionId: string) => {
    const next = new Set(pinsCache);
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    pinsCache = next;            // optimistic update
    notifyPinSubscribers();
    void persistPins(next);      // sync to server
  }, []);

  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  const unreadEntries: UnreadSessionEntry[] = [];
  const reads = getReads();
  const pins = pinsCache;

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
      if (isNaN(activityMs)) continue;

      const lastRead = reads[session.id] ?? 0;
      const pinned = pins.has(session.id);

      // Pinned sessions bypass the age cutoff — a pin should keep a session
      // visible indefinitely, not silently drop it after 7 days of inactivity.
      if (activityMs < cutoff && !pinned) continue;

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

  return { unreadEntries, unreadCount: unreadEntries.length, markRead, togglePin, pinnedSessionIds: pinsCache };
}
