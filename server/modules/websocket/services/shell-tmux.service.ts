import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Keeps agent terminals of the Shell tab inside tmux, so the CLI survives a
 * closed browser tab, a sleeping phone and a restart of this server. The Shell
 * websocket spawns a tmux *client* per connection; the session itself lives in
 * the tmux server. Two devices opening the same session attach to the same
 * tmux session and see the same screen.
 *
 * A dedicated tmux socket (`-L ccui`) keeps these sessions apart from tmux
 * sessions the user runs by hand.
 */

const TMUX_SOCKET = process.env.SHELL_TMUX_SOCKET || 'ccui';
const SESSION_PREFIX = 'ccui-';
const IDLE_HOURS = Number(process.env.SHELL_TMUX_IDLE_HOURS) || 12;
const REAPER_INTERVAL_MS = 10 * 60 * 1000;
// How long a detached "new session" terminal is still offered when the user
// opens "New session" for the same project again (same window the plain pty
// path uses before it kills an abandoned terminal).
const NEW_SESSION_REUSE_MS = 30 * 60 * 1000;

export const TMUX_CONFIG_PATH = path.join(os.homedir(), '.config', 'claudecodeui', 'tmux.conf');

// prefix None: Ctrl+B must reach the CLI (Claude Code uses it), and the web
// terminal has no use for tmux key bindings. Mouse stays on so wheel/touch
// scrolling walks the tmux history.
const TMUX_CONFIG = `# Written by claudecodeui on every start - edits are overwritten.
set -g prefix None
set -g prefix2 None
set -g status off
set -g mouse on
set -g history-limit 50000
set -sg escape-time 10
set -g default-terminal "tmux-256color"
set -as terminal-features ",xterm-256color:RGB:clipboard:hyperlinks:extkeys:focus"
set -s set-clipboard on
set -g allow-passthrough on
set -s extended-keys on
set -g focus-events on
set -s exit-empty off
set -g window-size latest
`;

let tmuxAvailable: boolean | null = null;
let configWritten = false;
let reaperStarted = false;

type PendingNewSession = {
  sessionId: string;
  attachedClients: number;
  lastDetachedAt: number;
};

// projectPath -> the session id handed to the last "new session" terminal.
const pendingNewSessions = new Map<string, PendingNewSession>();

export function isTmuxEnabled(): boolean {
  if (process.env.SHELL_TMUX === 'off' || os.platform() === 'win32') {
    return false;
  }

  if (tmuxAvailable === null) {
    try {
      execFileSync('tmux', ['-V'], { stdio: 'ignore' });
      tmuxAvailable = true;
    } catch {
      tmuxAvailable = false;
    }
  }

  return tmuxAvailable;
}

