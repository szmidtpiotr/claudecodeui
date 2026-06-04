import React, { memo, useMemo, useCallback, useState, useEffect } from 'react';

import type { Project } from '../../../types/app';
import type { SubagentChildTool } from '../types/types';
import { authenticatedFetch } from '../../../utils/api';

import { getToolConfig } from './configs/toolConfigs';
import { OneLineDisplay, CollapsibleDisplay, ToolDiffViewer, MarkdownContent, FileListContent, TodoListContent, TaskListContent, TextContent, QuestionAnswerContent, SubagentContainer } from './components';
import { PlanDisplay } from './components/PlanDisplay';
import { ToolStatusBadge } from './components/ToolStatusBadge';
import type { ToolStatus } from './components/ToolStatusBadge';

type DiffLine = {
  type: string;
  content: string;
  lineNum: number;
};

interface ToolRendererProps {
  toolName: string;
  toolInput: any;
  toolResult?: any;
  toolId?: string;
  mode: 'input' | 'result';
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  createDiff?: (oldStr: string, newStr: string) => DiffLine[];
  selectedProject?: Project | null;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  rawToolInput?: string;
  isSubagentContainer?: boolean;
  subagentState?: {
    childTools: SubagentChildTool[];
    currentToolIndex: number;
    isComplete: boolean;
  };
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);

function isImagePath(filePath?: string): boolean {
  if (!filePath) return false;
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTS.has(ext);
}

function ToolImagePreview({ filePath }: { filePath: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    const ctrl = new AbortController();
    authenticatedFetch(`/api/files/raw?path=${encodeURIComponent(filePath)}`, { signal: ctrl.signal })
      .then(r => { if (!r.ok) throw new Error(); return r.blob(); })
      .then(blob => { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); })
      .catch(() => {});
    return () => { ctrl.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [filePath]);

  if (!url) return null;

  return (
    <>
      <img
        src={url}
        alt={filePath.split('/').pop()}
        className="mt-2 max-h-48 max-w-full cursor-zoom-in rounded-lg object-contain"
        onClick={() => setLightbox(true)}
      />
      {lightbox && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/85 backdrop-blur-sm"
          onClick={() => setLightbox(false)}
        >
          <button
            type="button"
            onClick={() => setLightbox(false)}
            className="absolute right-4 top-4 z-10 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
          >
            ✕
          </button>
          <img
            src={url}
            alt={filePath.split('/').pop()}
            draggable={false}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
            onClick={e => e.stopPropagation()}
          />
          <p className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/40 text-xs select-none">
            Click outside to close
          </p>
        </div>
      )}
    </>
  );
}

