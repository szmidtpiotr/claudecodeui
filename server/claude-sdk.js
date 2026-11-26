/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import { spawn } from 'child_process';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { CLAUDE_FALLBACK_MODELS } from './modules/providers/list/claude/claude-models.provider.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { resolveClaudeCodeExecutablePath } from './shared/claude-cli-path.js';
import { registerSudoRun, unregisterSudoRun } from './modules/sudo-askpass/sudo-askpass.service.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from './services/notification-orchestrator.js';
import { sessionsService } from './modules/providers/services/sessions.service.js';
import { markSessionChangedByChat } from './modules/websocket/index.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import {
  configureDerivedSessionsRuntime,
  getParentSessionId,
  createDerivedSessionsMcpServer,
  derivedSessionsAllowedTools,
  DERIVED_SESSIONS_SERVER_NAME,
  rememberSessionRunOptions,
  releaseShellReports,
} from './modules/providers/index.js';
import {
  createNormalizedMessage,
  getReportedClaudeContextWindow,
  readReportedClaudeContextWindow,
  rememberClaudeContextWindow,
  resolveClaudeContextWindow
} from './shared/utils.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();
// Sessions the user stopped; their generator loop must not report the forced
// shutdown as an error or a normal completion.
const abortedSessionIds = new Set();
// How long a graceful interrupt() may take before the CLI process is killed.
// interrupt() never resolves once the turn's result has arrived and the CLI is
// only kept alive by a background task (e.g. a polling Bash loop).
const INTERRUPT_TIMEOUT_MS = 3000;

function createPushChannel() {
  const queue = [];
  let waitResolve = null;
  let closed = false;

  const channel = {
    push(message) {
      if (closed) return;
      queue.push(message);
      if (waitResolve) { const r = waitResolve; waitResolve = null; r(); }
    },
    close() {
      if (closed) return;
      closed = true;
      if (waitResolve) { const r = waitResolve; waitResolve = null; r(); }
    },
    get isClosed() { return closed; },
    iterable: null,
  };

  channel.iterable = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (queue.length === 0 && !closed) {
            await new Promise(r => { waitResolve = r; });
          }
          if (queue.length > 0) return { value: queue.shift(), done: false };
          return { value: undefined, done: true };
        }
      };
    }
  };

  return channel;
}

// How long a turn that ended with steered messages still unread keeps the CLI's
// input open for the follow-up turn the CLI runs them in. That turn starts within
// milliseconds of the `result`; the grace only bounds a CLI that dropped them, so
// the run is not left "processing" forever.
const STEER_FOLLOW_UP_GRACE_MS = 30 * 1000;

/**
 * Bookkeeping for messages steered into one running Claude query.
 *
 * A steered message is written to the CLI's still-open stdin with priority
 * `next`: the CLI reads it at the next tool-call boundary of the running turn,
 * or — if the turn ends first — runs it as a follow-up turn on the same process.
 * With `--replay-user-messages` the CLI echoes each message at the moment it
 * reads it; that echo (same uuid) is what marks a steered message delivered.
 *
 * @returns {{
 *   add: (messageId: string, content: string) => void,
 *   isSteered: (messageId: string) => boolean,
 *   markDelivered: (messageId: string) => boolean,
 *   pendingCount: () => number,
 *   listPending: () => Array<{ messageId: string, content: string }>,
 *   takePending: () => Array<{ messageId: string, content: string }>,
 * }}
 */
function createSteerTracker() {
  // Every id steered into this run; an echo of any other uuid (the turn's own
  // prompt, for one) is not ours to show.
  const steeredIds = new Set();
  // Steered messages the CLI has not read yet, in send order.
  const pending = new Map();

  return {
    add(messageId, content) {
      steeredIds.add(messageId);
      pending.set(messageId, content);
    },
    isSteered(messageId) {
      return steeredIds.has(messageId);
    },
    markDelivered(messageId) {
      return pending.delete(messageId);
    },
    pendingCount() {
      return pending.size;
    },
    listPending() {
      return [...pending].map(([messageId, content]) => ({ messageId, content }));
    },
    takePending() {
      const list = [...pending].map(([messageId, content]) => ({ messageId, content }));
      pending.clear();
      return list;
    },
  };
}

// Background work (Agent / Bash `run_in_background`, workflows) keeps the CLI's
// input open after the turn's `result`. Closing stdin is what lets the CLI wind
// down: in print mode it then waits for background tasks for at most
// CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS (default 600000 = 10 min, counted from
// the first idle moment after stdin closed) and kills whatever is still running.
// So while the run has background tasks we do not close it; this cap only
// bounds a CLI whose task list never empties.
const DEFAULT_BACKGROUND_HOLD_MAX_MS = 6 * 60 * 60 * 1000;
// After the last background task ends, the CLI runs its task-notification as a
// follow-up turn within a second or two. The run waits this long for that turn
// to start before closing the input (a task that ends without a notification
// must not leave the run "processing").
const DEFAULT_BACKGROUND_NOTIFICATION_GRACE_MS = 10 * 1000;
const backgroundHoldLimits = {
  maxMs: parseInt(process.env.CLAUDE_BACKGROUND_HOLD_MAX_MS, 10) || DEFAULT_BACKGROUND_HOLD_MAX_MS,
  notificationGraceMs: DEFAULT_BACKGROUND_NOTIFICATION_GRACE_MS,
};

// Task states after which a background task no longer runs.
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'error']);