function ensureConfig(): void {
  if (configWritten) {
    return;
  }

  fs.mkdirSync(path.dirname(TMUX_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(TMUX_CONFIG_PATH, TMUX_CONFIG);
  configWritten = true;

  // A tmux server that outlived a restart of this process keeps its old
  // options; re-read the file. Fails harmlessly when no server is running.
  execFile('tmux', ['-L', TMUX_SOCKET, 'source-file', TMUX_CONFIG_PATH], () => {});
}

export function tmuxSessionName(sessionKey: string): string {
  return SESSION_PREFIX + crypto.createHash('sha1').update(sessionKey).digest('hex').slice(0, 16);
}

export function hasTmuxSession(name: string): boolean {
  try {
    execFileSync('tmux', ['-L', TMUX_SOCKET, 'has-session', '-t', `=${name}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Variables handed to a newly created session. The tmux server may have been
 * started by another unit with a bare environment, so the CLI gets this
 * process's environment explicitly.
 */
function sessionEnvironmentArgs(extraEnv: Record<string, string>): string[] {
  const skipped = new Set(['TERM', 'TMUX', 'TMUX_PANE']);
  const merged: Record<string, string> = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || skipped.has(name) || name.startsWith('npm_')) {
      continue;
    }
    // tmux splits `-e` on the first '=', so the name must not contain one.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      continue;
    }
    merged[name] = value;
  }

  Object.assign(merged, extraEnv);

  return Object.entries(merged).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
}

/**
 * Arguments for a tmux client that attaches to the named session, creating it
 * with `command` when it does not exist yet.
 */
export function buildTmuxClientArgs(options: {
  name: string;
  cwd: string;
  command: string;
  env: Record<string, string>;
}): string[] {
  ensureConfig();
  startIdleReaper();

  return [
    '-L',
    TMUX_SOCKET,
    '-f',
    TMUX_CONFIG_PATH,
    'new-session',
    '-A',
    '-s',
    options.name,
    '-c',
    options.cwd,
    ...sessionEnvironmentArgs(options.env),
    options.command,
  ];
}

/**
 * Picks the session id for a "new session" terminal of a project. A terminal
 * that is still attached somewhere, or was left less than 30 minutes ago, is
 * reused so a dropped connection lands back in the same conversation. Otherwise
 * a fresh id is issued; the CLI is started with it (`--session-id`), so opening
 * that conversation from the sidebar later attaches to the same tmux session
 * instead of starting a second CLI on it.
 */
export function resolveNewSessionId(
  projectPath: string,
  sessionKeyFor: (sessionId: string) => string
): string {
  const pending = pendingNewSessions.get(projectPath);
  if (pending) {
    const stillFresh =
      pending.attachedClients > 0 || Date.now() - pending.lastDetachedAt < NEW_SESSION_REUSE_MS;
    if (stillFresh && hasTmuxSession(tmuxSessionName(sessionKeyFor(pending.sessionId)))) {
      return pending.sessionId;
    }
  }

  const sessionId = crypto.randomUUID();
  pendingNewSessions.set(projectPath, { sessionId, attachedClients: 0, lastDetachedAt: Date.now() });
  return sessionId;
}

export function trackNewSessionClient(projectPath: string, sessionId: string, delta: 1 | -1): void {
  const pending = pendingNewSessions.get(projectPath);
  if (!pending || pending.sessionId !== sessionId) {
    return;
  }

  pending.attachedClients = Math.max(0, pending.attachedClients + delta);
  if (delta === -1) {
    pending.lastDetachedAt = Date.now();
  }
}

/** Leaves tmux copy mode (history scrolling) so the live screen is shown again. */
export function cancelTmuxCopyMode(name: string): void {
  execFile('tmux', ['-L', TMUX_SOCKET, 'send-keys', '-t', `=${name}:`, '-X', 'cancel'], () => {});
}

/**
 * Parses `list-sessions` output and returns sessions nobody is attached to and
 * that produced no output for longer than the idle limit.
 */
export function selectIdleSessions(listing: string, nowSeconds: number, idleSeconds: number): string[] {
  const idle: string[] = [];

  for (const line of listing.split('\n')) {
    const [name, attached, activity] = line.trim().split('\t');
    if (!name || !name.startsWith(SESSION_PREFIX)) {
      continue;
    }

    const lastActivity = Number(activity);
    if (attached !== '0' || !Number.isFinite(lastActivity)) {
      continue;
    }

    if (nowSeconds - lastActivity > idleSeconds) {
      idle.push(name);
    }
  }

  return idle;
}

function reapIdleSessions(): void {
  execFile(
    'tmux',
    ['-L', TMUX_SOCKET, 'list-sessions', '-F', '#{session_name}\t#{session_attached}\t#{session_activity}'],
    (error, stdout) => {
      if (error) {
        return; // no server running - nothing to reap
      }

      const idle = selectIdleSessions(stdout, Math.floor(Date.now() / 1000), IDLE_HOURS * 3600);
      for (const name of idle) {
        console.log(`[INFO] Shell tmux: closing idle session ${name} (no client, quiet for ${IDLE_HOURS}h)`);
        execFile('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', `=${name}`], () => {});
      }
    }
  );
}

/**
 * An idle CLI still holds a few hundred MB. Sessions nobody looks at and that
 * print nothing are closed after SHELL_TMUX_IDLE_HOURS (default 12); the
 * conversation itself stays on disk and resumes from the sidebar.
 */
function startIdleReaper(): void {
  if (reaperStarted) {
    return;
  }

  reaperStarted = true;
  setInterval(reapIdleSessions, REAPER_INTERVAL_MS).unref();
}
