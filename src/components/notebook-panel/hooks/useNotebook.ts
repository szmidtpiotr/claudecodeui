import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../utils/api';

const DEBOUNCE_MS = 800;
const POLL_INTERVAL_MS = 5000;

interface NoteResponse {
  content: string;
  updatedAt: number | null;
}

async function fetchNote(projectId: string, file: string): Promise<NoteResponse> {
  const res = await api.notes.get(projectId, file);
  return res.json();
}

export function useNotebook(projectId: string | null, filename: string) {
  const [content, setContent] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const knownMtimeRef = useRef<number | null>(null);
  const hasPendingChangesRef = useRef(false);

  // Load on project or file change
  useEffect(() => {
    if (!projectId) {
      setContent('');
      knownMtimeRef.current = null;
      return;
    }

    // Cancel any pending save for previous file
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    hasPendingChangesRef.current = false;

    setIsLoading(true);
    fetchNote(projectId, filename)
      .then(({ content: loaded, updatedAt }) => {
        setContent(loaded);
        knownMtimeRef.current = updatedAt;
      })
      .catch(() => setContent(''))
      .finally(() => setIsLoading(false));
  }, [projectId, filename]);

  // Poll for external changes (agent writing to file)
  useEffect(() => {
    if (!projectId) return;

    const id = setInterval(async () => {
      if (hasPendingChangesRef.current) return;

      try {
        const { content: polled, updatedAt } = await fetchNote(projectId, filename);
        if (updatedAt !== null && updatedAt !== knownMtimeRef.current) {
          setContent(polled);
          knownMtimeRef.current = updatedAt;
        }
      } catch {
        // network error — retry next interval
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(id);
  }, [projectId, filename]);

  const updateContent = useCallback((text: string) => {
    setContent(text);
    hasPendingChangesRef.current = true;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      if (!projectId) return;
      setIsSaving(true);
      try {
        const res = await api.notes.save(projectId, text, filename);
        const data = await res.json();
        if (data.updatedAt) knownMtimeRef.current = data.updatedAt;
      } finally {
        setIsSaving(false);
        hasPendingChangesRef.current = false;
      }
    }, DEBOUNCE_MS);
  }, [projectId, filename]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  return { content, updateContent, isSaving, isLoading };
}