function getToolCategory(toolName: string): string {
  if (['Edit', 'Write', 'ApplyPatch'].includes(toolName)) return 'edit';
  if (['Grep', 'Glob'].includes(toolName)) return 'search';
  if (toolName === 'Bash') return 'bash';
  if (['TodoWrite', 'TodoRead'].includes(toolName)) return 'todo';
  if (['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'].includes(toolName)) return 'task';
  if (toolName === 'Task') return 'agent';
  if (toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode') return 'plan';
  if (toolName === 'AskUserQuestion') return 'question';
  return 'default';
}

// Exact denial messages from server/claude-sdk.js — other providers can't reliably signal denial
const CLAUDE_DENIAL_MESSAGES = [
  'user denied tool use',
  'tool disallowed by settings',
  'permission request timed out',
  'permission request cancelled',
];

function deriveToolStatus(toolResult: any): ToolStatus {
  if (!toolResult) return 'running';
  if (toolResult.isError) {
    const content = String(toolResult.content || '').toLowerCase().trim();
    if (CLAUDE_DENIAL_MESSAGES.some((msg) => content.includes(msg))) {
      return 'denied';
    }
    return 'error';
  }
  return 'completed';
}

/**
 * Main tool renderer router
 * Routes to OneLineDisplay or CollapsibleDisplay based on tool config
 */
export const ToolRenderer: React.FC<ToolRendererProps> = memo(({
  toolName,
  toolInput,
  toolResult,
  toolId,
  mode,
  onFileOpen,
  createDiff,
  selectedProject,
  autoExpandTools = false,
  showRawParameters = false,
  rawToolInput,
  isSubagentContainer,
  subagentState
}) => {
  const config = getToolConfig(toolName);
  const displayConfig: any = mode === 'input' ? config.input : config.result;

  const parsedData = useMemo(() => {
    try {
      const rawData = mode === 'input' ? toolInput : toolResult;
      return typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    } catch {
      return mode === 'input' ? toolInput : toolResult;
    }
  }, [mode, toolInput, toolResult]);

  // Only derive and show status badge on input renders
  const toolStatus = useMemo(
    () => mode === 'input' ? deriveToolStatus(toolResult) : undefined,
    [mode, toolResult],
  );

  const handleAction = useCallback(() => {
    if (displayConfig?.action === 'open-file' && onFileOpen) {
      const value = displayConfig.getValue?.(parsedData) || '';
      onFileOpen(value);
    }
  }, [displayConfig, parsedData, onFileOpen]);

  // Route subagent containers to dedicated component (after hooks to satisfy Rules of Hooks)
  if (isSubagentContainer && subagentState) {
    if (mode === 'result') return null;
    return (
      <SubagentContainer
        toolInput={toolInput}
        toolResult={toolResult}
        subagentState={subagentState}
      />
    );
  }

  if (!displayConfig) return null;

  if (displayConfig.type === 'one-line') {
    const value = displayConfig.getValue?.(parsedData) || '';
    const secondary = displayConfig.getSecondary?.(parsedData);

    // Show image preview for file tools (Read, View) that reference image files.
    // The toolInput always has the raw file path even when displayConfig hides the result.
    const inputFilePath = parsedData?.file_path || parsedData?.path;
    const inlineImagePreview = isImagePath(inputFilePath)
      ? <ToolImagePreview filePath={inputFilePath} />
      : null;

    return (
      <>
        <OneLineDisplay
          toolName={toolName}
          toolResult={toolResult}
          toolId={toolId}
          icon={displayConfig.icon}
          label={displayConfig.label}
          value={value}
          secondary={secondary}
          action={displayConfig.action}
          onAction={handleAction}
          style={displayConfig.style}
          wrapText={displayConfig.wrapText}
          colorScheme={displayConfig.colorScheme}
          resultId={mode === 'input' ? `tool-result-${toolId}` : undefined}
          status={toolStatus !== 'completed' ? toolStatus : undefined}
        />
        {inlineImagePreview}
      </>
    );
  }

  if (displayConfig.type === 'plan') {
    const title = typeof displayConfig.title === 'function'
      ? displayConfig.title(parsedData)
      : displayConfig.title || 'Plan';

    const contentProps = displayConfig.getContentProps?.(parsedData, {
      selectedProject,
      createDiff,
      onFileOpen
    }) || {};

    const isStreaming = mode === 'input' && !toolResult;

    return (
      <PlanDisplay
        title={title}
        content={contentProps.content || ''}
        defaultOpen={displayConfig.defaultOpen ?? autoExpandTools}
        isStreaming={isStreaming}
        showRawParameters={mode === 'input' && showRawParameters}
        rawContent={rawToolInput}
        toolName={toolName}
        toolId={toolId}
      />
    );
  }

  if (displayConfig.type === 'collapsible') {
    const title = typeof displayConfig.title === 'function'
      ? displayConfig.title(parsedData)
      : displayConfig.title || 'Details';

    const defaultOpen = displayConfig.defaultOpen !== undefined
      ? displayConfig.defaultOpen
      : autoExpandTools;

    const contentProps = displayConfig.getContentProps?.(parsedData, {
      selectedProject,
      createDiff,
      onFileOpen
    }) || {};

    let contentComponent: React.ReactNode = null;

    switch (displayConfig.contentType) {
      case 'diff':
        if (createDiff) {
          contentComponent = (
            <ToolDiffViewer
              {...contentProps}
              createDiff={createDiff}
              onFileClick={() => onFileOpen?.(contentProps.filePath)}
            />
          );
        }
        break;

      case 'markdown':
        contentComponent = <MarkdownContent content={contentProps.content || ''} />;
        break;

      case 'file-list':
        contentComponent = (
          <FileListContent
            files={contentProps.files || []}
            onFileClick={onFileOpen}
            title={contentProps.title}
          />
        );
        break;

      case 'todo-list':
        if (contentProps.todos?.length > 0) {
          contentComponent = (
            <TodoListContent
              todos={contentProps.todos}
              isResult={contentProps.isResult}
            />
          );
        }
        break;

      case 'task':
        contentComponent = <TaskListContent content={contentProps.content || ''} />;
        break;

      case 'question-answer':
        contentComponent = (
          <QuestionAnswerContent
            questions={contentProps.questions || []}
            answers={contentProps.answers || {}}
          />
        );
        break;

      case 'text':
        contentComponent = (
          <TextContent
            content={contentProps.content || ''}
            format={contentProps.format || 'plain'}
          />
        );
        break;

      case 'success-message': {
        const msg = displayConfig.getMessage?.(parsedData) || 'Success';
        contentComponent = (
          <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {msg}
          </div>
        );
        break;
      }
    }

    const handleTitleClick = (toolName === 'Edit' || toolName === 'Write' || toolName === 'ApplyPatch') && contentProps.filePath && onFileOpen
      ? () => onFileOpen(contentProps.filePath, {
          old_string: contentProps.oldContent,
          new_string: contentProps.newContent
        })
      : undefined;

    const badgeElement = toolStatus && toolStatus !== 'completed' ? <ToolStatusBadge status={toolStatus} /> : undefined;

    // Show image preview for Write/Edit tools that write image files (shown in input mode).
    // Also covers result mode for any other tools that might reference image files.
    const previewFilePath = contentProps?.filePath || parsedData?.file_path || parsedData?.path;
    const imagePreview = isImagePath(previewFilePath)
      ? <ToolImagePreview filePath={previewFilePath} />
      : null;

    return (
      <CollapsibleDisplay
        toolName={toolName}
        toolId={toolId}
        title={title}
        defaultOpen={defaultOpen}
        onTitleClick={handleTitleClick}
        badge={badgeElement}
        showRawParameters={mode === 'input' && showRawParameters}
        rawContent={rawToolInput}
        toolCategory={getToolCategory(toolName)}
      >
        {contentComponent}
        {imagePreview}
      </CollapsibleDisplay>
    );
  }

  return null;
});

ToolRenderer.displayName = 'ToolRenderer';
