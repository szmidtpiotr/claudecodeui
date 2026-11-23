import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, ListTodo, Sparkles } from 'lucide-react';

import type { DerivedSessionTask } from '../../../../../shared/derivedSessionReport';

import { Markdown } from './Markdown';

/** Tasks longer than this start collapsed. */
const COLLAPSE_AFTER_CHARS = 600;
const COLLAPSE_AFTER_LINES = 12;

type DerivedTaskMessageProps = {
  task: DerivedSessionTask;
  /** The technical header the prompt starts with, shown under "Context". */
  context: string;
  /** Title of the derived session itself (the open session). */
  sessionTitle?: string | null;
  /** Parent title when the prompt did not carry one (looked up in the project). */
  fallbackParentTitle?: string | null;
  formattedTime: string;
  projectId?: string;
  onOpenSession?: (sessionId: string) => void;
};

/**
 * The first prompt of a derived session the agent started, shown like the
 * Claude desktop app does: "Started by Claude from <parent>" and a "Task"
 * card with the instruction; the technical header is tucked under "Context".
 */
export default function DerivedTaskMessage({
  task,
  context,
  sessionTitle,
  fallbackParentTitle,
  formattedTime,
  projectId,
  onOpenSession,
}: DerivedTaskMessageProps) {
  const { t } = useTranslation('chat');
  const isLong = task.task.length > COLLAPSE_AFTER_CHARS || task.task.split('\n').length > COLLAPSE_AFTER_LINES;
  const [expanded, setExpanded] = useState(!isLong);
  const [showContext, setShowContext] = useState(false);
  const parentTitle = task.parentTitle || fallbackParentTitle || t('derivedTask.parentFallback');

  return (
    <div className="w-full space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5" />
        <span>{t('derivedTask.startedBy')}</span>
        {onOpenSession ? (
          <button
            type="button"
            onClick={() => onOpenSession(task.parentSessionId)}
            className="font-medium text-violet-700 underline-offset-2 hover:underline dark:text-violet-300"
            title={task.parentSessionId}
          >
            {parentTitle}
          </button>
        ) : (
          <span className="font-medium text-foreground">{parentTitle}</span>
        )}
        <span className="ml-auto">{formattedTime}</span>
      </div>

      <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center gap-2 text-left text-xs"
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          <ListTodo className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium text-muted-foreground">{t('derivedTask.task')}</span>
          {sessionTitle && <span className="truncate font-medium text-foreground">{sessionTitle}</span>}
        </button>
        {expanded ? (
          task.task && (
            <div className="mt-2 text-sm">
              <Markdown projectId={projectId} className="prose prose-sm prose-gray max-w-none dark:prose-invert">
                {task.task}
              </Markdown>
            </div>
          )
        ) : (
          <div className="mt-1 line-clamp-2 text-sm text-muted-foreground">{task.task}</div>
        )}
        {context && (
          <div className="mt-2 border-t border-border/60 pt-1.5">
            <button
              type="button"
              onClick={() => setShowContext((value) => !value)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              aria-expanded={showContext}
            >
              {showContext ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {t('derivedTask.context')}
            </button>
            {showContext && (
              <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{context}</pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
