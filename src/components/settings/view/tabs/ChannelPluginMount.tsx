import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../../../../contexts/ThemeContext';
import { authenticatedFetch } from '../../../../utils/api';

type Props = { pluginName: string; entry: string };

type PluginContext = {
  theme: 'dark' | 'light';
  project: { name: string; path: string } | null;
  session: { id: string; title: string } | null;
};

/**
 * Mounts a notification-channel plugin's frontend inside Settings → Notifications.
 * Unlike the full-tab PluginTabContent, this is StrictMode-safe (mounts once,
 * persists across the dev double-invoke) and surfaces load errors inline instead
 * of failing silently.
 */
export default function ChannelPluginMount({ pluginName, entry }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const moduleRef = useRef<any>(null);
  const mountedRef = useRef(false);
  const { isDarkMode } = useTheme();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Keep a live theme ref so the plugin's context getter reflects changes.
  const themeRef = useRef<'dark' | 'light'>(isDarkMode ? 'dark' : 'light');
  const callbacksRef = useRef<Set<(ctx: PluginContext) => void>>(new Set());

  useEffect(() => {
    themeRef.current = isDarkMode ? 'dark' : 'light';
    const ctx: PluginContext = { theme: themeRef.current, project: null, session: null };
    for (const cb of callbacksRef.current) {
      try { cb(ctx); } catch { /* ignore */ }
    }
  }, [isDarkMode]);

  useEffect(() => {
    const container = containerRef.current;
    // Mount exactly once and persist across StrictMode's dev double-invoke.
    if (!container || mountedRef.current) return;
    mountedRef.current = true;

    (async () => {
      try {
        const assetUrl = `/api/plugins/${encodeURIComponent(pluginName)}/assets/${encodeURIComponent(entry)}`;
        const res = await authenticatedFetch(assetUrl);
        if (!res.ok) throw new Error(`Failed to fetch plugin (HTTP ${res.status})`);
        const jsText = await res.text();
        const blob = new Blob([jsText], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        const mod = await import(/* @vite-ignore */ blobUrl).finally(() => URL.revokeObjectURL(blobUrl));

        if (typeof mod.mount !== 'function') {
          throw new Error('Plugin does not export a mount() function');
        }

        const api = {
          get context(): PluginContext {
            return { theme: themeRef.current, project: null, session: null };
          },
          onContextChange(cb: (ctx: PluginContext) => void): () => void {
            callbacksRef.current.add(cb);
            return () => callbacksRef.current.delete(cb);
          },
          async rpc(method: string, path: string, body?: unknown): Promise<unknown> {
            const cleanPath = String(path).replace(/^\//, '');
            const r = await authenticatedFetch(
              `/api/plugins/${encodeURIComponent(pluginName)}/rpc/${cleanPath}`,
              {
                method: method || 'GET',
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
              },
            );
            if (!r.ok) throw new Error(`RPC error ${r.status}`);
            return r.json();
          },
        };

        moduleRef.current = mod;
        await mod.mount(container, api);
        setLoading(false);
      } catch (err) {
        setError(String(err instanceof Error ? err.message : err));
        setLoading(false);
      }
    })();
    // No cleanup-cancel: we mount once and let the DOM node teardown dispose it.
    // StrictMode's double-invoke is handled by the mountedRef guard above.
  }, [pluginName, entry]);

  return (
    <div className="relative w-full" style={{ height: 'min(70vh, 620px)' }}>
      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-sm text-red-500 text-center">
          Failed to load: {error}
        </div>
      )}
      <div ref={containerRef} className="h-full w-full overflow-auto" />
    </div>
  );
}
