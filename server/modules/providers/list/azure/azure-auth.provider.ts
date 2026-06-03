import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

export const AZURE_CONFIG_PATH = path.join(os.homedir(), '.azure-openai', 'config.json');

export type AzureConfig = { endpoint: string; apiKey: string; apiVersion?: string };

export async function readAzureConfig(): Promise<AzureConfig | null> {
  const envEndpoint = process.env.AZURE_OPENAI_ENDPOINT?.trim();
  const envApiKey = process.env.AZURE_OPENAI_API_KEY?.trim();
  if (envEndpoint && envApiKey) {
    return { endpoint: envEndpoint, apiKey: envApiKey, apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-12-01-preview' };
  }
  try {
    const content = await readFile(AZURE_CONFIG_PATH, 'utf8');
    const parsed = readObjectRecord(JSON.parse(content));
    if (!parsed) return null;
    const endpoint = readOptionalString(parsed.endpoint);
    const apiKey = readOptionalString(parsed.apiKey);
    if (!endpoint || !apiKey) return null;
    return { endpoint, apiKey, apiVersion: readOptionalString(parsed.apiVersion) || '2024-12-01-preview' };
  } catch { return null; }
}

export class AzureProviderAuth implements IProviderAuth {
  async getStatus(): Promise<ProviderAuthStatus> {
    const config = await readAzureConfig();
    if (!config) {
      return { installed: true, provider: 'azure', authenticated: false, email: null, method: null, error: 'Not configured. Set endpoint and API key in Settings → Agents → Azure.' };
    }
    const method = process.env.AZURE_OPENAI_API_KEY ? 'environment' : 'config_file';
    let endpointHost = config.endpoint;
    try { endpointHost = new URL(config.endpoint).hostname; } catch { /* use raw */ }
    return { installed: true, provider: 'azure', authenticated: true, email: endpointHost, method };
  }
}
