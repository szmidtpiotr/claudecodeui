import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { Project, ProjectSession } from '../../../types/app';
import { TERMINAL_INIT_DELAY_MS } from '../constants/constants';
import { readChatRunOptions } from '../utils/chatRunOptions';
import { claimLink, openableLink, openInNewTab } from '../utils/openLink';
import { getShellWebSocketUrl, parseShellMessage, sendSocketMessage } from '../utils/socket';

const ANSI_ESCAPE_REGEX =
  /(?:\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u009D[^\u0007\u009C]*(?:\u0007|\u009C)|\u001B[PX^_][^\u001B]*\u001B\\|[\u0090\u0098\u009E\u009F][^\u009C]*\u009C|\u001B[@-Z\\-_])/g;
const PROCESS_EXIT_REGEX = /Process exited with code (\d+)/;

type UseShellConnectionOptions = {
  wsRef: MutableRefObject<WebSocket | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  selectedProjectRef: MutableRefObject<Project | null | undefined>;
  selectedSessionRef: MutableRefObject<ProjectSession | null | undefined>;
  initialCommandRef: MutableRefObject<string | null | undefined>;
  isPlainShellRef: MutableRefObject<boolean>;
  onProcessCompleteRef: MutableRefObject<((exitCode: number) => void) | null | undefined>;
  isInitialized: boolean;
  autoConnect: boolean;
  closeSocket: () => void;
  clearTerminalScreen: () => void;
  setAuthUrl: (nextAuthUrl: string) => void;
  onOutputRef?: MutableRefObject<(() => void) | null>;
};

type UseShellConnectionResult = {
  isConnected: boolean;
  /** Reports from derived sessions waiting for this conversation's next turn. */
  pendingDerivedReports: number;
  /** Why the running terminal's CLI misses changes made since it started (empty: up to date). */
  terminalOutdatedReasons: string[];
  /** Restarts the terminal's CLI on the same conversation. */
  restartTerminal: () => void;
  /** A link the terminal's CLI opened that the browser did not let this page open by itself. */
  blockedLink: string;
  dismissBlockedLink: () => void;
  isConnecting: boolean;
  closeSocket: () => void;
  connectToShell: () => void;
  disconnectFromShell: (options?: { suppressAutoConnect?: boolean }) => void;
};

