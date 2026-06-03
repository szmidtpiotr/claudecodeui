import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpen, ChevronRight, Edit3, Eye } from 'lucide-react';
import { useNotebook } from '../hooks/useNotebook';

const HANDLE_Y_PERCENT = 72;
const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 240;
const MAX_WIDTH = 800;
const WIDTH_STORAGE_KEY = 'notebookPanelWidth';

function readStoredWidth(): number {
  try {
    const v = localStorage.getItem(WIDTH_STORAGE_KEY);
    if (!v) return DEFAULT_WIDTH;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, n)) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

type NotebookPanelViewProps = {
  projectId: string | null;
};

export default function NotebookPanelView({ projectId }: NotebookPanelViewProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [panelWidth, setPanelWidth] = useState(readStoredWidth);
  const [isResizing, setIsResizing] = useState(false);
  const { content, updateContent, isSaving, isLoading } = useNotebook(projectId);

  const startXRef = useRef(0);
  const startWidthRef = useRef(panelWidth);

  const startResize = useCallback((clientX: number) => {
    startXRef.current = clientX;
    startWidthRef.current = panelWidth;
    setIsResizing(true);
  }, [panelWidth]);

  useEffect(() => {
    if (!isResizing) return;

    const onMove = (e: MouseEvent | TouchEvent) => {
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      const delta = startXRef.current - clientX;
      const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidthRef.current + delta));
      setPanelWidth(next);
    };

    const onUp = () => {
      setIsResizing(false);
      setPanelWidth((w) => {
        try { localStorage.setItem(WIDTH_STORAGE_KEY, String(w)); } catch { /* ignore */ }
        return w;
      });
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
  }, [isResizing]);

  const transition = isResizing ? '' : 'transition-all duration-150 ease-out';

  return (
    <>
      {/* Floating toggle handle */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className={`fixed z-50 ${transition} border bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 rounded-l-md p-2 shadow-lg hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer touch-none`}
        style={{
          top: `${HANDLE_Y_PERCENT}%`,
          transform: 'translateY(-50%)',
          right: isOpen ? panelWidth : 0,
        }}
        aria-label={isOpen ? 'Close notebook' : 'Open notebook'}
        title="Project notebook"
      >
        {isOpen ? (
          <ChevronRight className="h-5 w-5 text-gray-600 dark:text-gray-400" />
        ) : (
          <BookOpen className="h-5 w-5 text-gray-600 dark:text-gray-400" />
        )}
      </button>

      {/* Panel */}
      <div
        className={`fixed right-0 top-0 z-40 h-full transform border-l border-border bg-background shadow-xl ${isResizing ? '' : 'transition-transform duration-150 ease-out'} ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}
        style={{ width: panelWidth }}
      >
        {/* Resize drag strip — left edge */}
        <div
          className={`absolute left-0 top-0 h-full w-1 cursor-ew-resize hover:bg-blue-500/40 ${isResizing ? 'bg-blue-500/40' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); startResize(e.clientX); }}
          onTouchStart={(e) => startResize(e.touches[0].clientX)}
        />

        <div className="flex h-full flex-col">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Notebook</span>
              {isSaving && (
                <span className="text-xs text-muted-foreground">saving…</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setIsEditing((prev) => !prev)}
                className="rounded p-1 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                title={isEditing ? 'Preview' : 'Edit'}
              >
                {isEditing ? (
                  <Eye className="h-4 w-4" />
                ) : (
                  <Edit3 className="h-4 w-4" />
                )}
              </button>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="rounded p-1 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-hidden">
            {isLoading ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Loading…
              </div>
            ) : isEditing ? (
              <textarea
                className="h-full w-full resize-none bg-background p-4 text-sm font-mono text-foreground outline-none"
                value={content}
                onChange={(e) => updateContent(e.target.value)}
                placeholder="Write notes here… Markdown supported."
                spellCheck={false}
              />
            ) : content ? (
              <div className="prose prose-sm dark:prose-invert h-full overflow-y-auto p-4 max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {content}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-muted-foreground">
                <BookOpen className="h-8 w-8 opacity-30" />
                <p className="text-sm">No notes yet.</p>
                <button
                  type="button"
                  onClick={() => setIsEditing(true)}
                  className="text-xs underline hover:text-foreground"
                >
                  Start writing
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-background/80 backdrop-blur-sm transition-opacity duration-150 ease-out"
          onClick={() => setIsOpen(false)}
        />
      )}
    </>
  );
}
