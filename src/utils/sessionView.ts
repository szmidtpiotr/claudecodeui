export type SessionView = 'chat' | 'shell';

export const isSessionView = (tab: string): tab is SessionView => tab === 'chat' || tab === 'shell';

/**
 * Which view a session should open in, given what was remembered for it and
 * the tab currently shown. Only swaps between the two session views: a user
 * browsing files or git stays there when picking another session.
 */
export function resolveSessionView(
  remembered: SessionView | undefined,
  currentTab: string,
): SessionView | null {
  if (!remembered || !isSessionView(currentTab) || remembered === currentTab) {
    return null;
  }
  return remembered;
}
