import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Check, Copy, Edit2, Loader2, MoreHorizontal, Pin, PinOff, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ActionMenu, Badge, Button, Dialog, DialogContent, DialogTitle, Tooltip, buttonVariants } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';
import type { Project, ProjectSession, LLMProvider } from '../../../../types/app';
import { api } from '../../../../utils/api';
import { copyTextToClipboard } from '../../../../utils/clipboard';
import type { SessionWithProvider } from '../../types/types';
import { createSessionViewModel, formatCompactAge } from '../../utils/utils';
import { isSessionMovable, writeSessionDragPayload } from '../../utils/sessionDragAndDrop';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';

type SidebarSessionItemProps = {
  project: Project;
  session: SessionWithProvider;
  selectedSession: ProjectSession | null;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  isPinned: boolean;
  onTogglePin: (sessionId: string) => void;
  needsAttention?: boolean;
  t: TFunction;
};

const PROVIDER_LABELS: Record<LLMProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  azure: 'Azure',
};

type CopyState = 'loading' | 'idle' | 'copying' | 'copied' | 'error';


export default function SidebarSessionItem({
  project,
  session,
  selectedSession,
  currentTime,
  editingSession,
  editingSessionName,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  isPinned,
  onTogglePin,
  needsAttention = false,
  t,
}: SidebarSessionItemProps) {
  const sessionView = createSessionViewModel(session, currentTime, t);
  const isSelected = selectedSession?.id === session.id;
  const showAttentionIndicator = needsAttention && !isSelected;
  const isEditing = editingSession === session.id;
  const compactSessionAge = formatCompactAge(sessionView.sessionTime, currentTime);
  const editingContainerRef = useRef<HTMLDivElement>(null);
  const [isMobileOptionsOpen, setIsMobileOptionsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [providerSessionId, setProviderSessionId] = useState<string | null>(null);
  const providerIdRequestRef = useRef(0);
  const providerLabel = PROVIDER_LABELS[session.__provider] ?? session.__provider;

  // Mobile rename: long-press (>1s) opens a modal. Touch devices have no hover,
  // so the desktop group-hover pencil is unreachable — the long-press + modal is
  // the only rename affordance on phones.
  const LONG_PRESS_MS = 1000;
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  useEffect(() => clearLongPressTimer, []);

  const [isMobileViewport, setIsMobileViewport] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const update = () => setIsMobileViewport(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  // While editing, dismiss only when clicking outside the inline rename panel.
  useEffect(() => {
    if (!isEditing || isMobileOptionsOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const container = editingContainerRef.current;
      if (container && !container.contains(event.target as Node)) {
        onCancelEditingSession();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isEditing, isMobileOptionsOpen, onCancelEditingSession]);

  const selectMobileSession = () => {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    onProjectSelect(project);
    onSessionSelect(session, project.projectId);
  };

  const startLongPress = () => {
    longPressFiredRef.current = false;
    clearLongPressTimer();
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      onStartEditingSession(session.id, sessionView.sessionName);
    }, LONG_PRESS_MS);
  };

  const saveEditedSession = () => {
    onSaveEditingSession(project.projectId, session.id, editingSessionName, session.__provider);
  };

  const requestDeleteSession = () => {
    onDeleteSession(project.projectId, session.id, sessionView.sessionName, session.__provider);
  };

  // Dragging a session onto another project re-parents it. Renaming keeps the
  // caret in an input, so dragging stays off while the inline editor is open.
  const isDraggable = isSessionMovable(session.__provider) && !isEditing && !isMobileViewport;

  const handleDragStart = (event: DragEvent<HTMLDivElement>) => {
    if (!isDraggable || !event.dataTransfer) {
      return;
    }

    writeSessionDragPayload(event.dataTransfer, {
      sessionId: session.id,
      sessionTitle: sessionView.sessionName,
      sourceProjectId: project.projectId,
      provider: session.__provider,
    });
    setIsDragging(true);
  };

  const loadProviderSessionId = async () => {
    const requestId = ++providerIdRequestRef.current;
    setCopyState('loading');
    try {
      const response = await api.providerSessionId(session.id);
      const payload = await response.json();
      const loadedSessionId = payload?.data?.sessionId;
      if (!response.ok || typeof loadedSessionId !== 'string' || !loadedSessionId) {
        throw new Error('Provider session ID is unavailable');
      }

      if (requestId !== providerIdRequestRef.current) return;
      setProviderSessionId(loadedSessionId);
      setCopyState('idle');
    } catch {
      if (requestId !== providerIdRequestRef.current) return;
      setProviderSessionId(null);
      setCopyState('error');
    }
  };

  const resetCopyState = () => {
    providerIdRequestRef.current += 1;
    setCopyState('idle');
    setProviderSessionId(null);
  };

  const setOptionsOpen = (open: boolean) => {
    if (open) {
      setProviderSessionId(null);
      void loadProviderSessionId();
    } else {
      resetCopyState();
    }
  };

  const setMobileOptionsOpen = (open: boolean) => {
    setIsMobileOptionsOpen(open);
    setOptionsOpen(open);
    if (!open && isEditing) {
      onCancelEditingSession();
    }
  };

  const copyProviderSessionId = async () => {
    if (!providerSessionId) {
      setCopyState('error');
      return;
    }

    setCopyState('copying');
    const didCopy = await copyTextToClipboard(providerSessionId);
    setCopyState(didCopy ? 'copied' : 'error');
  };

  const handleCopyAction = () => {
    if (copyState === 'error' && !providerSessionId) {
      void loadProviderSessionId();
    } else {
      void copyProviderSessionId();
    }
  };

  const isCopyPending = copyState === 'loading' || copyState === 'copying';
  const CopyStateIcon = copyState === 'copied' ? Check : Copy;
  const copyLabel = copyState === 'loading'
    ? `Loading ${providerLabel} session ID…`
    : copyState === 'copied'
      ? `${providerLabel} session ID copied`
      : copyState === 'error'
        ? providerSessionId
          ? `Couldn't copy ${providerLabel} session ID`
          : `${providerLabel} session ID unavailable`
        : `Copy ${providerLabel} session ID`;

  return (
    <div
      className={cn('group relative', isDragging && 'opacity-40')}
      draggable={isDraggable}
      onDragStart={handleDragStart}
      onDragEnd={() => setIsDragging(false)}
    >
      {(showAttentionIndicator || sessionView.isActive) && (
        <div className="absolute left-0 top-1/2 -translate-x-1 -translate-y-1/2 transform">
          <Tooltip
            content={showAttentionIndicator
              ? t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })
              : t('tooltips.activeSessionIndicator')}
            position="right"
          >
            <div
              role="status"
              aria-label={showAttentionIndicator
                ? t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })
                : t('tooltips.activeSessionIndicator')}
              className={cn(
                'h-2 w-2 animate-pulse rounded-full',
                showAttentionIndicator ? 'bg-amber-500' : 'bg-green-500',
              )}
            />
          </Tooltip>
        </div>
      )}

      <div className="md:hidden">
        <div
          className={cn(
            'p-2 mx-3 my-0.5 rounded-md bg-card border active:scale-[0.98] transition-all duration-150 relative',
            isSelected ? 'bg-primary/5 border-primary/20' : '',
            !isSelected && sessionView.isActive
              ? 'border-green-500/30 bg-green-50/5 dark:bg-green-900/5'
              : 'border-border/30',
          )}
          onClick={selectMobileSession}
          onTouchStart={startLongPress}
          onTouchEnd={clearLongPressTimer}
          onTouchMove={clearLongPressTimer}
          onTouchCancel={clearLongPressTimer}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0',
                isSelected ? 'bg-primary/10' : 'bg-muted/50',
              )}
            >
              <SessionProviderLogo provider={session.__provider} className="h-3 w-3" />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className={cn("truncate text-xs font-medium", isPinned ? "text-amber-400" : "text-foreground")}>{sessionView.sessionName}</div>
                {compactSessionAge && (
                  <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">{compactSessionAge}</span>
                )}
              </div>
              <div className="mt-0.5 flex items-center">
                {sessionView.messageCount > 0 && (
                  <Badge variant="secondary" className="px-1 py-0 text-xs">
                    {sessionView.messageCount}
                  </Badge>
                )}
              </div>
            </div>

            <button
              className={cn(
                "ml-1 flex h-5 w-5 items-center justify-center rounded-md opacity-70 transition-transform active:scale-95",
                isPinned ? "bg-amber-50 dark:bg-amber-900/20" : "bg-gray-50 dark:bg-gray-900/20"
              )}
              onClick={(event) => {
                event.stopPropagation();
                onTogglePin(session.id);
              }}
            >
              {isPinned ? (
                <PinOff className="h-2.5 w-2.5 text-amber-600 dark:text-amber-400" />
              ) : (
                <Pin className="h-2.5 w-2.5 text-gray-600 dark:text-gray-400" />
              )}
            </button>
            <button
              className="ml-1 flex h-5 w-5 items-center justify-center rounded-md bg-gray-50 dark:bg-gray-900/20 opacity-70 transition-transform active:scale-95"
              onClick={(event) => {
                event.stopPropagation();
                setMobileOptionsOpen(true);
              }}
            >
              <MoreHorizontal className="h-2.5 w-2.5 text-gray-600 dark:text-gray-400" />
            </button>
          </div>
        </div>

        {/* Mobile rename modal */}
        <Dialog open={isEditing && isMobileViewport} onOpenChange={(open) => { if (!open) onCancelEditingSession(); }}>
          <DialogContent
            className="max-w-[calc(100vw-2rem)] p-4"
            onEscapeKeyDown={onCancelEditingSession}
            onPointerDownOutside={onCancelEditingSession}
          >
            <DialogTitle>{t('tooltips.editSessionName')}</DialogTitle>
            <p className="mb-2 text-sm font-medium text-foreground">{t('tooltips.editSessionName')}</p>
            <input
              type="text"
              value={editingSessionName}
              onChange={(event) => onEditingSessionNameChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  saveEditedSession();
                }
              }}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              autoFocus
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" onClick={onCancelEditingSession}>
                <X className="mr-1 h-4 w-4" />
                {t('tooltips.cancel')}
              </Button>
              <Button onClick={saveEditedSession}>
                <Check className="mr-1 h-4 w-4" />
                {t('tooltips.save')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* Mobile options bottom sheet */}
        <Dialog open={isMobileOptionsOpen && !isEditing} onOpenChange={(open) => { if (!open) setMobileOptionsOpen(false); }}>
          <DialogContent
            className="max-w-[calc(100vw-2rem)] p-4"
            onEscapeKeyDown={() => setMobileOptionsOpen(false)}
            onPointerDownOutside={() => setMobileOptionsOpen(false)}
          >
            <DialogTitle>{sessionView.sessionName}</DialogTitle>
            <div className="mt-2 flex flex-col gap-1">
              <button
                type="button"
                onClick={() => {
                  setMobileOptionsOpen(false);
                  onStartEditingSession(session.id, sessionView.sessionName);
                }}
                className="flex min-h-11 w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors active:bg-muted"
              >
                <Edit2 className="h-5 w-5 flex-shrink-0" />
                <span className="text-sm font-medium">Rename session</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  onTogglePin(session.id);
                  setMobileOptionsOpen(false);
                }}
                className="flex min-h-11 w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors active:bg-muted"
              >
                {isPinned ? <PinOff className="h-5 w-5 flex-shrink-0" /> : <Pin className="h-5 w-5 flex-shrink-0" />}
                <span className="text-sm font-medium">{isPinned ? 'Unpin session' : 'Pin to top'}</span>
              </button>

              <button
                type="button"
                disabled={isCopyPending}
                onClick={handleCopyAction}
                className={cn(
                  'flex min-h-11 w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors active:bg-muted',
                  isCopyPending && 'opacity-60',
                )}
              >
                {isCopyPending ? (
                  <Loader2 className="h-5 w-5 flex-shrink-0 animate-spin" />
                ) : (
                  <CopyStateIcon className="h-5 w-5 flex-shrink-0" />
                )}
                <span className="block text-sm font-medium">{copyLabel}</span>
              </button>

              {!sessionView.isCursorSession && (
                <button
                  type="button"
                  onClick={() => {
                    setMobileOptionsOpen(false);
                    requestDeleteSession();
                  }}
                  className="flex min-h-11 w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-red-600 transition-colors active:bg-red-500/10 dark:text-red-400"
                >
                  <Trash2 className="h-5 w-5 flex-shrink-0" />
                  <span className="text-sm font-medium">Archive or delete session</span>
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => setMobileOptionsOpen(false)}
              className="mb-1 mt-2 min-h-11 w-full rounded-xl text-sm font-medium text-muted-foreground transition-colors active:bg-muted"
            >
              Cancel
            </button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="hidden md:block">
        <a
          href={`/session/${session.id}`}
          className={cn(
            buttonVariants({ variant: 'ghost' }),
            'w-full justify-start p-2 h-auto font-normal text-left hover:bg-accent/50 transition-colors duration-200',
            isSelected && 'bg-accent text-accent-foreground',
          )}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onSessionSelect(session, project.projectId);
          }}
        >
          <div className="flex w-full min-w-0 items-start gap-2">
            <SessionProviderLogo provider={session.__provider} className="mt-0.5 h-3 w-3 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <div className={cn("truncate text-xs font-medium", isPinned ? "text-amber-400" : "text-foreground")}>{sessionView.sessionName}</div>
                {compactSessionAge && (
                  <span
                    className={cn(
                      'ml-auto flex-shrink-0 text-[11px] text-muted-foreground transition-opacity duration-200',
                      isEditing ? 'opacity-0' : 'group-hover:opacity-0',
                    )}
                  >
                    {compactSessionAge}
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex items-center">
                {sessionView.messageCount > 0 && <Badge variant="secondary" className="px-1 py-0 text-xs">{sessionView.messageCount}</Badge>}
              </div>
            </div>
          </div>
        </a>

        <div
          ref={editingContainerRef}
          className={cn(
            'absolute right-2 top-1/2 flex -translate-y-1/2 transform items-center gap-1 transition-all duration-200',
            isEditing ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        >
          {isEditing ? (
            <>
              <input
                type="text"
                value={editingSessionName}
                onChange={(event) => onEditingSessionNameChange(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') {
                    saveEditedSession();
                  } else if (event.key === 'Escape') {
                    onCancelEditingSession();
                  }
                }}
                onClick={(event) => event.stopPropagation()}
                className="w-32 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                autoFocus
              />
              <button
                className="flex h-6 w-6 items-center justify-center rounded bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/40"
                onClick={(event) => {
                  event.stopPropagation();
                  saveEditedSession();
                }}
                title={t('tooltips.save')}
              >
                <Check className="h-3 w-3 text-green-600 dark:text-green-400" />
              </button>
              <button
                className="flex h-6 w-6 items-center justify-center rounded bg-gray-50 hover:bg-gray-100 dark:bg-gray-900/20 dark:hover:bg-gray-900/40"
                onClick={(event) => {
                  event.stopPropagation();
                  onCancelEditingSession();
                }}
                title={t('tooltips.cancel')}
              >
                <X className="h-3 w-3 text-gray-600 dark:text-gray-400" />
              </button>
            </>
          ) : (
            <ActionMenu
              label="Session options"
              ariaLabel={`Session options for ${sessionView.sessionName}`}
              icon={MoreHorizontal}
              iconOnly
              portal
              variant="ghost"
              size="icon"
              onOpenChange={setOptionsOpen}
              triggerClassName="h-7 w-7 text-muted-foreground opacity-70 hover:bg-muted hover:opacity-100"
              menuClassName="w-[260px] rounded-xl p-1.5 shadow-xl"
              header={(
                <div className="mb-1 border-b border-border px-3 py-2">
                  <p className="truncate text-xs font-medium text-foreground" title={sessionView.sessionName}>
                    {sessionView.sessionName}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{providerLabel} session</p>
                </div>
              )}
              items={[
                {
                  key: 'rename',
                  label: 'Rename session',
                  icon: Edit2,
                  onSelect: () => onStartEditingSession(session.id, sessionView.sessionName),
                },
                {
                  key: 'pin',
                  label: isPinned ? 'Unpin session' : 'Pin to top',
                  icon: isPinned ? PinOff : Pin,
                  onSelect: () => onTogglePin(session.id),
                },
                {
                  key: 'copy',
                  label: copyLabel,
                  description: copyState === 'error' ? 'Click to try again.' : undefined,
                  icon: CopyStateIcon,
                  loading: isCopyPending,
                  closeOnSelect: false,
                  onSelect: handleCopyAction,
                },
                ...(!sessionView.isCursorSession ? [{
                  key: 'delete',
                  label: 'Archive or delete session',
                  icon: Trash2,
                  isDanger: true,
                  showDividerBefore: true,
                  onSelect: requestDeleteSession,
                }] : []),
              ]}
            />
          )}
        </div>
      </div>
    </div>
  );
}
