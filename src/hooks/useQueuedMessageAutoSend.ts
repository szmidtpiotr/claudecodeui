import { useEffect, useRef } from 'react';

import { clearQueuedMessage, readQueuedMessage } from '../components/chat/utils/chatStorage';

interface UseQueuedMessageAutoSendArgs {
  processingSessions: Set<string>;
  /**
   * The session currently open in the chat view. Its queued draft is owned by
   * the composer (which also handles image attachments and slash commands),
   * so this hook never touches it.
   */
  activeSessionId: string | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  markSessionAsProcessing: (sessionId: string) => void;
}

/**
 * Dispatches queued messages for sessions the user is NOT currently viewing.
 *
 * The composer persists each queued draft under `queued_message_<sessionId>`.
 * When a session's run leaves the processing set — its previous response
 * completed — this hook sends that session's queued message immediately
 * instead of waiting for the user to open the session again. Removing the
 * storage key before sending is the claim that keeps the composer's own
 * flush from double-sending.
 */
export function useQueuedMessageAutoSend({
  processingSessions,
  activeSessionId,
  ws,
  sendMessage,
  markSessionAsProcessing,
}: UseQueuedMessageAutoSendArgs) {
  const prevProcessingRef = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const prev = prevProcessingRef.current;
    const current = new Set(processingSessions);
    prevProcessingRef.current = current;

    for (const sessionId of prev) {
      if (current.has(sessionId) || sessionId === activeSessionId) {
        continue;
      }

      const queued = readQueuedMessage(sessionId);
      if (!queued) {
        continue;
      }

      // A closed socket would drop the send silently; keep the draft so the
      // composer (or a later completion) can retry once we're connected.
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        continue;
      }

      clearQueuedMessage(sessionId);
      sendMessage({
        type: 'chat.send',
        sessionId,
        content: queued.content,
        options: { ...(queued.options ?? {}), images: [] },
      });
      markSessionAsProcessing(sessionId);
    }
  }, [processingSessions, activeSessionId, ws, sendMessage, markSessionAsProcessing]);
}
