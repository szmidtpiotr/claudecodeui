import type { LLMProvider } from '../../../types/app';

/**
 * Custom MIME type so a session drag is only ever accepted by the sidebar's own
 * project drop targets — dragging text or a file over a project must not look
 * droppable.
 */
export const SESSION_DRAG_MIME_TYPE = 'application/x-cloudcli-session';

export type SessionDragPayload = {
  sessionId: string;
  sessionTitle: string;
  sourceProjectId: string;
  provider: LLMProvider;
};

/**
 * Only Claude transcripts can currently be re-parented; other providers store
 * their sessions in layouts the move service does not understand yet.
 */
export function isSessionMovable(provider: LLMProvider): boolean {
  return provider === 'claude';
}

export function writeSessionDragPayload(
  dataTransfer: DataTransfer,
  payload: SessionDragPayload,
): void {
  dataTransfer.effectAllowed = 'move';
  dataTransfer.setData(SESSION_DRAG_MIME_TYPE, JSON.stringify(payload));
}

export function readSessionDragPayload(dataTransfer: DataTransfer): SessionDragPayload | null {
  const raw = dataTransfer.getData(SESSION_DRAG_MIME_TYPE);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<SessionDragPayload>;
    if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) {
      return null;
    }

    return {
      sessionId: parsed.sessionId,
      sessionTitle: typeof parsed.sessionTitle === 'string' ? parsed.sessionTitle : '',
      sourceProjectId: typeof parsed.sourceProjectId === 'string' ? parsed.sourceProjectId : '',
      provider: (parsed.provider ?? 'claude') as LLMProvider,
    };
  } catch {
    return null;
  }
}

/**
 * `dragover` cannot read the payload (the browser hides values until drop), so
 * target highlighting keys off the advertised MIME type instead.
 */
export function hasSessionDragPayload(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer?.types?.includes(SESSION_DRAG_MIME_TYPE));
}
