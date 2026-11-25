import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import '@xterm/xterm/css/xterm.css';
import type { Project, ProjectSession } from '../../../types/app';
import {
  PROMPT_BUFFER_SCAN_LINES,
  PROMPT_DEBOUNCE_MS,
  PROMPT_MAX_OPTIONS,
  PROMPT_MIN_OPTIONS,
  PROMPT_OPTION_SCAN_LINES,
  SHELL_RESTART_DELAY_MS,
} from '../constants/constants';
import { useKeyboardInset } from '../hooks/useKeyboardInset';
import { useShellRuntime } from '../hooks/useShellRuntime';
import { readClipboard } from '../utils/clipboardImage';
import { applyStickyModifiers, type StickyModifiers } from '../utils/modifiers';
import { sendSocketMessage } from '../utils/socket';
import { api } from '../../../utils/api';
import { getSessionDisplayName } from '../utils/auth';
import { detectSudoPrompt } from '../utils/sudo';

import ShellConnectionOverlay from './subcomponents/ShellConnectionOverlay';
import ShellEmptyState from './subcomponents/ShellEmptyState';
import ShellHeader from './subcomponents/ShellHeader';
import ShellMinimalView from './subcomponents/ShellMinimalView';
import PasteCatcher from './subcomponents/PasteCatcher';
import TerminalShortcutsPanel from './subcomponents/TerminalShortcutsPanel';

type CliPromptOption = { number: string; label: string };

type ShellProps = {
  selectedProject?: Project | null;
  selectedSession?: ProjectSession | null;
  initialCommand?: string | null;
  isPlainShell?: boolean;
  onProcessComplete?: ((exitCode: number) => void) | null;
  minimal?: boolean;
  autoConnect?: boolean;
  isActive?: boolean;
};

