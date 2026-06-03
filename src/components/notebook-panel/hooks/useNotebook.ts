import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../utils/api';

const DEBOUNCE_MS = 800;
const POLL_INTERVAL_MS = 5000;

interface NoteResponse {
  content: string;
  updatedAt: number | null;
}

async function fetchNote(projectId: string): Promise<NoteResponse> {
  const res = await api.notes.get(projectId);
  return res.json();
}

export function useNotebook(projectId: string | null) {
  const [content, setContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const knownMtimeRef = useRef<number | null>(null);
  // true while user has unsaved changes — poll skips content update
  const hasPendingChangesRef = useRef(false);

  // Initial load
  useEffect(() => {
    if (!projectId) {
      setContent('');
      knownMtimeRef.current = null;
      return;
    }

    setIsLoading(true);
    fetchNote(projectId)
      .then(({ content: loaded, updatedAt }) => {
        setContent(loaded);
        knownMtimeRef.current = updatedAt;
      })
      .catch(() => setContent(''))
      .finally(() => setIsLoading(false));
  }, [projectId]);

  // Poll for external changes (agent writing to notes.md)
  useEffect(() => {
    if (!projectId) return;

    const id = setInterval(async () => {
      if (hasPendingChangesRef.current) return;

      try {
        const { content: polled, updatedAt } = await fetchNote(projectId);
        if (updatedAt !== null && updatedAt !== knownMtimeRef.current) {
          setContent(polled);
          knownMtimeRef.current = updatedAt;
        }
      } catch {
        // network error — ignore, retry next interval
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(id);
  }, [projectId]);

  const updateContent = useCallback((text: string) => {
    setContent(text);
    hasPendingChangesRef.current = true;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      if (!projectId) return;
      setIsSaving(true);
      try {
        const res = await api.notes.save(projectId, text);
        const data = await res.json();
        if (data.updatedAt) knownMtimeRef.current = data.updatedAt;
      } finally {
        setIsSaving(false);
        hasPendingChangesRef.current = false;
      }
    }, DEBOUNCE_MS);
  }, [projectId]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  return { content, updateContent, isSaving, isLoading };
}