/**
 * The CLI's background tasks for one run, kept from its stream:
 * `background_tasks_changed` carries the full current list (authoritative);
 * `task_started` adds one, and a terminal `task_updated` / `task_notification`
 * removes one, in case a list update is missed.
 *
 * @returns {{
 *   observe: (message: any) => { changed: boolean, ended: number },
 *   size: () => number,
 *   ids: () => string[],
 * }}
 */
function createBackgroundTaskTracker() {
  const tasks = new Map();

  const remove = (taskId) => (taskId && tasks.delete(taskId) ? 1 : 0);

  return {
    observe(message) {
      if (!message || message.type !== 'system') {
        return { changed: false, ended: 0 };
      }
      const before = tasks.size;
      let ended = 0;
      if (message.subtype === 'background_tasks_changed' && Array.isArray(message.tasks)) {
        const next = new Map();
        for (const task of message.tasks) {
          if (task && typeof task.task_id === 'string') {
            next.set(task.task_id, task);
          }
        }
        for (const taskId of tasks.keys()) {
          if (!next.has(taskId)) {
            ended += 1;
          }
        }
        const added = [...next.keys()].some((taskId) => !tasks.has(taskId));
        tasks.clear();
        for (const [taskId, task] of next) {
          tasks.set(taskId, task);
        }
        return { changed: added || ended > 0, ended };
      }
      if (message.subtype === 'task_started' && typeof message.task_id === 'string') {
        if (!tasks.has(message.task_id)) {
          tasks.set(message.task_id, { task_id: message.task_id, task_type: message.task_type });
        }
        return { changed: tasks.size !== before, ended: 0 };
      }
      const status = message.subtype === 'task_updated'
        ? message.patch?.status
        : message.subtype === 'task_notification' ? message.status : undefined;
      if (typeof status === 'string' && TERMINAL_TASK_STATUSES.has(status)) {
        ended = remove(message.task_id);
        return { changed: ended > 0, ended };
      }
      return { changed: false, ended: 0 };
    },
    size() {
      return tasks.size;
    },
    ids() {
      return [...tasks.keys()];
    },
  };
}

/**
 * Messages that mean the CLI is working on a turn (as opposed to idling
 * between turns while background tasks run).
 */
function isTurnActivity(message) {
  if (!message) return false;
  if (message.type === 'assistant' || message.type === 'stream_event') return true;
  if (message.type === 'user') return message.isReplay !== true;
  if (message.type === 'system') {
    return message.subtype === 'init' || message.subtype === 'thinking_tokens';
  }
  return false;
}

/**
 * Spawns the CLI exactly as the SDK's default does, and logs every exit so a
 * cut-off run is visible in the journal.
 * @param {() => { sessionId: string | null, reason: string }} describe
 */
function createLoggedClaudeSpawn(describe) {
  return (spawnOptions) => {
    const { command, args, cwd, env, signal } = spawnOptions;
    const debugStderr = Boolean(env?.DEBUG_CLAUDE_AGENT_SDK);
    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', debugStderr ? 'pipe' : 'ignore'],
      signal,
      env,
      windowsHide: true,
    });
    if (debugStderr) {
      child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
    }
    child.on('error', (error) => {
      if (error?.name !== 'AbortError') {
        console.warn(`[Claude SDK] CLI process error: ${error?.message || error}`);
      }
    });
    child.once('exit', (code, exitSignal) => {
      const { sessionId, reason } = describe();
      console.log(`[Claude SDK] CLI exited (code=${code}, signal=${exitSignal}, reason=${reason}) session=${sessionId || 'NEW'} pid=${child.pid}`);
    });
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      get killed() { return child.killed; },
      get exitCode() { return child.exitCode; },
      kill: child.kill.bind(child),
      on: child.on.bind(child),
      once: child.once.bind(child),
      off: child.off.bind(child),
    };
  };
}

/**
 * The user message pushed into a running turn's stdin for a steered message.
 * Priority `next` lets the turn carry on and read it at its next tool call
 * (`now` would cut the in-flight step short); the uuid is what the CLI's
 * replay echo carries back, and what history stores it under (`source_uuid`).
 */
function buildSteerUserMessage(messageId, content) {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    priority: 'next',
    uuid: messageId,
  };
}

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

// An MCP server's request for input travels as a permission request under this
// name. It is not a tool the model can call: the name routes the request to the
// client's McpElicitation panel and keys it in the pending-approval list, so a
// page refresh replays it like any other prompt.
const MCP_ELICITATION_TOOL_NAME = 'McpElicitation';

/**
 * Turns the client's answer to an McpElicitation request into the MCP result.
 * The panel accepts with `updatedInput.content` and declines with a denial. No
 * answer at all (an abort, a closed run) is `cancel`, never an invented accept.
 */
function toElicitationResult(decision, mode) {
  if (!decision || decision.cancelled) {
    return { action: 'cancel' };
  }
  if (!decision.allow) {
    return { action: 'decline' };
  }
  // A URL request is accepted without content: accepting is consent to open
  // the page, and the server learns the outcome from the page itself.
  if (mode === 'url') {
    return { action: 'accept' };
  }
  const content = decision.updatedInput?.content;
  const fields = {};
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    for (const [key, value] of Object.entries(content)) {
      // Form fields are flat primitives, or string lists for multi-select.
      const isPrimitive = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
      const isStringList = Array.isArray(value) && value.every((item) => typeof item === 'string');
      if (isPrimitive || isStringList) {
        fields[key] = value;
      }
    }
  }
  return { action: 'accept', content: fields };
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

