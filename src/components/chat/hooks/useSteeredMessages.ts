import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Messages "steered" into a running Claude turn: sent while the agent works,
 * written into the running CLI, and read by Claude at its next tool call
 * without the run stopping.
 *
 * A steered message is not drawn as a chat bubble when it is sent. It waits in
 * a pending card above the composer until the CLI echoes it — the moment Claude
 * actually read it — and that echo is what lands in the transcript, at that
 * point. The server reports each step as a `steer-status` frame:
 *
 * - `pending`   the running turn has it (sent to every tab watching the run)
 * - `delivered` Claude read it; the echo bubble arrives alongside
 * - `rejected`  the turn had already ended; this tab sends it as the next turn
 * - `dropped`   the run ended without reading it (stopped, failed, or the CLI
 *               never picked it up); this tab gets the text back
 *
 * A tab that opens mid-run learns the pending ones from `session-status`.
 */

export type PendingSteer = {
  messageId: string;
  content: string;
};

type SteerFrame = {
  type?: string;
  kind?: string;
  role?: string;
  id?: string;
  state?: string;
  reason?: string;
  sessionId?: string;
  messageId?: string;
  content?: string;
  pendingSteers?: unknown;
  isProcessing?: boolean;
  [key: string]: unknown;
};

type UseSteeredMessagesArgs = {
  latestMessage: SteerFrame | null;
  sessionId: string | null;
  sendMessage: (message: unknown) => void;
  /** The turn was already over: send the text as the next turn instead. */
  onRejected: (content: string) => void;
  /** The run ended without Claude reading it: give the text back. */
  onDropped: (content: string, reason: string) => void;
};

// Ids of messages this tab sent, kept per tab so a reload still knows which
// pending messages to hand back if the run is stopped.
const OWN_STEERS_KEY = 'steeredMessageIds';
const MAX_OWN_STEERS = 50;

function readOwnSteerIds(): string[] {
  try {
    const raw = sessionStorage.getItem(OWN_STEERS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeOwnSteerIds(ids: string[]) {
  try {
    sessionStorage.setItem(OWN_STEERS_KEY, JSON.stringify(ids.slice(-MAX_OWN_STEERS)));
  } catch {
    // Storage full or blocked: only the reload case loses its hand-back.
  }
}

/**
 * RFC 4122 v4 UUID. `crypto.randomUUID` exists only in secure contexts, and the
 * app is often opened over plain http on the LAN (phone PWA), where
 * `getRandomValues` still works.
 */
export function createSteerMessageId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    try {
      return cryptoApi.randomUUID();
    } catch {
      // Insecure context: fall through.
    }
  }
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readPendingList(value: unknown): PendingSteer[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is PendingSteer =>
      Boolean(entry)
      && typeof entry.messageId === 'string'
      && typeof entry.content === 'string')
    .map(({ messageId, content }) => ({ messageId, content }));
}

export function useSteeredMessages({
  latestMessage,
  sessionId,
  sendMessage,
  onRejected,
  onDropped,
}: UseSteeredMessagesArgs) {
  const [pendingSteers, setPendingSteers] = useState<PendingSteer[]>([]);
  const ownIdsRef = useRef<Set<string>>(new Set(readOwnSteerIds()));
  const onRejectedRef = useRef(onRejected);
  const onDroppedRef = useRef(onDropped);
  onRejectedRef.current = onRejected;
  onDroppedRef.current = onDropped;
  const lastFrameRef = useRef<SteerFrame | null>(null);

  // Pending messages belong to one session's run.
  useEffect(() => {
    setPendingSteers([]);
  }, [sessionId]);

  const forgetOwn = useCallback((messageId: string) => {
    if (ownIdsRef.current.delete(messageId)) {
      writeOwnSteerIds([...ownIdsRef.current]);
    }
  }, []);

  const removePending = useCallback((messageId: string) => {
    setPendingSteers((previous) => (
      previous.some((entry) => entry.messageId === messageId)
        ? previous.filter((entry) => entry.messageId !== messageId)
        : previous
    ));
  }, []);

  useEffect(() => {
    const frame = latestMessage;
    if (!frame || frame === lastFrameRef.current) {
      return;
    }
    lastFrameRef.current = frame;
    if (!sessionId || (frame.sessionId && frame.sessionId !== sessionId)) {
      return;
    }

    if (frame.type === 'steer-status' && typeof frame.messageId === 'string') {
      const messageId = frame.messageId;
      const content = typeof frame.content === 'string' ? frame.content : '';
      switch (frame.state) {
        case 'pending':
          setPendingSteers((previous) => (
            previous.some((entry) => entry.messageId === messageId)
              ? previous
              : [...previous, { messageId, content }]
          ));
          return;
        case 'delivered':
          removePending(messageId);
          forgetOwn(messageId);
          return;
        case 'rejected':
          removePending(messageId);
          if (ownIdsRef.current.has(messageId)) {
            forgetOwn(messageId);
            if (content) {
              onRejectedRef.current(content);
            }
          }
          return;
        case 'dropped':
          removePending(messageId);
          if (ownIdsRef.current.has(messageId)) {
            forgetOwn(messageId);
            if (content) {
              onDroppedRef.current(content, typeof frame.reason === 'string' ? frame.reason : '');
            }
          }
          return;
        default:
          return;
      }
    }

    // The echo itself — a backup for a `delivered` frame lost to batching.
    if (frame.kind === 'text' && frame.role === 'user' && typeof frame.id === 'string') {
      removePending(frame.id);
      return;
    }

    // The run is over; the server has already said `delivered` or `dropped`
    // for each, so anything still listed is a frame this tab missed.
    if (frame.kind === 'complete') {
      setPendingSteers([]);
      return;
    }

    if (frame.type === 'session-status' && frame.sessionId === sessionId && 'isProcessing' in frame) {
      // A tab opening mid-run learns what is still waiting to be read. Ours
      // already in the list keep their place.
      if (!frame.isProcessing) {
        setPendingSteers([]);
        return;
      }
      if ('pendingSteers' in frame) {
        setPendingSteers(readPendingList(frame.pendingSteers));
      }
    }
  }, [forgetOwn, latestMessage, removePending, sessionId]);

  /**
   * Sends `content` into the running turn of the current session. Shown as
   * pending at once; the server's answer decides what happens next.
   */
  const steer = useCallback((content: string, images?: unknown[]) => {
    if (!sessionId) {
      return false;
    }
    const messageId = createSteerMessageId();
    ownIdsRef.current.add(messageId);
    writeOwnSteerIds([...ownIdsRef.current]);
    setPendingSteers((previous) => [...previous, { messageId, content }]);
    sendMessage({
      type: 'claude-steer',
      sessionId,
      messageId,
      command: content,
      // Uploaded images travel along; the server saves them and appends their
      // paths to the text, as an ordinary send does.
      ...(images && images.length > 0 ? { images } : {}),
    });
    return true;
  }, [sendMessage, sessionId]);

  return { pendingSteers, steer };
}
