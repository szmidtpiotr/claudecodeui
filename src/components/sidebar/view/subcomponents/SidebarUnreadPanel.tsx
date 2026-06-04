import { Bell, Pin, PinOff } from 'lucide-react';
import type { TFunction } from 'i18next';
import { cn } from '../../../../lib/utils';
import type { UnreadSessionEntry } from '../../../../hooks/useUnreadSessions';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';

type SidebarUnreadPanelProps = {
  entries: UnreadSessionEntry[];
  onSessionClick: (entry: UnreadSessionEntry) => void;
  onTogglePin: (sessionId: string) => void;
  t: TFunction;
};

function formatRelativeAge(dateString: string): string {
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return '';
  const diffMs = Math.max(0, Date.now() - date.getTime());
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  if (diffMinutes < 1) return '<1m';
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}hr`;
  return `${Math.floor(diffHours / 24)}d`;
}

export default function SidebarUnreadPanel({
  entries,
  onSessionClick,
  onTogglePin,
  t,
}: SidebarUnreadPanelProps) {
  if (entries.length === 0) {
    return (
      <div className="px-4 py-12 text-center md:py-8">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
          <Bell className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">
          {t('unread.emptyTitle', 'All caught up')}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t('unread.emptyDescription', 'No unread sessions in the last 7 days.')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1 px-2 py-1">
      <div className="flex items-center justify-between px-1 py-1">
        <p className="text-xs text-muted-foreground">
          {`${entries.length} ${entries.length === 1
            ? t('unread.sessionCountOne', 'unread session')
            : t('unread.sessionCountOther', 'unread sessions')}`}
        </p>
      </div>
      {entries.map((entry) => (
        <div
          key={entry.sessionId}
          className="group flex items-center gap-1 rounded-lg transition-colors hover:bg-accent/40"
        >
          {/* Pin button */}
          <button
            className={cn(
              "flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md transition-colors",
              entry.pinned
                ? "text-amber-500 hover:text-amber-600"
                : "text-muted-foreground/40 opacity-0 group-hover:opacity-100 hover:text-muted-foreground"
            )}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin(entry.sessionId);
            }}
            title={entry.pinned ? t('unread.unpin', 'Unpin session') : t('unread.pin', 'Pin session')}
          >
            {entry.pinned ? (
              <PinOff className="h-3 w-3" />
            ) : (
              <Pin className="h-3 w-3" />
            )}
          </button>

          {/* Session info button */}
          <button
            className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-2 text-left"
            onClick={() => onSessionClick(entry)}
          >
            <SessionProviderLogo provider={entry.provider} className="h-3.5 w-3.5 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <span className="truncate text-xs font-medium text-foreground">
                  {entry.sessionName}
                </span>
                <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">
                  {formatRelativeAge(entry.lastActivity)}
                </span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
                {entry.projectName}
              </p>
            </div>
          </button>
        </div>
      ))}
    </div>
  );
}
