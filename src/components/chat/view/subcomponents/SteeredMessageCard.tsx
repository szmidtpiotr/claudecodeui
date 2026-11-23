import { useTranslation } from 'react-i18next';
import { CornerDownRightIcon } from 'lucide-react';

import type { PendingSteer } from '../../hooks/useSteeredMessages';

interface SteeredMessageCardProps {
  steers: PendingSteer[];
}

/**
 * Messages sent into the running Claude turn that Claude has not read yet.
 * Each leaves this card when the CLI echoes it; the echo is the bubble that
 * then appears in the transcript, at the point Claude read it.
 */
export default function SteeredMessageCard({ steers }: SteeredMessageCardProps) {
  const { t } = useTranslation('chat');
  if (steers.length === 0) {
    return null;
  }

  return (
    <div className="settings-content-enter mx-auto mb-2 max-w-[54.25rem] rounded-xl border border-dashed border-blue-400/40 bg-blue-500/[0.05] px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-blue-700/80 dark:text-blue-300/80">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-blue-500/70" aria-hidden />
        <span>{t('input.steer.label', { defaultValue: 'Sent to Claude' })}</span>
        <span className="normal-case text-muted-foreground/70">
          · {t('input.steer.waiting', { defaultValue: 'it reads this at its next step' })}
        </span>
      </div>
      <ul className="mt-1 space-y-1">
        {steers.map((steer) => (
          <li key={steer.messageId} className="flex items-start gap-1.5">
            <CornerDownRightIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500/60" aria-hidden />
            <p className="line-clamp-3 min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-foreground/90">
              {steer.content}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
