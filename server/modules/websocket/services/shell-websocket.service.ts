import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pty, { type IPty } from 'node-pty';
import { WebSocket, type RawData } from 'ws';

import { sessionsDb } from '@/modules/database/index.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';
import {
  buildTmuxClientArgs,
  DERIVED_TOOLS_ENV,
  hasDerivedToolsTerminal,
  cancelTmuxCopyMode,
  leaveCopyModeBeforeTyping,
  closeTerminalIfOutdated,
  isTmuxEnabled,
  resizeTmuxWindow,
  resolveNewSessionId,
  tmuxSessionName,
  trackNewSessionClient,
} from '@/modules/websocket/services/shell-tmux.service.js';

type ShellIncomingMessage = {
  type?: string;
  data?: string;
  cols?: number;
  rows?: number;
  projectPath?: string;
  sessionId?: string;
  hasSession?: boolean;
  provider?: string;
  initialCommand?: string;
  isPlainShell?: boolean;
};

type PtySessionEntry = {
  pty: IPty;
  ws: WebSocket | null;
  buffer: string[];
  timeoutId: NodeJS.Timeout | null;
  projectPath: string;
  sessionId: string | null;
  /** Conversation of a Claude CLI started here with the derived-sessions tools. */
  derivedToolsSessionId: string | null;
};

const ptySessionsMap = new Map<string, PtySessionEntry>();
const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;
const SHELL_URL_PARSE_BUFFER_LIMIT = 32768;

type ShellWebSocketDependencies = {
  getSessionById: (sessionId: string) => { cliSessionId?: string } | null | undefined;
  stripAnsiSequences: (content: string) => string;
  normalizeDetectedUrl: (url: string) => string | null;
  extractUrlsFromText: (content: string) => string[];
  shouldAutoOpenUrlFromOutput: (content: string) => boolean;
  /**
   * Writes the --mcp-config/--settings files that give a terminal's Claude
   * CLI the derived-sessions tools; null when they are unavailable.
   */
  prepareClaudeTerminal?: (
    sessionId: string,
    userId: string | number | null
  ) => { mcpConfigPath: string; settingsPath: string } | null;
  /** Reports from derived sessions waiting for a conversation. */
  getPendingReportCount?: (sessionId: string) => number;
};

/**
 * Reads a string field from untyped payloads and falls back when absent.
 */
function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Reads a boolean field from untyped payloads and falls back when absent.
 */
function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Reads a finite number field from untyped payloads and falls back when absent.
 */
function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Parses incoming websocket shell messages and keeps processing safe when
 * malformed payloads are received.
 */
function parseShellMessage(rawMessage: RawData): ShellIncomingMessage | null {
  const payload = parseIncomingJsonObject(rawMessage);
  if (!payload) {
    return null;
  }

  return payload as ShellIncomingMessage;
}

/** Shell tabs showing a Claude conversation, for the "reports waiting" notice. */
const conversationSockets = new Map<string, Set<WebSocket>>();
/** tmux sessions started here per conversation (the name may use the client's path spelling). */
const conversationTmuxNames = new Map<string, Set<string>>();

function sendPendingReports(ws: WebSocket, sessionId: string, count: number): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'derived-reports', sessionId, pending: count }));
  }
}

/**
 * True while a Claude CLI that has the derived-sessions hooks runs in a
 * terminal on this conversation. A terminal without them (started before
 * this feature, or a fallback `claude`) does not count: reports for it are
 * delivered the chat's way, as before.
 */
export function isConversationOpenInShell(sessionId: string): boolean {
  for (const entry of ptySessionsMap.values()) {
    if (entry.derivedToolsSessionId === sessionId) {
      return true;
    }
  }
  if (!isTmuxEnabled()) {
    return false;
  }
  const names = new Set(conversationTmuxNames.get(sessionId) ?? []);
  const projectPath = sessionsDb.getSessionById(sessionId)?.project_path;
  if (projectPath) {
    names.add(tmuxSessionName(`${projectPath}_${sessionId}`));
  }
  for (const name of names) {
    if (hasDerivedToolsTerminal(name)) {
      return true;
    }
  }
  return false;
}

/** Tells every Shell tab showing the conversation how many reports wait for it. */
export function notifyShellPendingReports(sessionId: string, count: number): void {
  for (const socket of conversationSockets.get(sessionId) ?? []) {
    sendPendingReports(socket, sessionId, count);
  }
}

