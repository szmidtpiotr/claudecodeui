import { ChevronDown, ChevronRight, Loader2, Minus, Plus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { TFunction } from 'i18next';

import { cn } from '../../../../lib/utils';
import type { LLMProvider, Project, ProjectSession } from '../../../../types/app';
import { formatCompactAge } from '../../utils/utils';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';

export type RecentSessionEntry = {
  sessionId: string;
  sessionName: string;
  projectId: string;
  projectName: string;
  lastActivity: string;
  provider: LLMProvider;
  isRunning: boolean;
};

type SidebarRecentSessionsProps = {
  projects: Project[];
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  selectedSession: ProjectSession | null;
  currentTime: Date;
  onSessionClick: (entry: RecentSessionEntry) => void;
  t: TFunction;
};

const COUNT_KEY = 'sidebar-recent-sessions-count';
const COLLAPSED_KEY = 'sidebar-recent-sessions-collapsed';
const HIDDEN_KEY = 'sidebar-recent-sessions-hidden';
// Hidden marks older than this are dropped so the stored map stays small.
const HIDDEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_COUNT = 5;
const MIN_COUNT = 1;
const MAX_COUNT = 20;

function readCount(): number {
  try {
    const value = Number(localStorage.getItem(COUNT_KEY));
    if (Number.isInteger(value) && value >= MIN_COUNT && value <= MAX_COUNT) return value;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_COUNT;
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

/** sessionId → time it was hidden from the section (ms). */
function readHidden(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const cutoff = Date.now() - HIDDEN_MAX_AGE_MS;
    const result: Record<string, number> = {};
    for (const [id, at] of Object.entries(parsed)) {
      if (typeof at === 'number' && at > cutoff) result[id] = at;
    }
    return result;
  } catch {
    return {};
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

const PROVIDER_LISTS: Array<[keyof Project, LLMProvider]> = [
  ['sessions', 'claude'],
  ['cursorSessions', 'cursor'],
  ['codexSessions', 'codex'],
  ['geminiSessions', 'gemini' as LLMProvider],
  ['opencodeSessions', 'opencode'],
];

function sessionTitle(session: ProjectSession): string {
  for (const candidate of [session.summary, session.name, session.title]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }
  return '';
}

/**
 * Every loaded session across all projects, newest first. Projects load their
 * most recent sessions first, so the top of this list is complete even when a
 * project's older sessions are not loaded yet.
 */
function collectSessions(projects: Project[], runningSessionIds: Set<string>): RecentSessionEntry[] {
  const entries: RecentSessionEntry[] = [];
  const seen = new Set<string>();

  for (const project of projects) {
    for (const [key, provider] of PROVIDER_LISTS) {
      const list = project[key];
      if (!Array.isArray(list)) continue;
      for (const session of list as ProjectSession[]) {
        if (!session?.id || seen.has(session.id)) continue;
        const lastActivity = session.lastActivity || session.updated_at || session.createdAt || session.created_at;
        if (!lastActivity || Number.isNaN(new Date(lastActivity).getTime())) continue;
        seen.add(session.id);
        entries.push({
          sessionId: session.id,
          sessionName: sessionTitle(session),
          projectId: project.projectId,
          projectName: project.displayName || project.path?.split('/').pop() || 'Project',
          lastActivity,
          provider,
          isRunning: runningSessionIds.has(session.id) || session.derivedRunning === true,
        });
      }
    }
  }

  entries.sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
  return entries;
}

export default function SidebarRecentSessions({
  projects,
  runningSessionIds,
  unreadSessionIds,
  selectedSession,
  currentTime,
  onSessionClick,
  t,
}: SidebarRecentSessionsProps) {
  const [count, setCount] = useState(readCount);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [hidden, setHidden] = useState(readHidden);

  const visible = useMemo(() => {
    // A hidden session comes back on its own once it runs or gets new
    // activity after it was hidden, so hiding never loses track of new work.
    const all = collectSessions(projects, runningSessionIds).filter((entry) => {
      const hiddenAt = hidden[entry.sessionId];
      return hiddenAt === undefined || entry.isRunning || new Date(entry.lastActivity).getTime() > hiddenAt;
    });
    // Running sessions always show (on top); the rest fill up to `count`.
    const running = all.filter((entry) => entry.isRunning);
    const rest = all.filter((entry) => !entry.isRunning);
    return [...running, ...rest.slice(0, Math.max(0, count - running.length))];
  }, [projects, runningSessionIds, count, hidden]);

  const hideSession = (sessionId: string) => {
    setHidden((previous) => {
      const next = { ...previous, [sessionId]: Date.now() };
      persist(HIDDEN_KEY, JSON.stringify(next));
      return next;
    });
  };

  const changeCount = (delta: number) => {
    setCount((previous) => {
      const next = Math.min(MAX_COUNT, Math.max(MIN_COUNT, previous + delta));
      persist(COUNT_KEY, String(next));
      return next;
    });
  };

  const toggleCollapsed = () => {
    setCollapsed((previous) => {
      persist(COLLAPSED_KEY, String(!previous));
      return !previous;
    });
  };

  const runningCount = visible.filter((entry) => entry.isRunning).length;

  return (
    <div className="mb-1 border-b border-border/60 px-2 pb-2 pt-1">
      <div className="flex items-center gap-1 px-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 py-1 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight className="h-3 w-3 flex-shrink-0" /> : <ChevronDown className="h-3 w-3 flex-shrink-0" />}
          <span className="truncate">{t('recentSessions.title', 'Recent sessions')}</span>
          {runningCount > 0 && (
            <span className="ml-1 flex items-center gap-0.5 normal-case tracking-normal text-blue-500">
              <Loader2 className="h-3 w-3 animate-spin" />
              {runningCount}
            </span>
          )}
        </button>
        <div className="flex flex-shrink-0 items-center rounded-md border border-border/60">
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30"
            onClick={() => changeCount(-1)}
            disabled={count <= MIN_COUNT}
            title={t('recentSessions.showFewer', 'Show fewer')}
          >
            <Minus className="h-3 w-3" />
          </button>
          <span className="min-w-5 text-center text-xs tabular-nums text-foreground">{count}</span>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30"
            onClick={() => changeCount(1)}
            disabled={count >= MAX_COUNT}
            title={t('recentSessions.showMore', 'Show more')}
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
      </div>

      {!collapsed &&
        (visible.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">{t('recentSessions.empty', 'No sessions yet.')}</p>
        ) : (
          <div className="mt-1 space-y-0.5">
            {visible.map((entry) => {
              const isSelected = selectedSession?.id === entry.sessionId;
              const isUnread = !isSelected && unreadSessionIds.has(entry.sessionId);
              return (
                <div
                  key={entry.sessionId}
                  className={cn(
                    'group flex items-center rounded-lg transition-colors',
                    isSelected ? 'bg-primary/10 text-foreground' : 'hover:bg-accent/50',
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                    onClick={() => onSessionClick(entry)}
                    title={`${entry.projectName} — ${entry.sessionName || t('projects.newSession')}`}
                  >
                    <div className="relative flex h-5 w-5 flex-shrink-0 items-center justify-center">
                      {entry.isRunning ? (
                        <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                      ) : (
                        <SessionProviderLogo provider={entry.provider} className="h-4 w-4" />
                      )}
                      {isUnread && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-blue-500" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className={cn('truncate text-sm', isUnread ? 'font-semibold' : 'font-medium')}>
                        {entry.sessionName || t('projects.newSession')}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">{entry.projectName}</div>
                    </div>
                    <span className="flex-shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {entry.isRunning
                        ? t('recentSessions.running', 'working')
                        : formatCompactAge(entry.lastActivity, currentTime)}
                    </span>
                  </button>
                  {!entry.isRunning && (
                    <button
                      type="button"
                      className="mr-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-opacity hover:bg-accent hover:text-foreground md:opacity-0 md:focus:opacity-100 md:group-hover:opacity-100"
                      onClick={() => hideSession(entry.sessionId)}
                      title={t('recentSessions.hide', 'Remove from recent sessions (comes back when there is new activity)')}
                      aria-label={t('recentSessions.hide', 'Remove from recent sessions (comes back when there is new activity)')}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
    </div>
  );
}
