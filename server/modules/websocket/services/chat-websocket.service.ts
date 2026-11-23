import crypto from 'node:crypto';

import type { WebSocket } from 'ws';

import {
  connectedClients,
  registerSessionConnection,
  unregisterFromAllSessions,
} from '@/modules/websocket/services/websocket-state.service.js';
import { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';
import type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  LLMProvider,
} from '@/shared/types.js';
import { createNormalizedMessage, parseIncomingJsonObject } from '@/shared/utils.js';

type ChatIncomingMessage = AnyRecord & {
  type?: string;
  command?: string;
  options?: AnyRecord;
  provider?: string;
  sessionId?: string;
  requestId?: string;
  allow?: unknown;
  updatedInput?: unknown;
  message?: unknown;
  rememberEntry?: unknown;
};

const DEFAULT_PROVIDER: LLMProvider = 'claude';

type ChatWebSocketDependencies = {
  queryClaudeSDK: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnCursor: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  queryCodex: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnGemini: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  spawnOpenCode: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  queryAzure: (command: string, options: unknown, writer: WebSocketWriter) => Promise<unknown>;
  abortClaudeSDKSession: (sessionId: string) => Promise<boolean>;
  abortCursorSession: (sessionId: string) => boolean;
  abortCodexSession: (sessionId: string) => boolean;
  abortGeminiSession: (sessionId: string) => boolean;
  abortOpenCodeSession: (sessionId: string) => boolean;
  abortAzureSession: (sessionId: string) => boolean;
  resolveToolApproval: (
    requestId: string,
    payload: {
      allow: boolean;
      updatedInput?: unknown;
      message?: string;
      rememberEntry?: unknown;
    }
  ) => void;
  resolveSudoPassword: (
    requestId: string,
    payload: { password?: string; cancel?: boolean }
  ) => void;
  isClaudeSDKSessionActive: (sessionId: string) => boolean;
  isCursorSessionActive: (sessionId: string) => boolean;
  isCodexSessionActive: (sessionId: string) => boolean;
  isGeminiSessionActive: (sessionId: string) => boolean;
  isOpenCodeSessionActive: (sessionId: string) => boolean;
  isAzureSessionActive: (sessionId: string) => boolean;
  reconnectSessionWriter: (sessionId: string, ws: WebSocket) => boolean;
  getPendingApprovalsForSession: (sessionId: string) => unknown[];
  steerClaudeSDKSession?: (
    sessionId: string,
    messageId: string,
    content: string
  ) => { ok: boolean; reason?: string };
  listPendingSteers?: (sessionId: string) => Array<{ messageId: string; content: string }>;
  getActiveClaudeSDKSessions: () => unknown;
  getActiveCursorSessions: () => unknown;
  getActiveCodexSessions: () => unknown;
  getActiveGeminiSessions: () => unknown;
  getActiveOpenCodeSessions: () => unknown;
  getActiveAzureSessions: () => unknown;
};

/**
 * Normalizes potentially invalid provider names coming from websocket payloads.
 */
function readProvider(value: unknown): LLMProvider {
  if (value === 'claude' || value === 'cursor' || value === 'codex' || value === 'gemini' || value === 'opencode' || value === 'azure') {
    return value;
  }

  return DEFAULT_PROVIDER;
}

/**
 * Extracts the authenticated request user id in the formats currently produced
 * by platform and OSS auth code paths.
 */
function readRequestUserId(
  request: AuthenticatedWebSocketRequest | undefined
): string | number | null {
  const user = request?.user;
  if (!user) {
    return null;
  }

  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user.id;
  }

  if (typeof user.userId === 'string' || typeof user.userId === 'number') {
    return user.userId;
  }

  return null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SteerReplyWriter = { send: (data: unknown) => void };

/**
 * Hands a steered message to the running Claude turn and tells the sender how
 * it went. `pending` means the turn has it and will read it at its next tool
 * call (every tab watching the run also hears that, from the run itself);
 * `rejected` means there is no turn to join any more, and the sender sends it
 * as an ordinary next turn instead.
 *
 * The message id is the sender's: the CLI echoes it back when Claude reads the
 * message and history stores it under it, so it must be a UUID.
 */