/**
 * `claude` flags that hand the CLI the derived-sessions tools and hooks for
 * `sessionId` (file paths only; the token stays inside the 0600 files).
 */
function derivedToolsFlags(
  dependencies: ShellWebSocketDependencies,
  sessionId: string | null,
  userId: string | number | null
): string {
  if (!sessionId || os.platform() === 'win32' || !dependencies.prepareClaudeTerminal) {
    return '';
  }
  try {
    const launch = dependencies.prepareClaudeTerminal(sessionId, userId);
    return launch ? ` --mcp-config "${launch.mcpConfigPath}" --settings "${launch.settingsPath}"` : '';
  } catch (error) {
    console.error('[ERROR] Shell: derived-sessions config not written:', error instanceof Error ? error.message : String(error));
    return '';
  }
}

/**
 * Resolves provider command line for plain shell and agent-backed shell modes.
 */
function buildShellCommand(
  message: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies,
  newClaudeSessionId: string | null = null,
  claudeFlags = ''
): string {
  const hasSession = readBoolean(message.hasSession);
  const sessionId = readString(message.sessionId);
  const initialCommand = readString(message.initialCommand);
  const provider = readString(message.provider, 'claude');
  const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
  const isPlainShell =
    readBoolean(message.isPlainShell) ||
    (!!initialCommand && !hasSession) ||
    provider === 'plain-shell';

  if (isPlainShell) {
    return initialCommand;
  }

  if (provider === 'cursor') {
    if (hasSession && sessionId) {
      return `cursor-agent --resume="${sessionId}"`;
    }
    return 'cursor-agent';
  }

  if (provider === 'codex') {
    if (hasSession && sessionId) {
      if (os.platform() === 'win32') {
        return `codex resume "${sessionId}"; if ($LASTEXITCODE -ne 0) { codex }`;
      }
      return `codex resume "${sessionId}" || codex`;
    }
    return 'codex';
  }

  if (provider === 'gemini') {
    const command = initialCommand || 'gemini';
    let resumeId = sessionId;
    if (hasSession && sessionId) {
      try {
        const existingSession = dependencies.getSessionById(sessionId);
        if (existingSession && existingSession.cliSessionId) {
          resumeId = existingSession.cliSessionId;
          if (!safeSessionIdPattern.test(resumeId)) {
            resumeId = '';
          }
        }
      } catch (error) {
        console.error('Failed to get Gemini CLI session ID:', error);
      }
    }

    if (hasSession && resumeId) {
      return `${command} --resume "${resumeId}"`;
    }
    return command;
  }

  if (provider === 'opencode') {
    if (hasSession && sessionId) {
      return `opencode --session "${sessionId}"`;
    }
    return initialCommand || 'opencode';
  }

  const command = initialCommand || 'claude';
  if (hasSession && sessionId) {
    if (os.platform() === 'win32') {
      return `claude --resume "${sessionId}"; if ($LASTEXITCODE -ne 0) { claude }`;
    }
    return `claude${claudeFlags} --resume "${sessionId}" || claude`;
  }
  if (newClaudeSessionId) {
    return `${command}${claudeFlags} --session-id "${newClaudeSessionId}"`;
  }
  return command;
}

/**
 * True when a brand-new Claude conversation is being started with the stock
 * command, i.e. when the server may pick the conversation id itself.
 */
function isFreshClaudeSession(message: ShellIncomingMessage): boolean {
  const provider = readString(message.provider, 'claude');
  const hasSession = readBoolean(message.hasSession) && !!readString(message.sessionId);
  return provider === 'claude' && !hasSession && !readString(message.initialCommand);
}

/**
 * Handles websocket connections used by the standalone shell terminal UI.
 */