export function useShellConnection({
  wsRef,
  terminalRef,
  fitAddonRef,
  selectedProjectRef,
  selectedSessionRef,
  initialCommandRef,
  isPlainShellRef,
  onProcessCompleteRef,
  isInitialized,
  autoConnect,
  closeSocket,
  clearTerminalScreen,
  setAuthUrl,
  onOutputRef,
}: UseShellConnectionOptions): UseShellConnectionResult {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [pendingDerivedReports, setPendingDerivedReports] = useState(0);
  const [terminalOutdatedReasons, setTerminalOutdatedReasons] = useState<string[]>([]);
  const [blockedLink, setBlockedLink] = useState('');
  const connectingRef = useRef(false);
  const suppressAutoConnectRef = useRef(false);

  const handleProcessCompletion = useCallback(
    (output: string) => {
      if (!isPlainShellRef.current || !onProcessCompleteRef.current) {
        return;
      }

      const sanitizedOutput = output.replace(ANSI_ESCAPE_REGEX, '');
      const cleanOutput = sanitizedOutput;
      if (cleanOutput.includes('Process exited with code 0')) {
        onProcessCompleteRef.current(0);
        return;
      }

      const match = cleanOutput.match(PROCESS_EXIT_REGEX);
      if (!match) {
        return;
      }

      const exitCode = Number.parseInt(match[1], 10);
      if (!Number.isNaN(exitCode) && exitCode !== 0) {
        onProcessCompleteRef.current(exitCode);
      }
    },
    [isPlainShellRef, onProcessCompleteRef],
  );

  const handleSocketMessage = useCallback(
    (rawPayload: string) => {
      const message = parseShellMessage(rawPayload);
      if (!message) {
        console.error('[Shell] Error handling WebSocket message:', rawPayload);
        return;
      }

      if (message.type === 'output') {
        const output = typeof message.data === 'string' ? message.data : '';
        handleProcessCompletion(output);
        terminalRef.current?.write(output);
        onOutputRef?.current?.();
        return;
      }

      if (message.type === 'terminal-outdated') {
        const reasons = Array.isArray(message.reasons)
          ? message.reasons.filter((reason): reason is string => typeof reason === 'string')
          : [];
        setTerminalOutdatedReasons(reasons);
        return;
      }

      if (message.type === 'open-link') {
        // The CLI opened a link (a click on it, usually): it opens here, in
        // the user's browser, not on the server. Opening a tab needs a recent
        // click on this page; without one the link is offered in a bar.
        const url = openableLink(message.url);
        if (url && claimLink(url) && !openInNewTab(url)) {
          setBlockedLink(url);
        }
        return;
      }

      if (message.type === 'derived-reports') {
        const pending = typeof message.pending === 'number' ? message.pending : 0;
        setPendingDerivedReports(Math.max(0, pending));
        return;
      }

      if (message.type === 'auth_url' || message.type === 'url_open') {
        const nextAuthUrl = typeof message.url === 'string' ? message.url : '';
        if (nextAuthUrl) {
          setAuthUrl(nextAuthUrl);
        }
      }
    },
    [handleProcessCompletion, onOutputRef, setAuthUrl, terminalRef],
  );

  const connectWebSocket = useCallback(
    (isConnectionLocked = false) => {
      if ((connectingRef.current && !isConnectionLocked) || isConnecting || isConnected) {
        return;
      }

      try {
        const wsUrl = getShellWebSocketUrl();
        if (!wsUrl) {
          connectingRef.current = false;
          setIsConnecting(false);
          return;
        }

        connectingRef.current = true;

        // One socket per terminal. A socket this hook no longer tracks must
        // not reach the terminal: two open sockets each attach to the tmux
        // session and both write its output here, so every typed letter
        // showed twice (or three times) until the tab was remounted.
        const previous = wsRef.current;
        if (previous) {
          wsRef.current = null;
          if (previous.readyState === WebSocket.OPEN || previous.readyState === WebSocket.CONNECTING) {
            previous.close();
          }
        }

        const socket = new WebSocket(wsUrl);
        wsRef.current = socket;
        const isCurrent = () => wsRef.current === socket;

        socket.onopen = () => {
          if (!isCurrent()) {
            socket.close();
            return;
          }
          setPendingDerivedReports(0);
          setTerminalOutdatedReasons([]);
          setBlockedLink('');
          setIsConnected(true);
          setIsConnecting(false);
          connectingRef.current = false;
          setAuthUrl('');

          window.setTimeout(() => {
            const currentTerminal = terminalRef.current;
            const currentFitAddon = fitAddonRef.current;
            const currentProject = selectedProjectRef.current;
            if (!isCurrent() || !currentTerminal || !currentFitAddon || !currentProject) {
              return;
            }

            currentFitAddon.fit();

            const sessionId = isPlainShellRef.current ? null : selectedSessionRef.current?.id || null;
            sendSocketMessage(socket, {
              type: 'init',
              projectPath: currentProject.fullPath || currentProject.path || '',
              sessionId: isPlainShellRef.current ? null : selectedSessionRef.current?.id || null,
              hasSession: isPlainShellRef.current ? false : Boolean(selectedSessionRef.current),
              provider: isPlainShellRef.current ? 'plain-shell' : (selectedSessionRef.current?.__provider || localStorage.getItem('selected-provider') || 'claude'),
              cols: currentTerminal.cols,
              rows: currentTerminal.rows,
              initialCommand: initialCommandRef.current,
              isPlainShell: isPlainShellRef.current,
              chatRunOptions: isPlainShellRef.current ? undefined : readChatRunOptions(sessionId),
            });
          }, TERMINAL_INIT_DELAY_MS);
        };

        socket.onmessage = (event) => {
          if (!isCurrent()) {
            return;
          }
          const rawPayload = typeof event.data === 'string' ? event.data : String(event.data ?? '');
          handleSocketMessage(rawPayload);
        };

        socket.onclose = () => {
          if (!isCurrent()) {
            return;
          }
          wsRef.current = null;
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
          clearTerminalScreen();
        };

        socket.onerror = () => {
          if (!isCurrent()) {
            return;
          }
          setIsConnected(false);
          setIsConnecting(false);
          connectingRef.current = false;
        };
      } catch {
        setIsConnected(false);
        setIsConnecting(false);
        connectingRef.current = false;
      }
    },
    [
      clearTerminalScreen,
      fitAddonRef,
      handleSocketMessage,
      initialCommandRef,
      isConnected,
      isConnecting,
      isPlainShellRef,
      selectedProjectRef,
      selectedSessionRef,
      setAuthUrl,
      terminalRef,
      wsRef,
    ],
  );

  const connectToShell = useCallback(() => {
    if (!isInitialized || isConnected || isConnecting || connectingRef.current) {
      return;
    }

    suppressAutoConnectRef.current = false;
    connectingRef.current = true;
    setIsConnecting(true);
    connectWebSocket(true);
  }, [connectWebSocket, isConnected, isConnecting, isInitialized]);

  const disconnectFromShell = useCallback((options?: { suppressAutoConnect?: boolean }) => {
    if (options?.suppressAutoConnect) {
      suppressAutoConnectRef.current = true;
    }
    closeSocket();
    clearTerminalScreen();
    setIsConnected(false);
    setIsConnecting(false);
    connectingRef.current = false;
    setAuthUrl('');
  }, [clearTerminalScreen, closeSocket, setAuthUrl]);

  useEffect(() => {
    if (
      !autoConnect ||
      suppressAutoConnectRef.current ||
      !isInitialized ||
      isConnecting ||
      isConnected
    ) {
      return;
    }

    connectToShell();
  }, [autoConnect, connectToShell, isConnected, isConnecting, isInitialized]);

  const restartTerminal = useCallback(() => {
    const socket = wsRef.current;
    if (socket) {
      sendSocketMessage(socket, { type: 'restart-terminal' });
    }
  }, [wsRef]);

  return {
    isConnected,
    pendingDerivedReports,
    terminalOutdatedReasons,
    restartTerminal,
    blockedLink,
    dismissBlockedLink: () => setBlockedLink(''),
    isConnecting,
    closeSocket,
    connectToShell,
    disconnectFromShell,
  };
}
