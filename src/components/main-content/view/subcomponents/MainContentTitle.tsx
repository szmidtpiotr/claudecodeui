import { useTranslation } from 'react-i18next';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import type { AppTab, Project, ProjectSession } from '../../../../types/app';
import { usePlugins } from '../../../../contexts/PluginsContext';
import { useSessionTitleRename } from '../../hooks/useSessionTitleRename';

type MainContentTitleProps = {
  activeTab: AppTab;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
  /** Persists a new title for a session; resolves false when the backend refuses it. */
  onRenameSession?: (sessionId: string, summary: string) => Promise<boolean>;
};

function getTabTitle(activeTab: AppTab, shouldShowTasksTab: boolean, t: (key: string) => string, pluginDisplayName?: string) {
  if (activeTab.startsWith('plugin:') && pluginDisplayName) {
    return pluginDisplayName;
  }

  if (activeTab === 'files') {
    return t('mainContent.projectFiles');
  }

  if (activeTab === 'git') {
    return t('tabs.git');
  }

  if (activeTab === 'tasks' && shouldShowTasksTab) {
    return 'TaskMaster';
  }

  return 'Project';
}

function getSessionTitle(session: ProjectSession): string {
  // The sessions API carries every provider's custom name as `summary`, so read
  // it first (as the sidebar does), or a renamed Cursor session keeps its old title.
  const title = (session.summary as string) || (session.name as string);
  if (title) {
    return title;
  }

  return session.__provider === 'cursor' ? 'Untitled Session' : 'New Session';
}

export default function MainContentTitle({
  activeTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  onRenameSession,
}: MainContentTitleProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();

  const pluginDisplayName = activeTab.startsWith('plugin:')
    ? plugins.find((p) => p.name === activeTab.replace('plugin:', ''))?.displayName
    : undefined;

  const showSessionIcon = activeTab === 'chat' && Boolean(selectedSession);
  const showChatNewSession = activeTab === 'chat' && !selectedSession;
  const sessionTitle = selectedSession ? getSessionTitle(selectedSession) : '';

  // Double-clicking the session title renames it in place, a second way in
  // beside the sidebar's rename.
  const {
    isEditing: isRenaming,
    draft: renameDraft,
    isSaving: isSavingRename,
    inputRef: renameInputRef,
    startEditing: startRenaming,
    updateDraft: updateRenameDraft,
    cancelEditing: cancelRenaming,
    handleInputKeyDown: handleRenameKeyDown,
  } = useSessionTitleRename({
    sessionId: onRenameSession && selectedSession ? String(selectedSession.id) : null,
    currentTitle: sessionTitle,
    onRenameSession: onRenameSession ?? (async () => false),
  });

  return (
    <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
      {showSessionIcon && (
        <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <SessionProviderLogo provider={selectedSession?.__provider} className="h-4 w-4" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        {activeTab === 'chat' && selectedSession ? (
          <div className="min-w-0">
            {isRenaming ? (
              <input
                ref={renameInputRef}
                type="text"
                value={renameDraft}
                onChange={(event) => updateRenameDraft(event.target.value)}
                onKeyDown={handleRenameKeyDown}
                // Clicking anywhere else cancels, as the sidebar's rename does.
                onBlur={cancelRenaming}
                readOnly={isSavingRename}
                aria-busy={isSavingRename}
                aria-label={t('mainContent.renameSessionLabel')}
                // Blur cancels, so a touch keyboard needs a key that commits.
                enterKeyHint="done"
                className="w-full max-w-md rounded border border-border bg-background px-1.5 py-0.5 text-sm font-semibold leading-tight text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            ) : (
              <h2
                title={onRenameSession ? t('mainContent.renameSessionHint', { title: sessionTitle }) : sessionTitle}
                onDoubleClick={startRenaming}
                className={`scrollbar-hide overflow-x-auto whitespace-nowrap text-sm font-semibold leading-tight text-foreground${onRenameSession ? ' cursor-text' : ''}`}
              >
                {sessionTitle}
              </h2>
            )}
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        ) : showChatNewSession ? (
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-tight text-foreground">{t('mainContent.newSession')}</h2>
            <div className="truncate text-xs leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        ) : (
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-tight text-foreground">
              {getTabTitle(activeTab, shouldShowTasksTab, t, pluginDisplayName)}
            </h2>
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        )}
      </div>
    </div>
  );
}
