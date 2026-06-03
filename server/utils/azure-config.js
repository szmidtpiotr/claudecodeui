import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const CONFIG_PATH = path.join(os.homedir(), '.azure-openai', 'config.json');

export async function loadAzureConfig() {
    const envEndpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim();
    const envApiKey = process.env.AZURE_OPENAI_API_KEY?.trim();

    if (envEndpoint && envApiKey) {
        return {
            endpoint: envEndpoint.replace(/\/$/, ''),
            apiKey: envApiKey,
            apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview',
        };
    }

    try {
        const content = await readFile(CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(content);
        if (parsed?.endpoint && parsed?.apiKey) {
            return {
                endpoint: parsed.endpoint.replace(/\/$/, ''),
                apiKey: parsed.apiKey,
                apiVersion: parsed.apiVersion || '2024-12-01-preview',
            };
        }
    } catch {
        // no config
    }

    return null;
}

export async function fetchAzureDeployments(config) {
    try {
        const url = `${config.endpoint}/openai/deployments?api-version=${config.apiVersion}`;
        const res = await fetch(url, {
            headers: { 'api-key': config.apiKey },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return [];

        const data = await res.json();
        const deployments = Array.isArray(data?.value) ? data.value : [];
        return deployments
            .map((d) => typeof d?.id === 'string' ? d.id : null)
            .filter(Boolean);
    } catch {
        return [];
    }
}
