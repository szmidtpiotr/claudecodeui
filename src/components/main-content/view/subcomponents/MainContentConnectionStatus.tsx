import { WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useWebSocket } from '../../../../contexts/WebSocketContext';

/**
 * Rendered by MainContentHeader so that a lost chat connection is visible on
 * every tab: while the socket is down nothing typed into the chat can reach the
 * server. Shows nothing while connected or during the first handshake.
 */
export default function MainContentConnectionStatus() {
  const { t } = useTranslation();
  const { connectionStatus } = useWebSocket();
  const isDisconnected = connectionStatus === 'disconnected';
  // Names the chat connection, since the Shell tab shows its own socket's state.
  const description = t('status.chatConnectionLost');

  return (
    <>
      {/* Always mounted so screen readers announce the text when it appears. */}
      <div role="status" aria-live="polite" className="sr-only">
        {isDisconnected ? description : null}
      </div>
      {isDisconnected && (
        <span
          aria-hidden="true"
          title={description}
          className="inline-flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-300"
        >
          <WifiOff className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="sm:hidden xl:inline">{t('status.reconnecting')}</span>
        </span>
      )}
    </>
  );
}
