import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo } from 'react';
import type { CommitGraphRow } from '../../utils/commitGraph';
import { parseRefs } from '../../utils/commitGraph';
import type { GitCommitSummary } from '../../types/types';
import { getStatusBadgeClass, parseCommitFiles } from '../../utils/gitPanelUtils';
import GitDiffViewer from '../shared/GitDiffViewer';
import CommitGraphStrip from './CommitGraphStrip';

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

type CommitHistoryItemProps = {
  commit: GitCommitSummary;
  graphRow?: CommitGraphRow;
  isExpanded: boolean;
  diff?: string;
  isMobile: boolean;
  wrapText: boolean;
  onToggle: () => void;
};

export default function CommitHistoryItem({
  commit,
  graphRow,
  isExpanded,
  diff,
  isMobile,
  wrapText,
  onToggle,
}: CommitHistoryItemProps) {
  const fileSummary = useMemo(() => {
    if (!diff) return null;
    return parseCommitFiles(diff);
  }, [diff]);

  const { branches, tags, isHead } = useMemo(
    () => parseRefs(commit.refs ?? []),
    [commit.refs],
  );

  return (
    <div className="border-b border-border last:border-0">
      <button
        type="button"
        aria-expanded={isExpanded}
        className="flex w-full cursor-pointer items-stretch border-0 bg-transparent text-left transition-colors hover:bg-accent/50"
        onClick={onToggle}
      >
        {/* Graph strip */}
        {graphRow && (
          <CommitGraphStrip row={graphRow} />
        )}

        {/* Content */}
        <div className="flex min-w-0 flex-1 items-start gap-2 p-3">
          <span className="mt-1 rounded p-0.5 hover:bg-accent flex-shrink-0">
            {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </span>
          <div className="min-w-0 flex-1">
            {/* Ref badges */}
            {(branches.length > 0 || tags.length > 0) && (
              <div className="mb-1 flex flex-wrap gap-1">
                {isHead && branches.length === 0 && (
                  <span className="inline-flex items-center rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                    HEAD
                  </span>
                )}
                {branches.map((b) => (
                  <span
                    key={b}
                    className="inline-flex items-center rounded border border-blue-300 bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                  >
                    {b}
                  </span>
                ))}
                {tags.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center rounded border border-green-300 bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:border-green-700 dark:bg-green-900/30 dark:text-green-300"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}

            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{commit.message}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {commit.author}
                  {' • '}
                  {commit.stats || commit.date}
                </p>
              </div>
              <span className="flex-shrink-0 font-mono text-sm text-muted-foreground/60">
                {commit.hash.substring(0, 7)}
              </span>
            </div>
          </div>
        </div>
      </button>

      {isExpanded && diff && (
        <div className="bg-muted/50">
          <div className="max-h-[32rem] overflow-y-auto p-3">
            {/* Full hash */}
            <p className="mb-2 select-all font-mono text-xs text-muted-foreground/70">
              {commit.hash}
            </p>

            {/* Author + Date */}
            <div className="mb-3 flex gap-4 text-xs text-muted-foreground">
              <span>
                <span className="text-muted-foreground/60">Author </span>
                {commit.author}
              </span>
              <span>
                <span className="text-muted-foreground/60">Date </span>
                {formatDate(commit.date)}
              </span>
            </div>

            {/* Stats card */}
            {fileSummary && (
              <div className="mb-3 flex gap-4 rounded-md bg-muted/80 px-4 py-2 text-center text-xs">
                <div>
                  <div className="text-muted-foreground/60">Files</div>
                  <div className="font-semibold text-foreground">{fileSummary.totalFiles}</div>
                </div>
                <div>
                  <div className="text-muted-foreground/60">Added</div>
                  <div className="font-semibold text-green-600 dark:text-green-400">+{fileSummary.totalInsertions}</div>
                </div>
                <div>
                  <div className="text-muted-foreground/60">Removed</div>
                  <div className="font-semibold text-red-600 dark:text-red-400">-{fileSummary.totalDeletions}</div>
                </div>
              </div>
            )}

            {/* Changed files list */}
            {fileSummary && fileSummary.files.length > 0 && (
              <div className="mb-3">
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
                  Changed Files
                </p>
                <div className="rounded-md border border-border/60">
                  {fileSummary.files.map((file, idx) => (
                    <div
                      key={file.path}
                      className={`flex items-center gap-2 px-2.5 py-1.5 text-xs ${
                        idx < fileSummary.files.length - 1 ? 'border-b border-border/40' : ''
                      }`}
                    >
                      <span
                        className={`inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border text-[9px] font-bold ${getStatusBadgeClass(file.status)}`}
                      >
                        {file.status}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {file.directory && (
                          <span className="text-muted-foreground/60">{file.directory}</span>
                        )}
                        <span className="font-medium text-foreground">{file.filename}</span>
                      </span>
                      <span className="flex-shrink-0 font-mono text-muted-foreground/60">
                        {file.insertions > 0 && (
                          <span className="text-green-600 dark:text-green-400">+{file.insertions}</span>
                        )}
                        {file.insertions > 0 && file.deletions > 0 && '/'}
                        {file.deletions > 0 && (
                          <span className="text-red-600 dark:text-red-400">-{file.deletions}</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Diff viewer */}
            <GitDiffViewer diff={diff} isMobile={isMobile} wrapText={wrapText} />
          </div>
        </div>
      )}
    </div>
  );
}
