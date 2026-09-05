import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type ClaudeCredential = { type: 'api_key' | 'oauth'; token: string };

/**
 * Resolves the credential the local Claude installation is already using.
 *
 * Checked in the same order the Claude CLI itself resolves auth, so anything
 * that works in the terminal works here without asking the user for a second
 * secret: environment API key, `~/.claude/settings.json` env block, then the
 * OAuth access token written by `claude login`.
 */
export async function readCredentialToken(): Promise<ClaudeCredential | null> {
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    return { type: 'api_key', token: process.env.ANTHROPIC_API_KEY.trim() };
  }

  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    const envBlock = settings?.env as Record<string, unknown> | undefined;
    const apiKey = envBlock?.ANTHROPIC_API_KEY;
    if (typeof apiKey === 'string' && apiKey.trim()) {
      return { type: 'api_key', token: apiKey.trim() };
    }
    const authToken = envBlock?.ANTHROPIC_AUTH_TOKEN;
    if (typeof authToken === 'string' && authToken.trim()) {
      return { type: 'oauth', token: authToken.trim() };
    }
  } catch {
    // fall through
  }

  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const creds = JSON.parse(await readFile(credPath, 'utf8')) as Record<string, unknown>;
    const oauth = creds?.claudeAiOauth as Record<string, unknown> | undefined;
    const accessToken = oauth?.accessToken;
    if (typeof accessToken === 'string' && accessToken.trim()) {
      return { type: 'oauth', token: accessToken.trim() };
    }
  } catch {
    // fall through
  }

  return null;
}

/**
 * Builds Anthropic SDK client options for a resolved credential.
 *
 * OAuth tokens are only accepted on the Claude Code beta surface, so the beta
 * header travels with every client built here.
 */
export function buildAnthropicClientOptions(credential: ClaudeCredential): {
  apiKey?: string;
  authToken?: string;
  defaultHeaders: Record<string, string>;
} {
  const clientOpts = {
    defaultHeaders: { 'anthropic-beta': 'claude-code-20250219' },
  } as {
    apiKey?: string;
    authToken?: string;
    defaultHeaders: Record<string, string>;
  };

  if (credential.type === 'api_key') {
    clientOpts.apiKey = credential.token;
  } else {
    clientOpts.authToken = credential.token;
    clientOpts.apiKey = '';
  }

  return clientOpts;
}
