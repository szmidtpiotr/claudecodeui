import { useEffect, useRef, useState } from 'react';

import { useWebSocket } from '../../../contexts/WebSocketContext';

// How often the server is asked which sessions are running a turn right now.
const POLL_INTERVAL_MS = 5000;
// Chat traffic (a turn starting or ending) triggers an earlier refresh, but no
// more often than this, so a streaming reply does not flood the socket.
const EVENT_REFRESH_MIN_GAP_MS = 1500;

function collectIds(sessions: unknown): Set<string> {
  const ids = new Set<string>();
  if (!sessions || typeof sessions !== 'object') {
    return ids;
  }

  for (const list of Object.values(sessions as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === 'string') {
        ids.add(item);
      } else if (item && typeof item === 'object') {
        const id = (item as { id?: unknown; sessionId?: unknown }).id
          ?? (item as { sessionId?: unknown }).sessionId;
        if (typeof id === 'string') ids.add(id);
      }
    }
  }
  return ids;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

/**
 * Session ids the server is running a turn in, across every project and
 * provider — including sessions started from another device or browser tab.
 * Asked over the chat socket (`get-active-sessions`) on connect, every few
 * seconds while the page is visible, and soon after any chat event.
 */
export function useRunningSessionIds(): Set<string> {
  const { sendMessage, latestMessage, isConnected } = useWebSocket();
  const [runningIds, setRunningIds] = useState<Set<string>>(() => new Set());
  const lastRequestAtRef = useRef(0);

  useEffect(() => {
    if (!isConnected) {
      return undefined;
    }

    const request = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      lastRequestAtRef.current = Date.now();
      sendMessage({ type: 'get-active-sessions' });
    };

    request();
    const timer = window.setInterval(request, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') request();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isConnected, sendMessage]);

  useEffect(() => {
    if (!latestMessage || typeof latestMessage !== 'object') return;

    if (latestMessage.type === 'active-sessions') {
      const next = collectIds(latestMessage.sessions);
      setRunningIds((previous) => (sameSet(previous, next) ? previous : next));
      return;
    }

    // Any other chat event may mean a turn started or finished somewhere.
    if (isConnected && Date.now() - lastRequestAtRef.current >= EVENT_REFRESH_MIN_GAP_MS) {
      lastRequestAtRef.current = Date.now();
      sendMessage({ type: 'get-active-sessions' });
    }
  }, [latestMessage, isConnected, sendMessage]);

  return runningIds;
}
