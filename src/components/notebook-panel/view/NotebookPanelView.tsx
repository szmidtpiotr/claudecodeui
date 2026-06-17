import { memo, useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Hoisted so the array identity is stable across renders (inline `[remarkGfm]`
// would force ReactMarkdown to treat plugins as changed every render).
const NOTEBOOK_REMARK_PLUGINS = [remarkGfm];
import {
  Bold, BookOpen, ChevronDown, ChevronRight, Code, Edit3,
  Eye, GripVertical, Heading1, Heading2, Heading3,
  Italic, List, ListChecks, ListOrdered, Minus, Type,
} from 'lucide-react';
import { api } from '../../../utils/api';
import { useNotebook } from '../hooks/useNotebook';
import { useNotebookHandleDrag } from '../hooks/useNotebookHandleDrag';

const DEFAULT_FILE = 'notes.md';
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

type ToolbarAction =
  | { type: 'wrap'; before: string; after: string; label: string }
  | { type: 'line'; prefix: string; label: string }
  | { type: 'insert'; text: string; label: string }
  | { type: 'divider' };

const TOOLBAR_ACTIONS: ToolbarAction[] = [
  { type: 'wrap', before: '**', after: '**', label: 'Bold' },
  { type: 'wrap', before: '*', after: '*', label: 'Italic' },
  { type: 'divider' },
  { type: 'line', prefix: '# ', label: 'H1' },
  { type: 'line', prefix: '## ', label: 'H2' },
  { type: 'line', prefix: '### ', label: 'H3' },
  { type: 'divider' },
  { type: 'line', prefix: '- ', label: 'Unordered list' },
  { type: 'line', prefix: '1. ', label: 'Ordered list' },
  { type: 'line', prefix: '- [ ] ', label: 'Task list' },
  { type: 'divider' },
  { type: 'wrap', before: '`', after: '`', label: 'Inline code' },
  { type: 'insert', text: '\n```\n\n```\n', label: 'Code block' },
  { type: 'insert', text: '\n---\n', label: 'Divider' },
];

const TOOLBAR_ICONS: Record<string, React.ReactNode> = {
  'Bold': <Bold className="h-3.5 w-3.5" />,
  'Italic': <Italic className="h-3.5 w-3.5" />,
  'H1': <Heading1 className="h-3.5 w-3.5" />,
  'H2': <Heading2 className="h-3.5 w-3.5" />,
  'H3': <Heading3 className="h-3.5 w-3.5" />,
  'Unordered list': <List className="h-3.5 w-3.5" />,
  'Ordered list': <ListOrdered className="h-3.5 w-3.5" />,
  'Task list': <ListChecks className="h-3.5 w-3.5" />,
  'Inline code': <Code className="h-3.5 w-3.5" />,
  'Code block': <Code className="h-3.5 w-3.5 opacity-70" />,
  'Divider': <Minus className="h-3.5 w-3.5" />,
};

type NotebookPanelViewProps = {
  projectId: string | null;
};

function NotebookPanelView({ projectId }: NotebookPanelViewProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [showToolbar, setShowToolbar] = useState(false);
  const [panelWidth, setPanelWidth] = useState(readStoredWidth);
  const [isResizing, setIsResizing] = useState(false);
  const [activeFile, setActiveFile] = useState(DEFAULT_FILE);
  const [availableFiles, setAvailableFiles] = useState<string[]>([DEFAULT_FILE]);
  const [showFilePicker, setShowFilePicker] = useState(false);

  const filePickerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { content, updateContent, isSaving, isLoading } = useNotebook(projectId, activeFile);
  const { isDragging, handleStyle, startDrag, consumeSuppressedClick } = useNotebookHandleDrag();

  // Load available .md files when project changes or panel opens
  useEffect(() => {
    if (!projectId || !isOpen) return;
    api.notes.listFiles(projectId)
      .then((res: Response) => res.json())
      .then((data: { files: string[] }) => setAvailableFiles(data.files ?? [DEFAULT_FILE]))
      .catch(() => setAvailableFiles([DEFAULT_FILE]));
  }, [projectId, isOpen]);

  // Close file picker only when clicking OUTSIDE the dropdown
  useEffect(() => {
    if (!showFilePicker) return;
    const handler = (e: MouseEvent) => {
      if (filePickerRef.current && !filePickerRef.current.contains(e.target as Node)) {
        setShowFilePicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showFilePicker]);

  // Markdown insertion helpers
  const applyAction = useCallback((action: ToolbarAction) => {
    const ta = textareaRef.current;
    if (!ta || action.type === 'divider') return;

    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = content.slice(start, end);

    let newContent: string;
    let cursorStart: number;
    let cursorEnd: number;

    if (action.type === 'wrap') {
      newContent = content.slice(0, start) + action.before + selected + action.after + content.slice(end);
      cursorStart = start + action.before.length;
      cursorEnd = cursorStart + selected.length;
    } else if (action.type === 'line') {
      const lineStart = content.lastIndexOf('\n', start - 1) + 1;
      newContent = content.slice(0, lineStart) + action.prefix + content.slice(lineStart);
      cursorStart = start + action.prefix.length;
      cursorEnd = end + action.prefix.length;
    } else {
      // insert
      newContent = content.slice(0, start) + action.text + content.slice(end);
      cursorStart = start + action.text.length;
      cursorEnd = cursorStart;
    }

    updateContent(newContent);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(cursorStart, cursorEnd);
    });
  }, [content, updateContent]);

  // Panel resize
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
      {/* Floating toggle/drag handle */}
      <button
        type="button"
        onClick={(e) => {
          if (consumeSuppressedClick()) { e.preventDefault(); return; }
          setIsOpen((prev) => !prev);
        }}
        onMouseDown={startDrag}
        onTouchStart={startDrag}
        className={`fixed z-50 ${isDragging ? 'cursor-grabbing' : 'cursor-pointer'} ${isResizing ? '' : transition} border bg-white dark:bg-gray-800 ${isDragging ? 'border-blue-500 dark:border-blue-400' : 'border-gray-200 dark:border-gray-700'} rounded-l-md p-2 shadow-lg hover:bg-gray-100 dark:hover:bg-gray-700 touch-none`}
        style={{ ...handleStyle, right: isOpen ? panelWidth : 0 }}
        aria-label={isDragging ? 'Dragging' : isOpen ? 'Close notebook' : 'Open notebook'}
        title="Project notebook — drag to reposition"
      >
        {isDragging ? (
          <GripVertical className="h-5 w-5 text-blue-500 dark:text-blue-400" />
        ) : isOpen ? (
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
        {/* Resize drag strip */}
        <div
          className={`absolute left-0 top-0 h-full w-1 cursor-ew-resize hover:bg-blue-500/40 ${isResizing ? 'bg-blue-500/40' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); startResize(e.clientX); }}
          onTouchStart={(e) => startResize(e.touches[0].clientX)}
        />

        <div className="flex h-full flex-col">
          {/* Header */}
          <div className="border-b border-border px-3 py-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 min-w-0">
                <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="relative min-w-0">
                  <button
                    type="button"
                    onClick={() => setShowFilePicker((p) => !p)}
                    className="flex items-center gap-1 rounded px-1 py-0.5 text-sm font-medium hover:bg-accent transition-colors max-w-[160px] truncate"
                    title={activeFile}
                  >
                    <span className="truncate">{activeFile}</span>
                    <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                  </button>
                  {showFilePicker && (
                    <div ref={filePickerRef} className="absolute left-0 top-full z-50 mt-1 w-56 rounded-md border border-border bg-popover shadow-lg">
                      <div className="py-1 max-h-64 overflow-y-auto">
                        {availableFiles.map((f) => (
                          <button
                            key={f}
                            type="button"
                            onClick={() => { setActiveFile(f); setShowFilePicker(false); setIsEditing(false); }}
                            className={`w-full px-3 py-1.5 text-left text-sm hover:bg-accent transition-colors ${f === activeFile ? 'text-primary font-medium' : 'text-foreground'}`}
                          >
                            {f}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                {isSaving && <span className="text-xs text-muted-foreground shrink-0">saving…</span>}
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {isEditing && (
                  <button
                    type="button"
                    onClick={() => setShowToolbar((p) => !p)}
                    className={`rounded p-1 transition-colors ${showToolbar ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}
                    title="Formatting toolbar"
                  >
                    <Type className="h-4 w-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => { setIsEditing((prev) => !prev); if (isEditing) setShowToolbar(false); }}
                  className="rounded p-1 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                  title={isEditing ? 'Preview' : 'Edit'}
                >
                  {isEditing ? <Eye className="h-4 w-4" /> : <Edit3 className="h-4 w-4" />}
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
          </div>

          {/* Markdown toolbar */}
          {isEditing && showToolbar && (
            <div className="flex flex-wrap items-center gap-0.5 border-b border-border bg-muted/30 px-2 py-1">
              {TOOLBAR_ACTIONS.map((action, i) =>
                action.type === 'divider' ? (
                  <div key={i} className="mx-0.5 h-4 w-px bg-border" />
                ) : (
                  <button
                    key={action.label}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault(); // keep textarea focus
                      applyAction(action);
                    }}
                    className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                    title={action.label}
                  >
                    {TOOLBAR_ICONS[action.label] ?? <span className="text-xs font-mono">{action.label}</span>}
                  </button>
                )
              )}
            </div>
          )}

          {/* Content */}
          <div className="flex-1 overflow-hidden">
            {isLoading ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Loading…
              </div>
            ) : isEditing ? (
              <textarea
                ref={textareaRef}
                className="h-full w-full resize-none bg-background p-4 text-sm font-mono text-foreground outline-none"
                value={content}
                onChange={(e) => updateContent(e.target.value)}
                placeholder="Write notes here… Markdown supported."
                spellCheck={false}
              />
            ) : content ? (
              <div className="prose prose-sm dark:prose-invert h-full overflow-y-auto p-4 max-w-none">
                {/* Only parse/render the (potentially huge) markdown while the panel
                    is actually open — when closed it is hidden off-screen anyway. */}
                {isOpen ? (
                  <ReactMarkdown remarkPlugins={NOTEBOOK_REMARK_PLUGINS}>{content}</ReactMarkdown>
                ) : null}
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

// Memoized: NotebookPanel is permanently mounted inside ChatInterface, which
// re-renders on every keystroke in the chat composer. Without memo, this panel
// re-rendered each keystroke and its ReactMarkdown re-parsed the entire notes
// file (~100KB -> ~245ms/keystroke). `projectId` is the only prop and is stable.
export default memo(NotebookPanelView);
