import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, ExternalLink, GitBranch } from 'lucide-react';

import { Markdown } from './Markdown';

type DerivedReportMessageProps = {
  /** Already-translated header, e.g. "Message from derived session “X”". */
  label: string;
  body: string;
  /** The other session (child for reports/messages, parent for parent messages). */
  sessionId: string;
  isError?: boolean;
  formattedTime: string;
  projectId?: string;
  onOpenSession?: (sessionId: string) => void;
};

/**
 * A message between a parent and a derived session, delivered as a user-role
 * message: a child's turn-end report, a child's explicit message to its
 * parent, or a parent's message to a child. Shown as a message from that
 * session, not as something the user typed, with a link that opens it.
 */
export default function DerivedReportMessage({
  label,
  body,
  sessionId,
  isError = false,
  formattedTime,
  projectId,
  onOpenSession,
}: DerivedReportMessageProps) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="w-full">
      <div
        className={`rounded-lg border px-3 py-2 ${isError
          ? 'border-red-300/60 bg-red-50/60 dark:border-red-800/60 dark:bg-red-950/20'
          : 'border-violet-300/60 bg-violet-50/60 dark:border-violet-800/60 dark:bg-violet-950/20'}`}
      >
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
            aria-label={expanded ? t('derivedReport.collapse') : t('derivedReport.expand')}
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <GitBranch className="h-3.5 w-3.5" />
          </button>
          <span className="font-medium text-foreground">{label}</span>
          {onOpenSession && (
            <button
              type="button"
              onClick={() => onOpenSession(sessionId)}
              className="inline-flex items-center gap-1 text-violet-700 underline-offset-2 hover:underline dark:text-violet-300"
              title={sessionId}
            >
              <ExternalLink className="h-3 w-3" />
              {t('derivedReport.open')}
            </button>
          )}
          <span className="ml-auto text-muted-foreground">{formattedTime}</span>
        </div>
        {expanded && body.trim() && (
          <div className="mt-2 text-sm">
            <Markdown projectId={projectId} className="prose prose-sm prose-gray max-w-none dark:prose-invert">
              {body}
            </Markdown>
          </div>
        )}
      </div>
    </div>
  );
}
