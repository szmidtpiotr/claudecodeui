import { useCallback, useEffect, useRef, useState } from 'react';

interface UseQueuedPromptOptions {
  isLoading: boolean;
  sessionId?: string | null;
  onFire: (text: string) => void;
}

interface UseQueuedPromptResult {
  queuedPrompt: string | null;
  enqueue: (text: string) => void;
  clearQueue: () => void;
}

export function useQueuedPrompt({ isLoading, sessionId, onFire }: UseQueuedPromptOptions): UseQueuedPromptResult {
  const [queuedPrompt, setQueuedPrompt] = useState<string | null>(null);
  const prevLoadingRef = useRef(isLoading);
  const onFireRef = useRef(onFire);
  // Tracks whether we've already fired the queued prompt and are waiting for
  // isLoading to become true before clearing the banner (prevents gap where
  // neither the queued banner nor the thinking banner is visible).
  const firedRef = useRef(false);

  // Keep latest onFire without re-triggering effect
  useEffect(() => {
    onFireRef.current = onFire;
  }, [onFire]);

  // Clear queue synchronously when session changes to prevent cross-session flush:
  // if isLoading goes false during a session switch, the queue must not fire into
  // the new session.
  const prevSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId;
      setQueuedPrompt(null);
      firedRef.current = false;
    }
  }, [sessionId]);

  // Detect isLoading transitions and manage the queued prompt lifecycle.
  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = isLoading;

    // isLoading false→true: loading started (after queue fired). Clear banner now.
    if (!wasLoading && isLoading && firedRef.current) {
      firedRef.current = false;
      setQueuedPrompt(null);
      return;
    }

    // isLoading true→false: session completed. Fire queued prompt if present.
    if (wasLoading && !isLoading && queuedPrompt && !firedRef.current) {
      firedRef.current = true;
      const text = queuedPrompt;
      // Keep queuedPrompt visible until isLoading=true so there's no blank gap
      // between the queued banner and the thinking banner.
      setTimeout(() => onFireRef.current(text), 0);
    }
  }, [isLoading, queuedPrompt]);

  const enqueue = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setQueuedPrompt(trimmed);
  }, []);

  const clearQueue = useCallback(() => {
    setQueuedPrompt(null);
    firedRef.current = false;
  }, []);

  return { queuedPrompt, enqueue, clearQueue };
}
