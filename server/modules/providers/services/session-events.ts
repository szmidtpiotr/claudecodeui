import { EventEmitter } from 'node:events';

import type { LLMProvider } from '@/shared/types.js';

export type SessionMetadataChangedEvent = {
  sessionId: string;
  provider: LLMProvider;
};

/**
 * Dependency-free channel for "a session row changed outside the file watcher".
 *
 * The watcher owns the debounced `projects_updated` broadcast, but changes such
 * as a generated title originate in a service the watcher already depends on.
 * Both sides import this leaf module instead of each other.
 */
export const sessionEvents = new EventEmitter();

export const SESSION_METADATA_CHANGED = 'session-metadata-changed';

export function emitSessionMetadataChanged(event: SessionMetadataChangedEvent): void {
  sessionEvents.emit(SESSION_METADATA_CHANGED, event);
}