/**
 * Environment for the spawned CLI. Forwards all host env vars (e.g. ANTHROPIC_BASE_URL);
 * since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
 *
 * Claude Code turns the Artifact tools off for SDK-driven sessions unless
 * CLAUDE_CODE_ARTIFACT is set, so a session continued from this UI would lose them.
 * Default it on; a host value (e.g. CLAUDE_CODE_ARTIFACT=0) still wins.
 *
 * @param {Record<string, string | undefined>} [hostEnv]
 * @returns {Record<string, string | undefined>}
 */
function buildClaudeSdkEnv(hostEnv = process.env) {
  return {
    CLAUDE_CODE_ARTIFACT: '1',
    CLAUDE_CODE_ENTRYPOINT: 'claudecodeui',
    ...hostEnv,
  };
}

/**
 * Maps CLI options to SDK-compatible options format
 * @param {Object} options - CLI options
 * @returns {Object} SDK-compatible options
 */
function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_FALLBACK_MODELS) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values?.map((v) => v.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

function mapCliOptionsToSDK(options = {}) {
  const { sessionId, newSessionId, cwd, toolsSettings, permissionMode, effort } = options;

  const sdkOptions = {};

  sdkOptions.env = buildClaudeSdkEnv();

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  sdkOptions.pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);

  // Map working directory
  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  // Map permission mode
  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  // Map tool settings
  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  // Handle tool permissions
  if (settings.skipPermissions && permissionMode !== 'plan') {
    // When skipping permissions, use bypassPermissions mode
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  // Add plan mode default tools
  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_FALLBACK_MODELS.DEFAULT;

  const resolvedEffort = resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_FALLBACK_MODELS,
  );
  if (resolvedEffort) {
    sdkOptions.effort = resolvedEffort;
  }

  // Map system prompt configuration
  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'  // Required to use CLAUDE.md
  };

  // Append image-saving guidance so Claude stores generated images inside the project tree,
  // where the file-serving endpoint can reach them.
  sdkOptions.appendSystemPrompt =
    'When you generate or create image files that you want to display to the user, ' +
    'save them inside the current project directory under a "temp-img/" subfolder ' +
    '(e.g. "temp-img/output.png", "temp-img/chart.png"). ' +
    'Do NOT save them to /tmp or any path outside the project directory. ' +
    'The UI automatically renders images stored within the project directory as inline images in the chat.';

  // Map setting sources for CLAUDE.md loading
  // This loads CLAUDE.md from project, user (~/.config/claude/CLAUDE.md), and local directories
  sdkOptions.settingSources = ['project', 'user', 'local'];

  // Map resume session
  if (sessionId) {
    sdkOptions.resume = sessionId;
  } else if (newSessionId) {
    // A new session under an id chosen up front (derived sessions record it
    // before the run starts).
    sdkOptions.sessionId = newSessionId;
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Array<string>} tempImagePaths - Temp image file paths for cleanup
 * @param {string} tempDir - Temp directory for cleanup
 */
