import { AzureOpenAI } from 'openai';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createNormalizedMessage } from './shared/utils.js';
import { sessionsDb } from './modules/database/index.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';

const SESSIONS_DIR = path.join(os.homedir(), '.azure-openai', 'sessions');
const CONFIG_PATH = path.join(os.homedir(), '.azure-openai', 'config.json');
const PROVIDER = 'azure';

const activeSessions = new Map();

async function loadConfig() {
    const envEndpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim();
    const envApiKey = process.env.AZURE_OPENAI_API_KEY?.trim();
    if (envEndpoint && envApiKey) {
        return { endpoint: envEndpoint, apiKey: envApiKey, apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview' };
    }
    try {
        const content = await readFile(CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(content);
        if (parsed?.endpoint && parsed?.apiKey) {
            return { endpoint: parsed.endpoint, apiKey: parsed.apiKey, apiVersion: parsed.apiVersion || '2024-12-01-preview' };
        }
    } catch { /* no config */ }
    return null;
}

async function loadHistory(sessionId) {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session?.jsonl_path) return [];
    const messages = [];
    try {
        const content = await readFile(session.jsonl_path, 'utf8');
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try {
                const parsed = JSON.parse(line);
                if (parsed.type === 'session_init') continue;
                if (parsed.role && parsed.content) messages.push({ role: parsed.role, content: parsed.content });
            } catch { /* skip */ }
        }
    } catch { /* no file */ }
    return messages;
}

async function appendLine(filePath, record) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, JSON.stringify(record) + '\n', 'utf8');
}

function send(ws, msg) {
    if (ws && typeof ws.send === 'function') {
        ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
}

export async function queryAzure(command, options = {}, ws) {
    const { sessionId, cwd, projectPath, model } = options;

    const config = await loadConfig();
    if (!config) {
        send(ws, createNormalizedMessage({
            kind: 'error',
            content: 'Azure OpenAI not configured. Go to Settings → Agents → Azure to set endpoint and API key.',
            sessionId: sessionId || '',
            provider: PROVIDER,
        }));
        return;
    }

    const resolvedModel = await providerModelsService.resolveResumeModel(PROVIDER, sessionId, model);
    const workingDirectory = cwd || projectPath || process.cwd();
    const abortController = new AbortController();

    let capturedSessionId = sessionId || null;
    const isNewSession = !capturedSessionId;
    if (!capturedSessionId) capturedSessionId = randomUUID();

    const sessionFilePath = path.join(SESSIONS_DIR, `${capturedSessionId}.jsonl`);

    activeSessions.set(capturedSessionId, { status: 'running', abortController, startedAt: new Date().toISOString() });

    try {
        if (isNewSession) {
            if (ws.setSessionId && typeof ws.setSessionId === 'function') ws.setSessionId(capturedSessionId);
            send(ws, createNormalizedMessage({ kind: 'session_created', newSessionId: capturedSessionId, sessionId: capturedSessionId, provider: PROVIDER }));
            await appendLine(sessionFilePath, { type: 'session_init', sessionId: capturedSessionId, projectPath: workingDirectory, model: resolvedModel, timestamp: new Date().toISOString(), firstMessage: command.slice(0, 100) });
            sessionsDb.createSession(capturedSessionId, PROVIDER, workingDirectory, command.slice(0, 80) || 'Azure Session', new Date().toISOString(), new Date().toISOString(), sessionFilePath);
        }

        await appendLine(sessionFilePath, { role: 'user', content: command, timestamp: new Date().toISOString(), id: `user_${randomUUID()}` });

        const history = await loadHistory(capturedSessionId);
        if (!history.length || history[history.length - 1].content !== command) {
            history.push({ role: 'user', content: command });
        }

        const client = new AzureOpenAI({ endpoint: config.endpoint, apiKey: config.apiKey, apiVersion: config.apiVersion });

        let fullContent = '';
        try {
            const stream = await client.chat.completions.create({ model: resolvedModel, messages: history, stream: true }, { signal: abortController.signal });

            for await (const chunk of stream) {
                if (abortController.signal.aborted) break;
                const session = activeSessions.get(capturedSessionId);
                if (session?.status === 'aborted') break;

                const delta = chunk.choices?.[0]?.delta?.content;
                if (delta) {
                    fullContent += delta;
                    send(ws, createNormalizedMessage({ kind: 'stream_delta', content: delta, sessionId: capturedSessionId, provider: PROVIDER }));
                }
            }
        } catch (err) {
            if (!abortController.signal.aborted) {
                const errMsg = err instanceof Error ? err.message : String(err);
                send(ws, createNormalizedMessage({ kind: 'error', content: `Azure OpenAI error: ${errMsg}`, sessionId: capturedSessionId, provider: PROVIDER }));
            }
        }

        if (fullContent) {
            await appendLine(sessionFilePath, { role: 'assistant', content: fullContent, timestamp: new Date().toISOString(), id: `assistant_${randomUUID()}` });
        }

        send(ws, createNormalizedMessage({ kind: 'stream_end', sessionId: capturedSessionId, provider: PROVIDER }));
        send(ws, createNormalizedMessage({ kind: 'complete', sessionId: capturedSessionId, provider: PROVIDER }));
    } finally {
        activeSessions.delete(capturedSessionId);
    }
}

export function abortAzureSession(sessionId) {
    const session = activeSessions.get(sessionId);
    if (session) {
        session.status = 'aborted';
        session.abortController?.abort();
        activeSessions.delete(sessionId);
        return true;
    }
    return false;
}

export function isAzureSessionActive(sessionId) {
    return activeSessions.has(sessionId);
}

export function getActiveAzureSessions() {
    return Array.from(activeSessions.entries()).map(([id, s]) => ({ sessionId: id, ...s }));
}
