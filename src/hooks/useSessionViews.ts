import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../utils/api';
import type { SessionView } from '../utils/sessionView';

/**
 * Last used view (chat or terminal) per session, stored server-side so the
 * choice follows the user across devices.
 */
export function useSessionViews() {
  const [views, setViews] = useState<Record<string, SessionView>>({});
  const [loaded, setLoaded] = useState(false);
  const viewsRef = useRef(views);
  viewsRef.current = views;

  useEffect(() => {
    let cancelled = false;

    api
      .getSessionViews()
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!cancelled && body?.views && typeof body.views === 'object') {
          // Anything remembered locally while the request was in flight wins.
          setViews((local) => ({ ...body.views, ...local }));
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const rememberView = useCallback((sessionId: string, view: SessionView) => {
    if (viewsRef.current[sessionId] === view) {
      return;
    }

    setViews((previous) => ({ ...previous, [sessionId]: view }));
    void api.setSessionView(sessionId, view).catch(() => {});
  }, []);

  return { views, loaded, rememberView };
}
