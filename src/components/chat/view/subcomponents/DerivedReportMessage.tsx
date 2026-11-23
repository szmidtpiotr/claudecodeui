import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, ExternalLink, GitBranch } from 'lucide-react';

import type { DerivedSessionReport } from '../../../../../shared/derivedSessionReport';

import { Markdown } from './Markdown';

type DerivedReportMessageProps = {
  report: DerivedSessionReport;
  formattedTime: string;
  projectId?: string;
  onOpenSession?: (sessionId: string) => void;
};

/**
 * A derived session's report, delivered into its parent as a user-role
 * message. Shown as a message from that session, not as something the user
 * typed, with a link that opens the derived session.
 */
export default function DerivedReportMessage({ report, formattedTime, projectId, onOpenSession }: DerivedReportMessageProps) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(true);
  const isError = report.status === 'error';

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
          <span className="font-medium text-foreground">
            {t(isError ? 'derivedReport.headerError' : 'derivedReport.header', { title: report.childTitle })}
          </span>
          {onOpenSession && (
            <button
              type="button"
              onClick={() => onOpenSession(report.childSessionId)}
              className="inline-flex items-center gap-1 text-violet-700 underline-offset-2 hover:underline dark:text-violet-300"
              title={report.childSessionId}
            >
              <ExternalLink className="h-3 w-3" />
              {t('derivedReport.open')}
            </button>
          )}
          <span className="ml-auto text-muted-foreground">{formattedTime}</span>
        </div>
        {expanded && report.body.trim() && (
          <div className="mt-2 text-sm">
            <Markdown projectId={projectId} className="prose prose-sm prose-gray max-w-none dark:prose-invert">
              {report.body}
            </Markdown>
          </div>
        )}
      </div>
    </div>
  );
}