export function handleSteerRequest(
  data: AnyRecord,
  writer: SteerReplyWriter,
  dependencies: Pick<ChatWebSocketDependencies, 'steerClaudeSDKSession'>
): void {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
  const rawContent = typeof data.command === 'string' ? data.command : data.content;
  const content = typeof rawContent === 'string' ? rawContent.trim() : '';
  const messageId = typeof data.messageId === 'string' && UUID_PATTERN.test(data.messageId)
    ? data.messageId
    : crypto.randomUUID();
  if (!content) {
    return;
  }

  const result = sessionId && dependencies.steerClaudeSDKSession
    ? dependencies.steerClaudeSDKSession(sessionId, messageId, content)
    : { ok: false, reason: 'no_active_turn' };

  writer.send({
    type: 'steer-status',
    state: result.ok ? 'pending' : 'rejected',
    ...(result.ok ? {} : { reason: result.reason || 'no_active_turn' }),
    sessionId,
    messageId,
    content,
  });
}

/**
 * Handles authenticated chat websocket messages used by the main chat panel.
 */
export function handleChatConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ChatWebSocketDependencies
): void {
  console.log('[INFO] Chat WebSocket connected');
  connectedClients.add(ws);

  const writer = new WebSocketWriter(ws, readRequestUserId(request));

  ws.on('message', async (rawMessage) => {
    try {
      const parsed = parseIncomingJsonObject(rawMessage);
      if (!parsed) {
        throw new Error('Invalid websocket payload');
      }

      const data = parsed as ChatIncomingMessage;
      const messageType = data.type;
      if (!messageType) {
        throw new Error('Message type is required');
      }

      // Liveness probe. A phone that resumed a backgrounded PWA can hold a
      // socket that still reports OPEN over a TCP connection the network has
      // already dropped: `send()` succeeds locally and the prompt is never
      // delivered. The client pings on resume and reconnects if no pong
      // arrives, so this has to answer before any provider dispatch.
      if (messageType === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        return;
      }

      if (messageType === 'claude-command') {
        await dependencies.queryClaudeSDK(data.command ?? '', data.options, writer);
        return;
      }

      if (messageType === 'cursor-command') {
        await dependencies.spawnCursor(data.command ?? '', data.options, writer);
        return;
      }

      if (messageType === 'codex-command') {
        await dependencies.queryCodex(data.command ?? '', data.options, writer);
        return;
      }

      if (messageType === 'gemini-command') {
        await dependencies.spawnGemini(data.command ?? '', data.options, writer);
        return;
      }

      if (messageType === 'opencode-command') {
        await dependencies.spawnOpenCode(data.command ?? '', data.options, writer);
        return;
      }

      if (messageType === 'azure-command') {
        await dependencies.queryAzure(data.command ?? '', data.options, writer);
        return;
      }

      if (messageType === 'cursor-resume') {
        await dependencies.spawnCursor(
          '',
          {
            sessionId: data.sessionId,
            resume: true,
            cwd: data.options?.cwd,
          },
          writer
        );
        return;
      }

      if (messageType === 'abort-session') {
        const provider = readProvider(data.provider);
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        let success = false;

        if (provider === 'cursor') {
          success = dependencies.abortCursorSession(sessionId);
        } else if (provider === 'codex') {
          success = dependencies.abortCodexSession(sessionId);
        } else if (provider === 'gemini') {
          success = dependencies.abortGeminiSession(sessionId);
        } else if (provider === 'opencode') {
          success = dependencies.abortOpenCodeSession(sessionId);
        } else if (provider === 'azure') {
          success = dependencies.abortAzureSession(sessionId);
        } else {
          success = await dependencies.abortClaudeSDKSession(sessionId);
        }

        writer.send(
          createNormalizedMessage({
            kind: 'complete',
            exitCode: success ? 0 : 1,
            aborted: true,
            success,
            sessionId,
            provider,
          })
        );
        return;
      }

      // A message sent while a Claude turn runs, delivered into that turn
      // ("steering"): Claude reads it at its next tool-call boundary. `btw-inject`
      // is the older `/btw` wire name for the same thing.
      if (messageType === 'claude-steer' || messageType === 'btw-inject') {
        handleSteerRequest(data, writer, dependencies);
        return;
      }

      if (messageType === 'claude-permission-response') {
        if (typeof data.requestId === 'string' && data.requestId.length > 0) {
          dependencies.resolveToolApproval(data.requestId, {
            allow: Boolean(data.allow),
            updatedInput: data.updatedInput,
            message: typeof data.message === 'string' ? data.message : undefined,
            rememberEntry: data.rememberEntry,
          });
        }
        return;
      }

      if (messageType === 'sudo-password-response') {
        if (typeof data.requestId === 'string' && data.requestId.length > 0) {
          dependencies.resolveSudoPassword(data.requestId, {
            password: typeof data.password === 'string' ? data.password : undefined,
            cancel: Boolean(data.cancel),
          });
        }
        return;
      }

      if (messageType === 'cursor-abort') {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        const success = dependencies.abortCursorSession(sessionId);
        writer.send(
          createNormalizedMessage({
            kind: 'complete',
            exitCode: success ? 0 : 1,
            aborted: true,
            success,
            sessionId,
            provider: 'cursor',
          })
        );
        return;
      }

      if (messageType === 'check-session-status') {
        const provider = readProvider(data.provider);
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        let isActive = false;

        if (provider === 'cursor') {
          isActive = dependencies.isCursorSessionActive(sessionId);
        } else if (provider === 'codex') {
          isActive = dependencies.isCodexSessionActive(sessionId);
        } else if (provider === 'gemini') {
          isActive = dependencies.isGeminiSessionActive(sessionId);
        } else if (provider === 'opencode') {
          isActive = dependencies.isOpenCodeSessionActive(sessionId);
        } else if (provider === 'azure') {
          isActive = dependencies.isAzureSessionActive(sessionId);
        } else {
          isActive = dependencies.isClaudeSDKSessionActive(sessionId);
        }

        // Register this window as a subscriber for the session's broadcast stream
        // so all open windows receive live events, not only the one that started the run.
        if (isActive && sessionId) {
          registerSessionConnection(sessionId, ws);
        }

        writer.send({
          type: 'session-status',
          sessionId,
          provider,
          isProcessing: isActive,
          // Steered messages the running turn has not read yet, so a tab that
          // opens mid-run shows them as pending like the tab that sent them.
          ...(provider === 'claude' && isActive && dependencies.listPendingSteers
            ? { pendingSteers: dependencies.listPendingSteers(sessionId) }
            : {}),
        });
        return;
      }

      if (messageType === 'get-pending-permissions') {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        if (sessionId && dependencies.isClaudeSDKSessionActive(sessionId)) {
          const pending = dependencies.getPendingApprovalsForSession(sessionId);
          writer.send({
            type: 'pending-permissions-response',
            sessionId,
            data: pending,
          });
        }
        return;
      }

      if (messageType === 'get-active-sessions') {
        writer.send({
          type: 'active-sessions',
          sessions: {
            claude: dependencies.getActiveClaudeSDKSessions(),
            cursor: dependencies.getActiveCursorSessions(),
            codex: dependencies.getActiveCodexSessions(),
            gemini: dependencies.getActiveGeminiSessions(),
            opencode: dependencies.getActiveOpenCodeSessions(),
            azure: dependencies.getActiveAzureSessions(),
          },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ERROR] Chat WebSocket error:', message);
      writer.send({
        type: 'error',
        error: message,
      });
    }
  });

  ws.on('close', () => {
    console.log('[INFO] Chat client disconnected');
    connectedClients.delete(ws);
    unregisterFromAllSessions(ws);
  });
}