export function handleShellConnection(
  ws: WebSocket,
  dependencies: ShellWebSocketDependencies,
  userId: string | number | null = null
): void {
  console.log('[INFO] Shell websocket connected');

  let shellProcess: IPty | null = null;
  let ptySessionKey: string | null = null;
  // Set when this connection is a tmux client: the session outlives the pty.
  let tmuxName: string | null = null;
  let trackedNewSession: { projectPath: string; sessionId: string } | null = null;
  let urlDetectionBuffer = '';
  const announcedAuthUrls = new Set<string>();
  // The Claude conversation this tab shows, for the "reports waiting" notice.
  let watchedConversation: string | null = null;
  const watchConversation = (conversationId: string | null) => {
    if (watchedConversation) {
      conversationSockets.get(watchedConversation)?.delete(ws);
    }
    watchedConversation = conversationId;
    if (!conversationId) {
      return;
    }
    const sockets = conversationSockets.get(conversationId) ?? new Set<WebSocket>();
    sockets.add(ws);
    conversationSockets.set(conversationId, sockets);
    const pending = dependencies.getPendingReportCount?.(conversationId) ?? 0;
    if (pending > 0) {
      sendPendingReports(ws, conversationId, pending);
    }
  };

  ws.on('message', async (rawMessage) => {
    try {
      const data = parseShellMessage(rawMessage);
      if (!data?.type) {
        throw new Error('Invalid websocket payload');
      }

      if (data.type === 'init') {
        const projectPath = readString(data.projectPath, process.cwd());
        const sessionId = readString(data.sessionId) || null;
        const hasSession = readBoolean(data.hasSession);
        const provider = readString(data.provider, 'claude');
        const initialCommand = readString(data.initialCommand);
        const isPlainShell =
          readBoolean(data.isPlainShell) ||
          (!!initialCommand && !hasSession) ||
          provider === 'plain-shell';

        urlDetectionBuffer = '';
        announcedAuthUrls.clear();

        const isLoginCommand =
          !!initialCommand &&
          (initialCommand.includes('setup-token') ||
            initialCommand.includes('cursor-agent login') ||
            initialCommand.includes('auth login'));

        const commandSuffix =
          isPlainShell && initialCommand
            ? `_cmd_${Buffer.from(initialCommand).toString('base64').slice(0, 16)}`
            : '';
        ptySessionKey = `${projectPath}_${sessionId ?? 'default'}${commandSuffix}`;

        const useTmux = !isPlainShell && !isLoginCommand && isTmuxEnabled();
        let newClaudeSessionId: string | null = null;
        if (useTmux) {
          if (isFreshClaudeSession(data)) {
            newClaudeSessionId = resolveNewSessionId(projectPath, (id) => `${projectPath}_${id}`);
            trackedNewSession = { projectPath, sessionId: newClaudeSessionId };
          }
          // Named after the conversation, so every device opening it lands in
          // the same tmux session. The pty map key is unique per connection:
          // each websocket gets its own tmux client.
          tmuxName = tmuxSessionName(`${projectPath}_${newClaudeSessionId ?? sessionId ?? 'default'}`);
          ptySessionKey = `${ptySessionKey}#${tmuxName}#${Date.now()}-${Math.random().toString(36).slice(2)}`;

          // The chat wrote to this conversation after the terminal started:
          // start a new terminal that resumes it with the full history.
          const conversationId = newClaudeSessionId ?? sessionId;
          if (conversationId && closeTerminalIfOutdated(tmuxName, conversationId)) {
            // A conversation first started here has a history now: resume it
            // rather than asking the CLI to create its id a second time.
            if (newClaudeSessionId) {
              data.sessionId = newClaudeSessionId;
              data.hasSession = true;
              newClaudeSessionId = null;
            }
          }
        }

        if (isLoginCommand) {
          const oldSession = ptySessionsMap.get(ptySessionKey);
          if (oldSession) {
            if (oldSession.timeoutId) {
              clearTimeout(oldSession.timeoutId);
            }
            oldSession.pty.kill();
            ptySessionsMap.delete(ptySessionKey);
          }
        }

        const isClaudeAgent = !isPlainShell && !isLoginCommand && provider === 'claude';
        const claudeConversationId = isClaudeAgent
          ? (readBoolean(data.hasSession) && readString(data.sessionId)) || newClaudeSessionId
          : null;
        watchConversation(claudeConversationId || null);

        const existingSession = isLoginCommand ? null : ptySessionsMap.get(ptySessionKey);
        if (existingSession) {
          shellProcess = existingSession.pty;
          if (existingSession.timeoutId) {
            clearTimeout(existingSession.timeoutId);
          }

          ws.send(
            JSON.stringify({
              type: 'output',
              data: '\x1b[36m[Reconnected to existing session]\x1b[0m\r\n',
            })
          );

          if (existingSession.buffer.length > 0) {
            existingSession.buffer.forEach((bufferedData) => {
              ws.send(
                JSON.stringify({
                  type: 'output',
                  data: bufferedData,
                })
              );
            });
          }

          existingSession.ws = ws;
          return;
        }

        const resolvedProjectPath = path.resolve(projectPath);
        try {
          const stats = fs.statSync(resolvedProjectPath);
          if (!stats.isDirectory()) {
            throw new Error('Not a directory');
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid project path' }));
          return;
        }

        const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
        if (sessionId && !safeSessionIdPattern.test(sessionId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid session ID' }));
          return;
        }

        // The tools need the conversation id up front: a resume or a new
        // conversation under an id chosen here (tmux).
        const claudeFlags = claudeConversationId ? derivedToolsFlags(dependencies, claudeConversationId, userId) : '';
        const shellCommand = buildShellCommand(data, dependencies, newClaudeSessionId, claudeFlags);
        const sessionEnv: Record<string, string> = { COLORTERM: 'truecolor', FORCE_COLOR: '3' };
        if (claudeFlags) {
          // Marks the tmux session as one whose CLI has the hooks.
          sessionEnv[DERIVED_TOOLS_ENV] = '1';
        }
        let shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
        let shellArgs =
          os.platform() === 'win32' ? ['-Command', shellCommand] : ['-c', shellCommand];
        if (tmuxName) {
          shell = 'tmux';
          // The terminal is filed under its conversation. A fresh CLI started
          // as a fallback (resume declined at the trust prompt, or failed)
          // would stay attached there as if it were that conversation.
          const fallback = ' || claude';
          const tmuxCommand = shellCommand.endsWith(fallback)
            ? `${shellCommand.slice(0, -fallback.length)} || { echo; echo "The conversation was not resumed. Open the Shell tab again to retry."; sleep 6; }`
            : shellCommand;
          shellArgs = buildTmuxClientArgs({
            name: tmuxName,
            cwd: resolvedProjectPath,
            command: tmuxCommand,
            env: sessionEnv,
          });
          if (trackedNewSession) {
            trackNewSessionClient(trackedNewSession.projectPath, trackedNewSession.sessionId, 1);
          }
          if (claudeConversationId) {
            const names = conversationTmuxNames.get(claudeConversationId) ?? new Set<string>();
            names.add(tmuxName);
            conversationTmuxNames.set(claudeConversationId, names);
          }
        }
        const termCols = readNumber(data.cols, 80);
        const termRows = readNumber(data.rows, 24);

        shellProcess = pty.spawn(shell, shellArgs, {
          name: 'xterm-256color',
          cols: termCols,
          rows: termRows,
          cwd: resolvedProjectPath,
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            ...sessionEnv,
          },
        });

        ptySessionsMap.set(ptySessionKey, {
          pty: shellProcess,
          ws,
          buffer: [],
          timeoutId: null,
          projectPath,
          sessionId,
          // tmux clients come and go; the tmux session itself is checked instead.
          derivedToolsSessionId: claudeFlags && !tmuxName ? claudeConversationId : null,
        });

        shellProcess.onData((chunk) => {
          if (!ptySessionKey) {
            return;
          }

          const session = ptySessionsMap.get(ptySessionKey);
          if (!session) {
            return;
          }

          if (session.buffer.length < 5000) {
            session.buffer.push(chunk);
          } else {
            session.buffer.shift();
            session.buffer.push(chunk);
          }

          if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            let outputData = chunk;
            const cleanChunk = dependencies.stripAnsiSequences(chunk);
            urlDetectionBuffer = `${urlDetectionBuffer}${cleanChunk}`.slice(-SHELL_URL_PARSE_BUFFER_LIMIT);

            outputData = outputData.replace(
              /OPEN_URL:\s*(https?:\/\/[^\s\x1b\x07]+)/g,
              '[INFO] Opening in browser: $1'
            );

            const emitAuthUrl = (detectedUrl: string, autoOpen = false) => {
              const normalizedUrl = dependencies.normalizeDetectedUrl(detectedUrl);
              if (!normalizedUrl) {
                return;
              }

              const isNewUrl = !announcedAuthUrls.has(normalizedUrl);
              if (isNewUrl) {
                announcedAuthUrls.add(normalizedUrl);
                session.ws?.send(
                  JSON.stringify({
                    type: 'auth_url',
                    url: normalizedUrl,
                    autoOpen,
                  })
                );
              }
            };

            const normalizedDetectedUrls = dependencies.extractUrlsFromText(urlDetectionBuffer)
              .map((url) => dependencies.normalizeDetectedUrl(url))
              .filter((url): url is string => Boolean(url));

            const dedupedDetectedUrls = Array.from(new Set(normalizedDetectedUrls)).filter(
              (url, _, urls) =>
                !urls.some((otherUrl) => otherUrl !== url && otherUrl.startsWith(url))
            );

            dedupedDetectedUrls.forEach((url) => emitAuthUrl(url, false));

            if (
              dependencies.shouldAutoOpenUrlFromOutput(cleanChunk) &&
              dedupedDetectedUrls.length > 0
            ) {
              const bestUrl = dedupedDetectedUrls.reduce((longest, current) =>
                current.length > longest.length ? current : longest
              );
              emitAuthUrl(bestUrl, true);
            }

            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: outputData,
              })
            );
          }
        });

        shellProcess.onExit((exitCode) => {
          if (!ptySessionKey) {
            return;
          }

          const session = ptySessionsMap.get(ptySessionKey);
          if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: `\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${
                  exitCode.signal != null ? ` (${exitCode.signal})` : ''
                }\x1b[0m\r\n`,
              })
            );
          }

          if (session?.timeoutId) {
            clearTimeout(session.timeoutId);
          }

          ptySessionsMap.delete(ptySessionKey);
          shellProcess = null;
        });

        if (tmuxName) {
          // tmux repaints the whole screen on attach; a banner would only flash.
          return;
        }

        let welcomeMsg = `\x1b[36mStarting terminal in: ${projectPath}\x1b[0m\r\n`;
        if (!isPlainShell) {
          const providerName =
            provider === 'cursor'
              ? 'Cursor'
              : provider === 'codex'
                ? 'Codex'
                : provider === 'gemini'
                  ? 'Gemini'
                  : provider === 'opencode'
                    ? 'OpenCode'
                  : 'Claude';
          welcomeMsg = hasSession
            ? `\x1b[36mResuming ${providerName} session ${sessionId} in: ${projectPath}\x1b[0m\r\n`
            : `\x1b[36mStarting new ${providerName} session in: ${projectPath}\x1b[0m\r\n`;
        }

        ws.send(
          JSON.stringify({
            type: 'output',
            data: welcomeMsg,
          })
        );
        return;
      }

      if (data.type === 'input') {
        if (shellProcess) {
          const input = readString(data.data);
          if (tmuxName) {
            leaveCopyModeBeforeTyping(tmuxName, input);
          }
          shellProcess.write(input);
        }
        return;
      }

      if (data.type === 'resize') {
        if (shellProcess) {
          shellProcess.resize(readNumber(data.cols, 80), readNumber(data.rows, 24));
          if (tmuxName) {
            resizeTmuxWindow(tmuxName, readNumber(data.cols, 80), readNumber(data.rows, 24));
          }
        }
        return;
      }

      if (data.type === 'scroll-bottom') {
        if (tmuxName) {
          cancelTmuxCopyMode(tmuxName);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Shell WebSocket error:', message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'output',
            data: `\r\n\x1b[31mError: ${message}\x1b[0m\r\n`,
          })
        );
      }
    }
  });

  ws.on('close', () => {
    watchConversation(null);
    if (!ptySessionKey) {
      return;
    }

    const session = ptySessionsMap.get(ptySessionKey);
    if (!session) {
      return;
    }

    session.ws = null;

    if (tmuxName) {
      // Only the tmux client goes away; the CLI keeps running in its session.
      if (trackedNewSession) {
        trackNewSessionClient(trackedNewSession.projectPath, trackedNewSession.sessionId, -1);
      }
      ptySessionsMap.delete(ptySessionKey);
      session.pty.kill();
      return;
    }

    session.timeoutId = setTimeout(() => {
      session.pty.kill();
      ptySessionsMap.delete(ptySessionKey as string);
    }, PTY_SESSION_TIMEOUT);
  });

  ws.on('error', (error) => {
    console.error('[ERROR] Shell WebSocket error:', error);
  });
}
