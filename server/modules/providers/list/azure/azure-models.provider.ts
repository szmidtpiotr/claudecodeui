import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import { buildDefaultProviderCurrentActiveModel, readObjectRecord, readOptionalString, writeProviderSessionActiveModelChange } from '@/shared/utils.js';
import { readAzureConfig } from './azure-auth.provider.js';

export const AZURE_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o mini' },
    { value: 'gpt-4', label: 'GPT-4' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
    { value: 'gpt-35-turbo', label: 'GPT-3.5 Turbo' },
    { value: 'o3', label: 'o3' },
    { value: 'o4-mini', label: 'o4-mini' },
  ],
  DEFAULT: 'gpt-4o',
};

export class AzureProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const config = await readAzureConfig();
    if (!config) return AZURE_FALLBACK_MODELS;
    try {
      const apiVersion = config.apiVersion || '2024-12-01-preview';
      const url = `${config.endpoint.replace(/\/$/, '')}/openai/deployments?api-version=${apiVersion}`;
      const response = await fetch(url, { headers: { 'api-key': config.apiKey } });
      if (!response.ok) return AZURE_FALLBACK_MODELS;
      const data = readObjectRecord(await response.json());
      const deployments = Array.isArray(data?.value) ? (data.value as Array<{ id?: unknown }>) : [];
      if (!deployments.length) return AZURE_FALLBACK_MODELS;
      const options = deployments
        .map((d) => { const id = readOptionalString(d.id); if (!id) return null; return { value: id, label: id }; })
        .filter((o): o is { value: string; label: string } => o !== null);
      if (!options.length) return AZURE_FALLBACK_MODELS;
      return { OPTIONS: options, DEFAULT: options[0].value };
    } catch { return AZURE_FALLBACK_MODELS; }
  }

  async getCurrentActiveModel(_sessionId?: string): Promise<ProviderCurrentActiveModel> {
    const models = await this.getSupportedModels();
    return buildDefaultProviderCurrentActiveModel(models);
  }

  async changeActiveModel(input: ProviderChangeActiveModelInput): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('azure', input);
  }
}
