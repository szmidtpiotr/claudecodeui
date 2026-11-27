const CLAUDE_PERMISSION_MODES = ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'];

export type ChatRunOptions = {
  permissionMode?: string;
  toolsSettings?: Record<string, unknown>;
};

function read(storage: Pick<Storage, 'getItem'>, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * The permission mode and tool settings the Chat tab would use for a Claude
 * conversation, as the browser stores them (per conversation, else the last
 * choice for Claude). Sent when the Shell tab opens the conversation, so a
 * derived session the terminal starts runs with them. Undefined when the
 * browser has none: the server then refuses rather than guessing.
 */
export function readChatRunOptions(
  sessionId: string | null | undefined,
  storage: Pick<Storage, 'getItem'> = localStorage,
): ChatRunOptions | undefined {
  const options: ChatRunOptions = {};
  const mode = [sessionId ? read(storage, `permissionMode-${sessionId}`) : null, read(storage, 'permissionMode-provider-claude')]
    .find((value): value is string => Boolean(value) && CLAUDE_PERMISSION_MODES.includes(value as string));
  if (mode) {
    options.permissionMode = mode;
  }
  const rawSettings = read(storage, 'claude-settings');
  if (rawSettings) {
    try {
      const parsed = JSON.parse(rawSettings) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        options.toolsSettings = parsed as Record<string, unknown>;
      }
    } catch {
      // unreadable settings: leave them out
    }
  }
  return Object.keys(options).length > 0 ? options : undefined;
}
