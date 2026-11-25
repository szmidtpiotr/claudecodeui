import { useCallback, useEffect, useState } from 'react';

/**
 * When a long text is pasted into the chat composer, it is held aside as a
 * "pasted text" block and only a short marker goes into the textarea. These
 * settings decide when that happens. Stored per browser in localStorage.
 */
export type PasteSettings = {
  collapseLongPastes: boolean;
  /** A paste longer than this many characters is collapsed. */
  minChars: number;
  /** A paste with more than this many lines is collapsed. */
  minLines: number;
};

export const PASTE_SETTINGS_DEFAULTS: PasteSettings = {
  collapseLongPastes: true,
  minChars: 2000,
  minLines: 30,
};

const STORAGE_KEY = 'pasteSettings';
const SYNC_EVENT = 'paste-settings:sync';

const clampCount = (value: unknown, fallback: number): number => {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.min(Math.round(number), 1_000_000);
};

export const readPasteSettings = (): PasteSettings => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return PASTE_SETTINGS_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Record<keyof PasteSettings, unknown>>;
    return {
      collapseLongPastes: typeof parsed.collapseLongPastes === 'boolean'
        ? parsed.collapseLongPastes
        : PASTE_SETTINGS_DEFAULTS.collapseLongPastes,
      minChars: clampCount(parsed.minChars, PASTE_SETTINGS_DEFAULTS.minChars),
      minLines: clampCount(parsed.minLines, PASTE_SETTINGS_DEFAULTS.minLines),
    };
  } catch {
    return PASTE_SETTINGS_DEFAULTS;
  }
};

export function usePasteSettings() {
  const [settings, setSettings] = useState<PasteSettings>(readPasteSettings);

  useEffect(() => {
    const reload = () => setSettings(readPasteSettings());
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) reload();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(SYNC_EVENT, reload);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(SYNC_EVENT, reload);
    };
  }, []);

  const updateSettings = useCallback((patch: Partial<PasteSettings>) => {
    const next: PasteSettings = {
      ...readPasteSettings(),
      ...patch,
    };
    next.minChars = clampCount(next.minChars, PASTE_SETTINGS_DEFAULTS.minChars);
    next.minLines = clampCount(next.minLines, PASTE_SETTINGS_DEFAULTS.minLines);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable: the setting still applies for this page view.
    }
    setSettings(next);
    window.dispatchEvent(new Event(SYNC_EVENT));
  }, []);

  return { settings, updateSettings };
}