function addSession(sessionId, queryInstance, tempImagePaths = [], tempDir = null, writer = null, pushChannel = null, steer = null, extras = {}) {
  activeSessions.set(sessionId, {
    // backgroundTaskCount(): background tasks the CLI is running right now.
    ...extras,
    instance: queryInstance,
    startTime: Date.now(),
    status: 'active',
    tempImagePaths,
    tempDir,
    writer,
    pushChannel,
    // { into(messageId, content), tracker } — delivers a message into the
    // running turn; see steerClaudeSDKSession.
    steer,
  });
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Extracts token usage from SDK messages.
 * Prefers per-step `message.usage` (Claude message payload), then falls back
 * to result-level usage/modelUsage for compatibility across SDK versions.
 * @param {Object} sdkMessage - SDK stream message
 * @param {number|null} [reportedContextWindow] - SDK-reported window for the session's model
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage, reportedContextWindow) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage || sdkMessage.usage;
  if (messageUsage && typeof messageUsage === 'object') {
    const inputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
    const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
    const totalUsed = inputTokens + outputTokens;
    const contextWindow = resolveClaudeContextWindow(reportedContextWindow);

    return {
      used: totalUsed,
      total: contextWindow,
      inputTokens,
      outputTokens,
      breakdown: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = resolveClaudeContextWindow(reportedContextWindow);

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Handles image processing for SDK queries
 * Saves base64 images to temporary files and returns modified prompt with file paths
 * @param {string} command - Original user prompt
 * @param {Array} images - Array of image objects with base64 data
 * @param {string} cwd - Working directory for temp file creation
 * @returns {Promise<Object>} {modifiedCommand, tempImagePaths, tempDir}
 */
async function handleImages(command, images, cwd) {
  const tempImagePaths = [];
  let tempDir = null;

  if (!images || images.length === 0) {
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }

  try {
    // Create persistent image directory in the project directory
    const workingDir = cwd || process.cwd();
    tempDir = path.join(workingDir, 'temp-img', Date.now().toString());
    await fs.mkdir(tempDir, { recursive: true });

    // Save each image to a temp file
    for (const [index, image] of images.entries()) {
      // Extract base64 data and mime type
      const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        console.error('Invalid image data format');
        continue;
      }

      const [, mimeType, base64Data] = matches;
      const extension = mimeType.split('/')[1] || 'png';
      const filename = `image_${index}.${extension}`;
      const filepath = path.join(tempDir, filename);

      // Write base64 data to file
      await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
      tempImagePaths.push(filepath);
    }

    // Include the full image paths in the prompt
    let modifiedCommand = command;
    if (tempImagePaths.length > 0 && command && command.trim()) {
      const imageNote = `\n\n[Images provided at the following paths:]\n${tempImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
      modifiedCommand = command + imageNote;
    }

    // Images processed
    return { modifiedCommand, tempImagePaths, tempDir };
  } catch (error) {
    console.error('Error processing images for SDK:', error);
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }
}

/**
 * Cleans up temporary image files
 * @param {Array<string>} tempImagePaths - Array of temp file paths to delete
 * @param {string} tempDir - Temp directory to remove
 */
async function cleanupTempFiles(_tempImagePaths, _tempDir) {
  // Images saved to temp-img/ are kept for display in chat — no cleanup.
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws) {
  const { sessionId, sessionSummary } = options;
  // `newSessionId`: start a new session under this id (no resume).
  let capturedSessionId = sessionId || options.newSessionId || null;
  // A terminal still open on this conversation holds its own copy of the
  // history and will not see this turn; have the Shell tab restart it.
  if (sessionId) {
    markSessionChangedByChat(sessionId);
  }
  if (capturedSessionId) {
    rememberSessionRunOptions(capturedSessionId, options);
  }
  let sessionCreatedSent = false;
  let tempImagePaths = [];
  let tempDir = null;
  let sudoToken = null;

  // Messages steered into this run (see steerClaudeSDKSession).
  const steerTracker = createSteerTracker();
  let steerFollowUpTimer = null;
  const clearSteerFollowUpTimer = () => {
    if (steerFollowUpTimer) {
      clearTimeout(steerFollowUpTimer);
      steerFollowUpTimer = null;
    }
  };
  // Tells every tab watching the run that steered messages will not be read,
  // so the tab that sent them can put the text back into its composer.
  const reportDroppedSteers = (reason) => {
    for (const { messageId, content } of steerTracker.takePending()) {
      ws.send({ type: 'steer-status', state: 'dropped', reason, sessionId: capturedSessionId || sessionId || null, messageId, content });
    }
  };

  // Background tasks the CLI runs for this session, and whether it is between
  // turns. While any task runs, the CLI's input stays open (see
  // DEFAULT_BACKGROUND_HOLD_MAX_MS) so the work survives and its notification
  // turn streams here.
  const backgroundTasks = createBackgroundTaskTracker();
  let turnIdle = false;
  // A background task ended since the current turn started: its notification
  // turn is probably queued.
  let taskEndedSinceTurnStart = false;
  let heldTaskCount = 0;
  let holdCapTimer = null;
  let notificationGraceTimer = null;
  // Why the CLI's input was closed; logged when the process exits.
  let inputCloseReason = 'input still open';
  const clearHoldTimers = () => {
    if (holdCapTimer) {
      clearTimeout(holdCapTimer);
      holdCapTimer = null;
    }
    if (notificationGraceTimer) {
      clearTimeout(notificationGraceTimer);
      notificationGraceTimer = null;
    }
  };

  const emitNotification = (event) => {
    notifyUserIfEnabled({
      userId: ws?.userId || null,
      writer: ws,
      event
    });
  };

  try {
    const resolvedModel = await providerModelsService.resolveResumeModel(
      'claude',
      sessionId,
      options.model,
    );

    // Map CLI options to SDK format
    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      model: resolvedModel || options.model,
    });

    // Allow the agent's sudo commands to prompt for a password via the chat UI
    const sudoRun = registerSudoRun(ws, capturedSessionId || sessionId, 'claude');
    sudoToken = sudoRun.token;
    sdkOptions.env = { ...sdkOptions.env, ...sudoRun.env };

    // Load MCP configuration
    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    // Lets the agent create derived (forked) sessions when the user asks for
    // one. Only for chat runs: an unattended run never gets it.
    // A run in a session that has a parent (a resume, or a derived session's
    // first turn under its recorded id) also gets send_to_parent_session —
    // whether the turn was started by the user in the browser or by the server.
    if (!options.unattended) {
      const parentSessionId = getParentSessionId(capturedSessionId);
      sdkOptions.mcpServers = {
        ...(sdkOptions.mcpServers || {}),
        [DERIVED_SESSIONS_SERVER_NAME]: createDerivedSessionsMcpServer({
          getCurrentSessionId: () => capturedSessionId || sessionId || null,
          parentOptions: options,
          userId: ws?.userId ?? null,
          parentSessionId,
        }),
      };
      sdkOptions.allowedTools = [...sdkOptions.allowedTools, ...derivedSessionsAllowedTools(Boolean(parentSessionId))];
    }

    // Handle images - save to temp files and modify prompt
    const imageResult = await handleImages(command, options.images, options.cwd);
    const finalCommand = imageResult.modifiedCommand;
    tempImagePaths = imageResult.tempImagePaths;
    tempDir = imageResult.tempDir;

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: capturedSessionId || sessionId || null,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${capturedSessionId || sessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);

      if (!requiresInteraction) {
        if (sdkOptions.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (sdkOptions.disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (sdkOptions.allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      const requestId = createRequestId();
      ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: capturedSessionId || sessionId || null,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${capturedSessionId || sessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          _sessionId: capturedSessionId || sessionId || null,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!sdkOptions.allowedTools.includes(decision.rememberEntry)) {
            sdkOptions.allowedTools.push(decision.rememberEntry);
          }
          if (Array.isArray(sdkOptions.disallowedTools)) {
            sdkOptions.disallowedTools = sdkOptions.disallowedTools.filter(entry => entry !== decision.rememberEntry);
          }
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    // An MCP server asking the person for input mid-call ("elicitation"). The
    // CLI declares form and URL elicitation support to every server, and without
    // this callback the SDK answers each request with `decline` itself — the
    // server is told a person refused when nobody was shown anything. The
    // request takes the permission round trip so it reaches the chat UI,
    // survives a refresh (pending-approval replay) and raises a notification.
    // There is no timeout here: the server keeps its own, and an abort arrives
    // through the signal. An unattended run (the agent API, commit-message
    // generation) has nobody to show the form to, so it leaves the callback
    // unset and the SDK declines at once instead of the run hanging.
    if (!options.unattended) {
      sdkOptions.onElicitation = async (request, elicitationOptions) => {
        const requestId = createRequestId();
        const input = {
          serverName: request.serverName,
          message: request.message,
          mode: request.mode ?? 'form',
          requestedSchema: request.requestedSchema,
          url: request.url,
          elicitationId: request.elicitationId,
          title: request.title,
          displayName: request.displayName,
          description: request.description,
        };
        const serverLabel = request.displayName || request.serverName;
        ws.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName: MCP_ELICITATION_TOOL_NAME, input, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        emitNotification(createNotificationEvent({
          provider: 'claude',
          sessionId: capturedSessionId || sessionId || null,
          kind: 'action_required',
          code: 'agent.notification',
          meta: { message: `${serverLabel} asks: ${request.message}`, sessionName: sessionSummary },
          severity: 'warning',
          requiresUserAction: true,
          dedupeKey: `claude:elicitation:${capturedSessionId || sessionId || 'none'}:${requestId}`
        }));

        const decision = await waitForToolApproval(requestId, {
          timeoutMs: 0,
          signal: elicitationOptions?.signal,
          metadata: {
            _sessionId: capturedSessionId || sessionId || null,
            _toolName: MCP_ELICITATION_TOOL_NAME,
            _input: input,
            _receivedAt: new Date(),
          },
          onCancel: (reason) => {
            ws.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
          }
        });
        return toElicitationResult(decision, request.mode);
      };
    }

    // Makes the CLI echo each message it reads from stdin, at the moment it
    // reads it. For a steered message that echo is the only word on when — and
    // whether — Claude actually took it in; the loop below drops every other
    // echo, so nothing else changes on screen.
    sdkOptions.extraArgs = { ...(sdkOptions.extraArgs || {}), 'replay-user-messages': null };

    // Same spawn as the SDK's own, plus a journal line for every CLI exit.
    sdkOptions.spawnClaudeCodeProcess = createLoggedClaudeSpawn(() => ({
      sessionId: capturedSessionId || sessionId || null,
      reason: capturedSessionId && abortedSessionIds.has(capturedSessionId) ? 'stopped by user' : inputCloseReason,
    }));

    // Create a push channel so this turn runs in streaming-input mode: the
    // CLI's stdin stays open while the turn runs, so a message the user sends
    // meanwhile can be steered into it (see steerClaudeSDKSession).
    const pushChannel = createPushChannel();
    pushChannel.push({
      type: 'user',
      message: { role: 'user', content: finalCommand },
      parent_tool_use_id: null,
      shouldQuery: true,
      // A caller-chosen id for the prompt row (derived-session reports), so
      // the copy shown live and the one in history are the same message.
      ...(typeof options.promptUuid === 'string' && options.promptUuid ? { uuid: options.promptUuid } : {}),
    });

    const closeInput = (reason) => {
      clearSteerFollowUpTimer();
      clearHoldTimers();
      if (pushChannel.isClosed) return;
      inputCloseReason = reason;
      pushChannel.close();
    };

    // Decides, whenever the CLI is between turns, whether its input may close.
    // Order matters: a Stop closes at once; running background tasks hold it
    // open (a steer then simply starts the next turn on this process); unread
    // steers and a just-finished task's notification get a short grace for the
    // follow-up turn they start; otherwise the run is over.
    const settleInput = () => {
      if (pushChannel.isClosed || !turnIdle) return;
      if (capturedSessionId && abortedSessionIds.has(capturedSessionId)) {
        closeInput('stopped by user');
        return;
      }
      const taskCount = backgroundTasks.size();
      if (taskCount > 0) {
        if (notificationGraceTimer) {
          clearTimeout(notificationGraceTimer);
          notificationGraceTimer = null;
        }
        if (taskCount !== heldTaskCount) {
          heldTaskCount = taskCount;
          console.log(`[Claude SDK] keeping CLI alive for ${taskCount} background task(s) session=${capturedSessionId || sessionId || 'NEW'} tasks=${backgroundTasks.ids().join(',')}`);
          ws.send(createNormalizedMessage({
            kind: 'status',
            text: `Waiting for ${taskCount} background task${taskCount === 1 ? '' : 's'}`,
            sessionId: capturedSessionId || sessionId || null,
            provider: 'claude',
            canInterrupt: true,
          }));
        }
        if (!holdCapTimer) {
          holdCapTimer = setTimeout(() => {
            holdCapTimer = null;
            console.warn(`[Claude SDK] background hold limit (${backgroundHoldLimits.maxMs} ms) reached for session ${capturedSessionId}; closing the CLI input with ${backgroundTasks.size()} task(s) still running.`);
            closeInput('background hold limit reached');
          }, backgroundHoldLimits.maxMs);
          holdCapTimer.unref?.();
        }
        return;
      }
      heldTaskCount = 0;
      if (holdCapTimer) {
        clearTimeout(holdCapTimer);
        holdCapTimer = null;
      }
      if (steerTracker.pendingCount() > 0) {
        if (!steerFollowUpTimer) {
          steerFollowUpTimer = setTimeout(() => {
            steerFollowUpTimer = null;
            console.warn(`[Claude SDK] Steered message(s) never started a follow-up turn for session ${capturedSessionId}; ending the run.`);
            reportDroppedSteers('not_read');
            closeInput('steered message not read');
          }, STEER_FOLLOW_UP_GRACE_MS);
          steerFollowUpTimer.unref?.();
        }
        return;
      }
      if (taskEndedSinceTurnStart) {
        if (!notificationGraceTimer) {
          notificationGraceTimer = setTimeout(() => {
            notificationGraceTimer = null;
            closeInput('background tasks ended, no follow-up turn');
          }, backgroundHoldLimits.notificationGraceMs);
          notificationGraceTimer.unref?.();
        }
        return;
      }
      closeInput('turn done, no background tasks');
    };

    const steer = {
      tracker: steerTracker,
      reportDropped: reportDroppedSteers,
      // Writes one more user message into the running turn. Refused once the
      // CLI's input is closed — the turn is over and the message can only
      // start a new one, which is the client's to send.
      into(messageId, content) {
        if (pushChannel.isClosed) {
          return { ok: false, reason: 'turn_ended' };
        }
        steerTracker.add(messageId, content);
        pushChannel.push(buildSteerUserMessage(messageId, content));
        ws.send({ type: 'steer-status', state: 'pending', sessionId: capturedSessionId || sessionId || null, messageId, content });
        return { ok: true };
      },
    };

    let queryInstance;
    try {
      queryInstance = queryImpl({
        prompt: pushChannel.iterable,
        options: sdkOptions
      });
    } catch (hookError) {
      // Older/newer SDK versions may not accept hook shapes yet.
      // Keep notification behavior operational via runtime events even if hook registration fails.
      console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
      delete sdkOptions.hooks;
      queryInstance = queryImpl({
        prompt: pushChannel.iterable,
        options: sdkOptions
      });
    }

    // Track the query instance and push channel for abort + steering
    const sessionExtras = { backgroundTaskCount: () => backgroundTasks.size(), cwd: options.cwd || null };
    if (capturedSessionId) {
      addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws, pushChannel, steer, sessionExtras);
      // Reports that waited while the conversation was open in a terminal
      // join this turn (no-op when none wait).
      releaseShellReports(capturedSessionId);
    }

    // Process streaming messages
    console.log('Starting async generator loop for session:', capturedSessionId || 'NEW');
    let compactionOccurred = false;
    let finalResultText = null;
    // The window the SDK reported for this session's model (a resumed session
    // starts from the one its last run reported) and the model the main
    // thread's assistant rows name, used to pick the right modelUsage entry.
    let reportedContextWindow = getReportedClaudeContextWindow(sessionId) ?? null;
    let mainThreadModel = null;
    for await (const message of queryInstance) {
      if (
        message.type === 'assistant'
        && !message.parent_tool_use_id
        && typeof message.message?.model === 'string'
        && message.message.model !== '<synthetic>'
      ) {
        mainThreadModel = message.message.model;
      }

      // A new turn started on this process (a steered message's follow-up, a
      // background task's notification): its own `result` settles the input.
      if (turnIdle && isTurnActivity(message)) {
        turnIdle = false;
        taskEndedSinceTurnStart = false;
        clearSteerFollowUpTimer();
        if (notificationGraceTimer) {
          clearTimeout(notificationGraceTimer);
          notificationGraceTimer = null;
        }
      }

      // Background task bookkeeping; a change while idle may end the run.
      const taskChange = backgroundTasks.observe(message);
      if (taskChange.ended > 0) {
        taskEndedSinceTurnStart = true;
      }
      if (taskChange.changed) {
        settleInput();
      }

      // The turn is over. Close the CLI's input so the iterator ends cleanly —
      // unless background tasks still run (closing would start the CLI's
      // 10-minute wind-down and kill them) or steered messages are unread
      // (the CLI runs them as a follow-up turn, which needs stdin open).
      if (message.type === 'result') {
        turnIdle = true;
        clearSteerFollowUpTimer();
        settleInput();
      }

      // Capture session ID from first message
      if (message.session_id && !capturedSessionId) {

        capturedSessionId = message.session_id;
        addSession(capturedSessionId, queryInstance, tempImagePaths, tempDir, ws, pushChannel, steer, sessionExtras);
        rememberSessionRunOptions(capturedSessionId, options);
        releaseShellReports(capturedSessionId);

        // Set session ID on writer
        if (ws.setSessionId && typeof ws.setSessionId === 'function') {
          ws.setSessionId(capturedSessionId);
        }

        // Send session-created event only once for new sessions
        if (!sessionId && !sessionCreatedSent) {
          sessionCreatedSent = true;
          ws.send(createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: 'claude' }));
        }
      } else {
        // session_id already captured
      }

      // The CLI's echo of a message it read from stdin (see `extraArgs`). Only
      // steered messages are shown — the turn's own prompt is on screen already.
      if (message.type === 'user' && message.isReplay === true) {
        const echoedId = typeof message.uuid === 'string' ? message.uuid : '';
        if (steerTracker.isSteered(echoedId)) {
          steerTracker.markDelivered(echoedId);
          const echoSessionId = capturedSessionId || sessionId || null;
          // Shown now, where Claude read it, on every tab watching the run.
          // The normalized id is the uuid it was sent with, which is also the
          // id history gives it, so live and reloaded views reconcile.
          for (const steered of sessionsService.normalizeMessage('claude', message, echoSessionId)) {
            ws.send(steered);
          }
          ws.send({ type: 'steer-status', state: 'delivered', sessionId: echoSessionId, messageId: echoedId });
        }
        continue;
      }

      // Transform and normalize message via adapter
      const transformedMessage = transformMessage(message);
      const sid = capturedSessionId || sessionId || null;

      // Use adapter to normalize SDK events into NormalizedMessage[]
      const normalized = sessionsService.normalizeMessage('claude', transformedMessage, sid);
      for (const msg of normalized) {
        // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
        if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
          msg.parentToolUseId = transformedMessage.parentToolUseId;
        }
        ws.send(msg);
      }

      // Track compaction so the result's high token count doesn't stay pinned at 100%
      if (message.type === 'system' && message.subtype === 'status' && message.status === 'compacting') {
        compactionOccurred = true;
      }

      // Extract and send token budget updates from result messages
      if (message.type === 'result') {
        // Capture the final assistant text for the completion notification.
        if (typeof message.result === 'string' && message.result.trim()) {
          finalResultText = message.result.trim();
        }
        const models = Object.keys(message.modelUsage || {});
        if (models.length > 0) {
          // Model info available in result message
        }
        // Only a turn's `result` states the window of the model that served it.
        const turnContextWindow = readReportedClaudeContextWindow(message, mainThreadModel);
        if (turnContextWindow) {
          reportedContextWindow = turnContextWindow;
          rememberClaudeContextWindow(message.session_id || capturedSessionId, turnContextWindow);
        }
        const tokenBudgetData = extractTokenBudget(message, reportedContextWindow);
        if (tokenBudgetData) {
          // After compaction the result shows the tokens used TO DO the compaction (all
          // old context as input), which reads as 100%.  Send used:0 so the indicator
          // resets; the accurate new context size appears after the next user turn.
          const budgetToSend = compactionOccurred
            ? { used: 0, total: tokenBudgetData.total }
            : tokenBudgetData;
          ws.send(createNormalizedMessage({ kind: 'status', text: 'token_budget', tokenBudget: budgetToSend, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
        }
      }
    }

    // Clean up session on completion
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    // Anything steered that the CLI never read is not going to be now.
    reportDroppedSteers(capturedSessionId && abortedSessionIds.has(capturedSessionId) ? 'aborted' : 'turn_ended');

    // Clean up temporary image files
    await cleanupTempFiles(tempImagePaths, tempDir);

    // A user stop already sent its own 'complete' from the abort handler
    if (capturedSessionId && abortedSessionIds.delete(capturedSessionId)) {
      inputCloseReason = 'stopped by user';
      return { status: 'aborted', sessionId: capturedSessionId, resultText: finalResultText };
    }

    // Send completion event
    ws.send(createNormalizedMessage({ kind: 'complete', exitCode: 0, isNewSession: !sessionId && !!command, sessionId: capturedSessionId, provider: 'claude' }));
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      stopReason: 'completed',
      summary: finalResultText
    });
    return { status: 'completed', sessionId: capturedSessionId || sessionId || null, resultText: finalResultText };

  } catch (error) {
    console.error('SDK query error:', error);

    // Clean up session on error
    if (capturedSessionId) {
      removeSession(capturedSessionId);
    }

    reportDroppedSteers(capturedSessionId && abortedSessionIds.has(capturedSessionId) ? 'aborted' : 'error');

    // Clean up temporary image files on error
    await cleanupTempFiles(tempImagePaths, tempDir);

    // The process was killed because the user pressed Stop — not a failure
    if (capturedSessionId && abortedSessionIds.delete(capturedSessionId)) {
      inputCloseReason = 'stopped by user';
      return { status: 'aborted', sessionId: capturedSessionId, resultText: null };
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await providerAuthService.isProviderInstalled('claude');
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : error.message;

    // Send error to WebSocket
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: capturedSessionId || sessionId || null, provider: 'claude' }));
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: capturedSessionId || sessionId || null,
      sessionName: sessionSummary,
      error
    });
    return { status: 'error', sessionId: capturedSessionId || sessionId || null, error: errorContent };
  } finally {
    clearSteerFollowUpTimer();
    clearHoldTimers();
    unregisterSudoRun(sudoToken);
  }
}

/**
 * Aborts an active SDK session
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was aborted, false if not found
 */
async function abortClaudeSDKSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    abortedSessionIds.add(sessionId);

    // Ask the CLI to stop gracefully; if it does not answer in time (it never
    // does while only a background task keeps it alive), kill the process.
    let timer;
    const interrupted = await Promise.race([
      Promise.resolve()
        .then(() => session.instance.interrupt())
        .then(() => true, (err) => {
          console.warn(`interrupt() failed for ${sessionId}:`, err?.message || err);
          return false;
        }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), INTERRUPT_TIMEOUT_MS); }),
    ]);
    clearTimeout(timer);

    // interrupt() ends the turn but leaves background tasks running, and the
    // input is held open for them — Stop must end those too.
    const backgroundCount = session.backgroundTaskCount?.() ?? 0;
    if (!interrupted || backgroundCount > 0) {
      console.log(interrupted
        ? `Stopping ${backgroundCount} background task(s) for ${sessionId}, closing the CLI process`
        : `interrupt() did not finish for ${sessionId}, closing the CLI process`);
      try {
        session.instance.close();
      } catch (err) {
        console.warn(`close() failed for ${sessionId}:`, err?.message || err);
      }
    }

    // A stop leaves steered messages unread; the tab that sent them puts the
    // text back into its composer.
    session.steer?.reportDropped('aborted');

    // Close push channel so the streaming-input iterator terminates cleanly
    session.pushChannel?.close();

    // Update session status
    session.status = 'aborted';

    // Clean up temporary image files
    await cleanupTempFiles(session.tempImagePaths, session.tempDir);

    // Clean up session
    removeSession(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    return false;
  }
}

/**
 * Checks if an SDK session is currently active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  const session = getSession(sessionId);
  return session && session.status === 'active';
}

/**
 * Gets all active SDK session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return getAllSessions();
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

/**
 * Delivers a user message into a session's running turn ("steering"): Claude
 * reads it at its next tool-call boundary and carries on with it in mind,
 * nothing stopped. A turn that ends before another tool call reads it in a
 * follow-up turn on the same process, and the run is not reported complete
 * until it has.
 *
 * Refused when the session has no live run or its CLI input is already closed
 * (the turn is over): the message could only start a new turn then, which is
 * the caller's to send.
 * @param {string} sessionId - Claude session id of the running query
 * @param {string} messageId - Client-chosen UUID the message is tracked by
 * @param {string} content - Message text
 * @returns {{ ok: boolean, reason?: string }}
 */
function steerClaudeSDKSession(sessionId, messageId, content) {
  const session = getSession(sessionId);
  if (!session || session.status !== 'active' || !session.steer) {
    return { ok: false, reason: 'no_active_turn' };
  }
  return session.steer.into(messageId, content);
}

/**
 * Steers a message that carries images: the images are saved the same way an
 * ordinary send saves them (temp-img/ in the run's working directory) and their
 * paths are appended to the text, which is what the CLI input can carry.
 * @param {string} sessionId
 * @param {string} messageId
 * @param {string} content
 * @param {Array<{data: string}>} images - data-URL images, as an ordinary send uploads them
 * @returns {Promise<{ ok: boolean, reason?: string, content: string }>}
 */
async function steerClaudeSDKSessionWithImages(sessionId, messageId, content, images) {
  const session = getSession(sessionId);
  if (!session || session.status !== 'active' || !session.steer) {
    return { ok: false, reason: 'no_active_turn', content };
  }
  let finalContent = content;
  if (Array.isArray(images) && images.length > 0) {
    const { modifiedCommand } = await handleImages(content, images, session.cwd || undefined);
    finalContent = modifiedCommand || content;
  }
  return { ...steerClaudeSDKSession(sessionId, messageId, finalContent), content: finalContent };
}

/**
 * Steered messages a session's running turn has not read yet, so a tab that
 * opens (or reloads) mid-run can show them as pending.
 * @param {string} sessionId
 * @returns {Array<{ messageId: string, content: string }>}
 */
function listPendingSteers(sessionId) {
  return getSession(sessionId)?.steer?.tracker.listPending() ?? [];
}

/**
 * Kept for the `/btw` wire message older clients still send: it is now plain
 * steering under a server-chosen id.
 * @param {string} sessionId
 * @param {string} content
 * @returns {{ ok: boolean, reason?: string }}
 */
function injectBtwMessage(sessionId, content) {
  return steerClaudeSDKSession(sessionId, createRequestId(), content);
}

// Derived sessions started by the agent run their turns (and their reports
// back to the parent) through this runner.
configureDerivedSessionsRuntime({
  runHeadless: (prompt, options, writer) => queryClaudeSDK(prompt, options, writer),
  isSessionActive: (id) => Boolean(isClaudeSDKSessionActive(id)),
  steer: (id, messageId, content) => steerClaudeSDKSession(id, messageId, content),
});

// The SDK entry point; swapped only by tests, which drive the run loop with a
// scripted CLI instead of a real process.
let queryImpl = query;
function setClaudeQueryImplForTests(impl) {
  queryImpl = impl || query;
}
// Shortens the background-hold limits for tests; no argument restores them.
function setBackgroundHoldLimitsForTests(limits) {
  backgroundHoldLimits.maxMs = limits?.maxMs
    ?? (parseInt(process.env.CLAUDE_BACKGROUND_HOLD_MAX_MS, 10) || DEFAULT_BACKGROUND_HOLD_MAX_MS);
  backgroundHoldLimits.notificationGraceMs = limits?.notificationGraceMs ?? DEFAULT_BACKGROUND_NOTIFICATION_GRACE_MS;
}

// Export public API
export {
  buildClaudeSdkEnv,
  queryClaudeSDK,
  abortClaudeSDKSession,
  injectBtwMessage,
  steerClaudeSDKSession,
  steerClaudeSDKSessionWithImages,
  listPendingSteers,
  createSteerTracker,
  createPushChannel,
  createBackgroundTaskTracker,
  setClaudeQueryImplForTests,
  setBackgroundHoldLimitsForTests,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  toElicitationResult,
  getPendingApprovalsForSession,
  reconnectSessionWriter
};
