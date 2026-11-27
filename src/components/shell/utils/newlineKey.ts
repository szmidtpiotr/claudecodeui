/**
 * What the CLI's prompt takes as a line break without sending: Ctrl+J. A
 * browser terminal sends the same "\r" for Shift+Enter as for Enter, so
 * Shift+Enter would send the message instead of starting a new line.
 */
export const NEWLINE_SEQUENCE = '\n';

type KeyLike = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>;

/** True for Shift+Enter alone (no Ctrl, Alt or Meta). */
export function isShiftEnter(event: KeyLike): boolean {
  return event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
}
