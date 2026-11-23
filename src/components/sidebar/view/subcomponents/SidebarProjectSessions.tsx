import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ancestorIdsInTree, buildSessionTree, hideCollapsedRows } from '../../../../../shared/sessionTree';

import { Button } from '../../../../shared/view/ui';
import type { Project, ProjectSession, LLMProvider } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';

import SidebarSessionItem from './SidebarSessionItem';

type SidebarProjectSessionsProps = {
  project: Project;
  isExpanded: boolean;
  sessions: SessionWithProvider[];
  selectedSession: ProjectSession | null;
  initialSessionsLoaded: boolean;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
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
  /** Archives the session straight away; it stays restorable from the archive. */
  onArchiveSession: (sessionId: string) => void;
  onLoadMoreSessions: (projectId: string) => void;
  onNewSession: (project: Project) => void;
  pinnedSessionIds: Set<string>;
  onTogglePin: (sessionId: string) => void;
  attentionSessionIds?: Set<string>;
  t: TFunction;
};

const FORK_INDENT_PX = 12;
const MAX_FORK_INDENT_DEPTH = 4;
const COLLAPSED_FORKS_STORAGE_KEY = 'sidebar-collapsed-forks';

function readCollapsedForks(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_FORKS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeCollapsedForks(ids: Set<string>): void {
  try {
    // Bounded so ids of long-gone sessions cannot grow the entry forever.
    localStorage.setItem(COLLAPSED_FORKS_STORAGE_KEY, JSON.stringify([...ids].slice(-500)));
  } catch {
    // Storage unavailable (private mode): collapse state just is not kept.
  }
}

function SessionListSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="rounded-md p-2">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 h-3 w-3 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-1">
              <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${60 + index * 15}%` }} />
              <div className="h-2 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

export default function SidebarProjectSessions({
  project,
  isExpanded,
  sessions,
  selectedSession,
  initialSessionsLoaded,
  hasMoreSessions,
  isLoadingMoreSessions,
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
  onArchiveSession,
  onLoadMoreSessions,
  onNewSession,
  pinnedSessionIds,
  onTogglePin,
  attentionSessionIds,
  t,
}: SidebarProjectSessionsProps) {
  const sortedSessions = useMemo(() => [...sessions].sort((a, b) => {
    const aPinned = pinnedSessionIds.has(a.id);
    const bPinned = pinnedSessionIds.has(b.id);
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    const aTime = a.lastActivity || a.updated_at || a.createdAt || a.created_at || '';
    const bTime = b.lastActivity || b.updated_at || b.createdAt || b.created_at || '';
    return bTime.localeCompare(aTime);
  }), [sessions, pinnedSessionIds]);

  // Derived (forked) sessions nest under their parent within the project.
  const treeRows = useMemo(
    () => buildSessionTree(
      sortedSessions.map((session) => ({
        ...session,
        parentSessionId: typeof session.parentSessionId === 'string' ? session.parentSessionId : null,
      })),
      pinnedSessionIds,
    ),
    [sortedSessions, pinnedSessionIds],
  );

  const [collapsedForks, setCollapsedForks] = useState<Set<string>>(readCollapsedForks);
  const selectedSessionId = selectedSession?.id ?? null;
  const selectedAncestors = useMemo(() => ancestorIdsInTree(treeRows, selectedSessionId), [treeRows, selectedSessionId]);

  // Opening a derived session reveals it even if its branch was collapsed.
  useEffect(() => {
    if (![...selectedAncestors].some((id) => collapsedForks.has(id))) return;
    setCollapsedForks((previous) => {
      const next = new Set([...previous].filter((id) => !selectedAncestors.has(id)));
      writeCollapsedForks(next);
      return next;
    });
  }, [selectedAncestors, collapsedForks]);

  const toggleForkBranch = (sessionId: string) => {
    setCollapsedForks((previous) => {
      const next = new Set(previous);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      writeCollapsedForks(next);
      return next;
    });
  };

  const visibleRows = useMemo(() => hideCollapsedRows(treeRows, collapsedForks), [treeRows, collapsedForks]);
  const hasForks = treeRows.some((row) => row.hasChildren);

  if (!isExpanded) {
    return null;
  }

  const hasSessions = sessions.length > 0;

  return (
    <div className="ml-3 space-y-1 border-l border-border pl-3">
      <div className="px-3 pb-1 pt-1 md:hidden">
        <button
          className="flex h-8 w-full items-center justify-center gap-2 rounded-md bg-primary text-xs font-medium text-primary-foreground transition-all duration-150 hover:bg-primary/90 active:scale-[0.98]"
          onClick={() => {
            onProjectSelect(project);
            onNewSession(project);
          }}
        >
          <Plus className="h-3 w-3" />
          {t('sessions.newSession')}
        </button>
      </div>

      <Button
        variant="default"
        size="sm"
        className="hidden h-8 w-full justify-start gap-2 bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 md:flex"
        onClick={() => onNewSession(project)}
      >
        <Plus className="h-3 w-3" />
        {t('sessions.newSession')}
      </Button>

      {!initialSessionsLoaded ? (
        <SessionListSkeleton />
      ) : !hasSessions ? (
        <div className="px-3 py-2 text-left">
          <p className="text-xs text-muted-foreground">{t('sessions.noSessions')}</p>
        </div>
      ) : (
        <>
          {visibleRows.map(({ session: treeSession, parentId, depth, hasChildren, isLastSibling, continuationDepths }) => {
            const session = treeSession as SessionWithProvider;
            const indentDepth = Math.min(depth, MAX_FORK_INDENT_DEPTH);
            const isCollapsed = collapsedForks.has(session.id);
            const sessionLabel = String(session.summary || session.name || session.title || t('sessions.unnamed'));
            return (
              <div
                key={session.id}
                data-session-id={session.id}
                data-parent-session-id={parentId ?? undefined}
                className="relative flex min-w-0 items-stretch"
                style={depth > 0 ? { paddingLeft: `${indentDepth * FORK_INDENT_PX}px` } : undefined}
              >
                {parentId && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0"
                    style={{ left: `${(indentDepth - 1) * FORK_INDENT_PX + FORK_INDENT_PX / 2}px`, width: `${FORK_INDENT_PX}px` }}
                  >
                    <span className={`absolute left-0 top-0 border-l border-muted-foreground/40 ${isLastSibling ? 'bottom-1/2' : 'bottom-0'}`} />
                    <span className="absolute left-0 top-1/2 border-t border-muted-foreground/40" style={{ width: hasChildren ? '6px' : '10px' }} />
                  </span>
                )}
                {continuationDepths.filter((ancestorDepth) => ancestorDepth <= MAX_FORK_INDENT_DEPTH).map((ancestorDepth) => (
                  <span
                    key={ancestorDepth}
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 border-l border-muted-foreground/40"
                    style={{ left: `${(ancestorDepth - 1) * FORK_INDENT_PX + FORK_INDENT_PX / 2}px` }}
                  />
                ))}
                {hasForks && (
                  hasChildren ? (
                    <button
                      type="button"
                      className="relative flex w-3 flex-shrink-0 items-center justify-center rounded text-foreground/60 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-expanded={!isCollapsed}
                      title={isCollapsed ? t('sessions.expandForks') : t('sessions.collapseForks')}
                      aria-label={isCollapsed
                        ? t('sessions.expandForksFor', { session: sessionLabel })
                        : t('sessions.collapseForksFor', { session: sessionLabel })}
                      onClick={() => toggleForkBranch(session.id)}
                    >
                      <ChevronRight className={`h-3 w-3 transition-transform ${isCollapsed ? '' : 'rotate-90'}`} strokeWidth={2.5} aria-hidden="true" />
                    </button>
                  ) : <span className="w-3 flex-shrink-0" aria-hidden="true" />
                )}
                {session.derivedRunning && (
                  <span
                    role="status"
                    aria-label={t('sessions.derivedRunning')}
                    title={t('sessions.derivedRunning')}
                    className="pointer-events-none absolute right-1 top-1 z-10 h-2 w-2 animate-pulse rounded-full bg-violet-500"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <SidebarSessionItem
                    project={project}
                    session={session}
                    selectedSession={selectedSession}
                    currentTime={currentTime}
                    editingSession={editingSession}
                    editingSessionName={editingSessionName}
                    onEditingSessionNameChange={onEditingSessionNameChange}
                    onStartEditingSession={onStartEditingSession}
                    onCancelEditingSession={onCancelEditingSession}
                    onSaveEditingSession={onSaveEditingSession}
                    onProjectSelect={onProjectSelect}
                    onSessionSelect={onSessionSelect}
                    onDeleteSession={onDeleteSession}
                    onArchiveSession={onArchiveSession}
                    isPinned={pinnedSessionIds.has(session.id)}
                    onTogglePin={onTogglePin}
                    needsAttention={attentionSessionIds?.has(session.id) ?? false}
                    t={t}
                  />
                </div>
              </div>
            );
          })}

          {hasMoreSessions && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-center text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onLoadMoreSessions(project.projectId)}
              disabled={isLoadingMoreSessions}
            >
              {isLoadingMoreSessions ? t('sessions.loadingSessions') : 'Load more sessions'}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