export default function Shell({
  selectedProject = null,
  selectedSession = null,
  initialCommand = null,
  isPlainShell = false,
  onProcessComplete = null,
  minimal = false,
  autoConnect = false,
  isActive = true,
}: ShellProps) {
  const { t } = useTranslation('chat');
  const [isRestarting, setIsRestarting] = useState(false);
  const [cliPromptOptions, setCliPromptOptions] = useState<CliPromptOption[] | null>(null);
  const [sudoPrompt, setSudoPrompt] = useState<string | null>(null);
  const [sudoPassword, setSudoPassword] = useState('');
  const promptCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onOutputRef = useRef<(() => void) | null>(null);
  const sudoInputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const keyboardInset = useKeyboardInset(rootRef);

  // On-screen CTRL / ALT. Mirrored in a ref because the terminal's input
  // handler is created once and must read the current value.
  const [modifiers, setModifiers] = useState<StickyModifiers>({ ctrl: false, alt: false });
  const modifiersRef = useRef(modifiers);
  const updateModifiers = useCallback((next: StickyModifiers) => {
    modifiersRef.current = next;
    setModifiers(next);
  }, []);
  const inputTransformRef = useRef<((data: string) => string) | null>((data) => {
    const active = modifiersRef.current;
    if (!active.ctrl && !active.alt) {
      return data;
    }
    updateModifiers({ ctrl: false, alt: false });
    return applyStickyModifiers(data, active);
  });

  const [isUploadingImages, setIsUploadingImages] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const onImageFilesRef = useRef<((files: File[]) => void) | null>(null);

  const {
    terminalContainerRef,
    terminalRef,
    wsRef,
    isConnected,
    isInitialized,
    isConnecting,
    authUrl,
    authUrlVersion,
    connectToShell,
    disconnectFromShell,
    openAuthUrlInBrowser,
    copyAuthUrlToClipboard,
  } = useShellRuntime({
    selectedProject,
    selectedSession,
    initialCommand,
    isPlainShell,
    minimal,
    autoConnect,
    isRestarting,
    onProcessComplete,
    onOutputRef,
    inputTransformRef,
    onImageFilesRef,
  });

  // A terminal CLI takes an image as a file path: save the files on the server
  // and paste the paths, exactly as dropping a file onto a desktop terminal does.
  const imageProjectId = !minimal && !isPlainShell ? selectedProject?.projectId : undefined;
  const attachImages = useCallback(
    async (files: File[]) => {
      if (!imageProjectId || files.length === 0) {
        return;
      }

      setIsUploadingImages(true);
      setImageError(null);
      try {
        const response = await api.uploadShellImages(imageProjectId, files);
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !Array.isArray(body.paths) || body.paths.length === 0) {
          throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`);
        }
        terminalRef.current?.paste(`${body.paths.join(' ')} `);
        terminalRef.current?.focus();
      } catch (error) {
        setImageError(error instanceof Error ? error.message : String(error));
      } finally {
        setIsUploadingImages(false);
      }
    },
    [imageProjectId, terminalRef],
  );

  useEffect(() => {
    onImageFilesRef.current = imageProjectId
      ? (files) => {
          void attachImages(files);
        }
      : null;
  }, [attachImages, imageProjectId]);

  // Paste button: text or a screenshot. Where the browser refuses to hand over
  // the clipboard (plain HTTP, denied permission) a field to paste into opens.
  const [pasteCatcherOpen, setPasteCatcherOpen] = useState(false);
  const pasteText = useCallback(
    (text: string) => {
      terminalRef.current?.paste(text);
      terminalRef.current?.focus();
    },
    [terminalRef],
  );
  const pasteFromClipboard = useCallback(async () => {
    const content = await readClipboard();
    if (content.kind === 'image' && imageProjectId) {
      void attachImages([content.file]);
    } else if (content.kind === 'text') {
      pasteText(content.text);
    } else if (content.kind === 'unavailable') {
      setPasteCatcherOpen(true);
    }
  }, [attachImages, imageProjectId, pasteText]);
  const handlePasteButton = useCallback(() => {
    void pasteFromClipboard();
  }, [pasteFromClipboard]);

  useEffect(() => {
    if (!imageError) {
      return undefined;
    }
    const timer = window.setTimeout(() => setImageError(null), 8000);
    return () => window.clearTimeout(timer);
  }, [imageError]);

  // Check xterm.js buffer for CLI prompt patterns (❯ N. label)
  const checkBufferForPrompt = useCallback(() => {
    const term = terminalRef.current;
    if (!term) return;
    const buf = term.buffer.active;
    const lastContentRow = buf.baseY + buf.cursorY;

    // sudo (and su) print their prompt on the cursor line and wait for hidden
    // input. Surface it as a popup so the password never has to be typed blind.
    const cursorLine = buf.getLine(lastContentRow)?.translateToString().trimEnd() ?? '';
    setSudoPrompt(detectSudoPrompt(cursorLine));

    const scanEnd = Math.min(buf.baseY + buf.length - 1, lastContentRow + 10);
    const scanStart = Math.max(0, lastContentRow - PROMPT_BUFFER_SCAN_LINES);
    const lines: string[] = [];
    for (let i = scanStart; i <= scanEnd; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString().trimEnd());
    }

    let footerIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/esc to cancel/i.test(lines[i]) || /enter to select/i.test(lines[i])) {
        footerIdx = i;
        break;
      }
    }

    if (footerIdx === -1) {
      setCliPromptOptions(null);
      return;
    }

    // Scan upward from footer collecting numbered options.
    // Non-matching lines are allowed (multi-line labels, blank separators)
    // because CLI prompts may wrap options across multiple terminal rows.
    const optMap = new Map<string, string>();
    const optScanStart = Math.max(0, footerIdx - PROMPT_OPTION_SCAN_LINES);
    for (let i = footerIdx - 1; i >= optScanStart; i--) {
      const match = lines[i].match(/^\s*[❯›>]?\s*(\d+)\.\s+(.+)/);
      if (match) {
        const num = match[1];
        const label = match[2].trim();
        if (parseInt(num, 10) <= PROMPT_MAX_OPTIONS && label.length > 0 && !optMap.has(num)) {
          optMap.set(num, label);
        }
      }
    }

    const valid: CliPromptOption[] = [];
    for (let i = 1; i <= optMap.size; i++) {
      if (optMap.has(String(i))) valid.push({ number: String(i), label: optMap.get(String(i))! });
      else break;
    }

    setCliPromptOptions(valid.length >= PROMPT_MIN_OPTIONS ? valid : null);
  }, [terminalRef]);

  // Schedule prompt check after terminal output (debounced)
  const schedulePromptCheck = useCallback(() => {
    if (promptCheckTimer.current) clearTimeout(promptCheckTimer.current);
    promptCheckTimer.current = setTimeout(checkBufferForPrompt, PROMPT_DEBOUNCE_MS);
  }, [checkBufferForPrompt]);

  // Wire up the onOutput callback
  useEffect(() => {
    onOutputRef.current = schedulePromptCheck;
  }, [schedulePromptCheck]);

  // Cleanup prompt check timer on unmount
  useEffect(() => {
    return () => {
      if (promptCheckTimer.current) clearTimeout(promptCheckTimer.current);
    };
  }, []);

  // Clear stale prompt options and cancel pending timer on disconnect
  useEffect(() => {
    if (!isConnected) {
      if (promptCheckTimer.current) {
        clearTimeout(promptCheckTimer.current);
        promptCheckTimer.current = null;
      }
      setCliPromptOptions(null);
      setSudoPrompt(null);
      setSudoPassword('');
    }
  }, [isConnected]);

  useEffect(() => {
    if (!isActive || !isInitialized || !isConnected) {
      return;
    }

    const focusTerminal = () => {
      terminalRef.current?.focus();
    };

    const animationFrameId = window.requestAnimationFrame(focusTerminal);
    const timeoutId = window.setTimeout(focusTerminal, 0);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      window.clearTimeout(timeoutId);
    };
  }, [isActive, isConnected, isInitialized, terminalRef]);

  const sendInput = useCallback(
    (data: string) => {
      sendSocketMessage(wsRef.current, { type: 'input', data });
    },
    [wsRef],
  );

  const submitSudoPassword = useCallback(() => {
    if (!sudoPrompt) {
      return;
    }
    // Goes over the same input channel sudo always reads from; the terminal
    // keeps echo off so the password is never rendered on screen.
    sendInput(`${sudoPassword}\r`);
    setSudoPassword('');
    setSudoPrompt(null);
    terminalRef.current?.focus();
  }, [sendInput, sudoPassword, sudoPrompt, terminalRef]);

  const cancelSudoPrompt = useCallback(() => {
    sendInput('\x03'); // Ctrl-C aborts the pending sudo prompt
    setSudoPassword('');
    setSudoPrompt(null);
    terminalRef.current?.focus();
  }, [sendInput, terminalRef]);

  // Focus the password field as soon as the prompt appears
  useEffect(() => {
    if (!sudoPrompt) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => sudoInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frameId);
  }, [sudoPrompt]);

  const sessionDisplayName = useMemo(() => getSessionDisplayName(selectedSession), [selectedSession]);
  const sessionDisplayNameShort = useMemo(
    () => (sessionDisplayName ? sessionDisplayName.slice(0, 30) : null),
    [sessionDisplayName],
  );
  const sessionDisplayNameLong = useMemo(
    () => (sessionDisplayName ? sessionDisplayName.slice(0, 50) : null),
    [sessionDisplayName],
  );

  const handleRestartShell = useCallback(() => {
    setIsRestarting(true);
    window.setTimeout(() => {
      setIsRestarting(false);
    }, SHELL_RESTART_DELAY_MS);
  }, []);

  if (!selectedProject) {
    return (
      <ShellEmptyState
        title={t('shell.selectProject.title')}
        description={t('shell.selectProject.description')}
      />
    );
  }

  if (minimal) {
    return (
      <div
        ref={rootRef}
        className="relative flex h-full w-full flex-col"
        style={{ paddingBottom: keyboardInset }}
      >
        <div className="min-h-0 flex-1">
          <ShellMinimalView
            terminalContainerRef={terminalContainerRef}
            authUrl={authUrl}
            authUrlVersion={authUrlVersion}
            initialCommand={initialCommand}
            isConnected={isConnected}
            openAuthUrlInBrowser={openAuthUrlInBrowser}
            copyAuthUrlToClipboard={copyAuthUrlToClipboard}
          />
        </div>
        <TerminalShortcutsPanel
          wsRef={wsRef}
          terminalRef={terminalRef}
          isConnected={isConnected}
          modifiers={modifiers}
          onModifiersChange={updateModifiers}
          onPaste={handlePasteButton}
        />
        {pasteCatcherOpen && (
          <PasteCatcher onText={pasteText} onImages={() => {}} onClose={() => setPasteCatcherOpen(false)} />
        )}
      </div>
    );
  }

  const readyDescription = isPlainShell
    ? t('shell.runCommand', {
        command: initialCommand || t('shell.defaultCommand'),
        projectName: selectedProject.displayName,
      })
    : selectedSession
      ? t('shell.resumeSession', { displayName: sessionDisplayNameLong })
      : t('shell.startSession');

  const connectingDescription = isPlainShell
    ? t('shell.runCommand', {
        command: initialCommand || t('shell.defaultCommand'),
        projectName: selectedProject.displayName,
      })
    : t('shell.startCli', { projectName: selectedProject.displayName });

  const overlayMode = !isInitialized ? 'loading' : isConnecting ? 'connecting' : !isConnected ? 'connect' : null;
  const overlayDescription = overlayMode === 'connecting' ? connectingDescription : readyDescription;

  return (
    <div
      ref={rootRef}
      className="flex h-full w-full flex-col bg-gray-900"
      style={{ paddingBottom: keyboardInset }}
    >
      <ShellHeader
        isConnected={isConnected}
        isInitialized={isInitialized}
        isRestarting={isRestarting}
        hasSession={Boolean(selectedSession)}
        sessionDisplayNameShort={sessionDisplayNameShort}
        onDisconnect={disconnectFromShell}
        onRestart={handleRestartShell}
        statusNewSessionText={t('shell.status.newSession')}
        statusInitializingText={t('shell.status.initializing')}
        statusRestartingText={t('shell.status.restarting')}
        disconnectLabel={t('shell.actions.disconnect')}
        disconnectTitle={t('shell.actions.disconnectTitle')}
        restartLabel={t('shell.actions.restart')}
        restartTitle={t('shell.actions.restartTitle')}
        disableRestart={isRestarting || isConnected}
      />

      <div className="relative flex-1 overflow-hidden p-2">
        <div
          ref={terminalContainerRef}
          className="h-full w-full focus:outline-none"
          // Swipes are turned into terminal scrolling (see touchScroll.ts), so
          // the browser must not pan the page or pull-to-refresh here.
          style={{ outline: 'none', touchAction: 'none' }}
        />

        {overlayMode && (
          <ShellConnectionOverlay
            mode={overlayMode}
            description={overlayDescription}
            loadingLabel={t('shell.loading')}
            connectLabel={t('shell.actions.connect')}
            connectTitle={t('shell.actions.connectTitle')}
            connectingLabel={t('shell.connecting')}
            onConnect={connectToShell}
          />
        )}

        {cliPromptOptions && isConnected && (
          <div
            className="absolute inset-x-0 bottom-0 z-10 border-t border-gray-700/80 bg-gray-800/95 px-3 py-2 backdrop-blur-sm"
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="flex flex-wrap items-center gap-2">
              {cliPromptOptions.map((opt) => (
                <button
                  type="button"
                  key={opt.number}
                  onClick={() => {
                    sendInput(opt.number);
                    setCliPromptOptions(null);
                  }}
                  className="max-w-36 truncate rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700"
                  title={`${opt.number}. ${opt.label}`}
                >
                  {opt.number}. {opt.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  sendInput('\x1b');
                  setCliPromptOptions(null);
                }}
                className="rounded bg-gray-700 px-3 py-1.5 text-xs font-medium text-gray-200 transition-colors hover:bg-gray-600"
              >
                Esc
              </button>
            </div>
          </div>
        )}

        {pasteCatcherOpen && (
          <PasteCatcher
            onText={pasteText}
            onImages={(files) => void attachImages(files)}
            onClose={() => {
              setPasteCatcherOpen(false);
              terminalRef.current?.focus();
            }}
          />
        )}

        {sudoPrompt && isConnected && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 p-4">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitSudoPassword();
              }}
              className="w-full max-w-sm rounded-lg border border-gray-700 bg-gray-800 p-4 shadow-xl"
            >
              <div className="mb-1 flex items-center gap-2 text-sm font-medium text-gray-100">
                <span aria-hidden>🔒</span>
                <span>{t('shell.sudo.title')}</span>
              </div>
              <p className="mb-3 truncate font-mono text-xs text-gray-400" title={sudoPrompt}>
                {sudoPrompt}
              </p>
              <input
                ref={sudoInputRef}
                type="password"
                autoComplete="off"
                value={sudoPassword}
                onChange={(e) => setSudoPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelSudoPrompt();
                  }
                }}
                placeholder={t('shell.sudo.placeholder')}
                className="mb-3 w-full rounded border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-blue-500"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={cancelSudoPrompt}
                  className="rounded bg-gray-700 px-3 py-1.5 text-xs font-medium text-gray-200 transition-colors hover:bg-gray-600"
                >
                  {t('shell.sudo.cancel')}
                </button>
                <button
                  type="submit"
                  className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700"
                >
                  {t('shell.sudo.submit')}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>

      {imageError && (
        <div className="shrink-0 px-3 pb-1 text-xs text-red-400" role="alert">
          {t('shell.imageUploadFailed', { defaultValue: 'Image was not attached' })}: {imageError}
        </div>
      )}

      <TerminalShortcutsPanel
        wsRef={wsRef}
        terminalRef={terminalRef}
        isConnected={isConnected}
        modifiers={modifiers}
        onModifiersChange={updateModifiers}
        onImageFiles={imageProjectId ? (files) => void attachImages(files) : undefined}
        isUploadingImages={isUploadingImages}
        onPaste={handlePasteButton}
      />
    </div>
  );
}
