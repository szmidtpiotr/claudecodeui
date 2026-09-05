import { readFile } from 'node:fs/promises';

import Anthropic from '@anthropic-ai/sdk';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildAnthropicClientOptions,
  readCredentialToken,
} from '@/modules/providers/list/claude/claude-credentials.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

const MODELS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let modelsCache: { models: ProviderModelsDefinition; fetchedAt: number } | null = null;

type PricingEntry = { input: string; output: string; usageFactor?: string };

const MODEL_PRICING: Array<{ pattern: RegExp; pricing: PricingEntry }> = [
  { pattern: /^claude-fable/,        pricing: { input: '$5',    output: '$25',  usageFactor: '~2× limits' } },
  { pattern: /^claude-opus-4-[89]/,  pricing: { input: '$5',    output: '$25',  usageFactor: '1× limits' } },
  { pattern: /^claude-opus-4/,       pricing: { input: '$5',    output: '$25',  usageFactor: '1× limits' } },
  { pattern: /^claude-sonnet-4/,     pricing: { input: '$3',    output: '$15',  usageFactor: '0.5× limits' } },
  { pattern: /^claude-haiku-4/,      pricing: { input: '$0.80', output: '$4',   usageFactor: '0.25× limits' } },
];

function getModelPricing(modelId: string): PricingEntry | null {
  for (const { pattern, pricing } of MODEL_PRICING) {
    if (pattern.test(modelId)) return pricing;
  }
  return null;
}

function buildModelDescription(
  displayName: string,
  modelId: string,
  maxInputTokens?: number | null,
  authType?: 'api_key' | 'oauth',
): string {
  const pricing = getModelPricing(modelId);
  const ctx = maxInputTokens && maxInputTokens >= 900_000 ? '1M ctx' : maxInputTokens ? `${Math.round(maxInputTokens / 1000)}k ctx` : null;
  const parts: string[] = [];
  if (ctx) parts.push(ctx);
  if (pricing) {
    parts.push(`$${pricing.input.replace('$', '')}/$${pricing.output.replace('$', '')} per Mtok`);
  }
  return parts.length > 0 ? parts.join(' · ') : displayName;
}

function buildModelsDefinition(
  apiModels: Array<{ id: string; display_name: string; max_input_tokens?: number | null }>,
  authType?: 'api_key' | 'oauth',
): ProviderModelsDefinition {
  const defaultDesc = authType === 'oauth'
    ? 'Best available model · 1M ctx'
    : 'Best available model · 1M ctx · API default';
  const OPTIONS = [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: defaultDesc,
    },
    ...apiModels.map((m) => ({
      value: m.id,
      label: m.display_name.replace(/^Claude\s+/i, ''),
      description: buildModelDescription(m.display_name, m.id, m.max_input_tokens, authType),
    })),
  ];
  return { OPTIONS, DEFAULT: 'default' };
}

async function fetchDynamicModels(): Promise<ProviderModelsDefinition | null> {
  if (modelsCache && Date.now() - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
    return modelsCache.models;
  }

  const credential = await readCredentialToken();
  if (!credential) return null;

  try {
    const client = new Anthropic(buildAnthropicClientOptions(credential));
    const result = await client.models.list();
    const models = (result.data ?? []).filter(
      (m) => typeof m.id === 'string' && typeof m.display_name === 'string',
    );

    if (models.length === 0) return null;

    const definition = buildModelsDefinition(models, credential.type);
    modelsCache = { models: definition, fetchedAt: Date.now() };
    return definition;
  } catch {
    return null;
  }
}

export const CLAUDE_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'fable',
      label: 'Fable',
      description: 'Fable 5 · Most capable for hardest tasks · Uses limits ~2× faster than Opus',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'opus',
      label: 'Opus 4.8',
      description: 'Most capable · $5/$25 per Mtok',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'sonnet',
      label: 'Sonnet 5',
      description: 'Efficient for routine tasks · $3/$15 per Mtok',
      effort: {
        default: 'high',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'haiku',
      label: 'Haiku 4.5',
      description: 'Fastest for quick answers · $1/$5 per Mtok',
    },
  ],
  DEFAULT: 'default',
};
type ClaudeInitEvent = {
  sessionId?: string;
  session_id?: string;
  type?: string;
  subtype?: string;
  model?: string;
  message?: {
    content?: unknown;
    model?: string;
  };
};

const ANSI_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:'
  + '(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]'
  + '|(?:[\\dA-PR-TZcf-ntqry=><~]))',
  'g',
);

const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel || null;
};

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, '');

const extractTaggedContent = (content: string, tagName: string): string | null => {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
};

const extractClaudeModelFromTextContent = (content: string): string | null => {
  const localCommandStdout = extractTaggedContent(content, 'local-command-stdout');
  if (localCommandStdout !== null) {
    const cleanedStdout = stripAnsi(localCommandStdout).replace(/\s+/g, ' ').trim();
    const changedModel = /(?:set|changed|switched)\s+model\s+to\s+(.+?)\.?$/i.exec(cleanedStdout);
    if (changedModel?.[1]?.trim()) {
      return changedModel[1].trim();
    }
  }

  const modelTag = extractTaggedContent(content, 'model')?.trim();
  return modelTag || null;
};

const extractClaudeModelFromMessageContent = (content: unknown): string | null => {
  if (typeof content === 'string') {
    return extractClaudeModelFromTextContent(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (!part || typeof part !== 'object' || !('text' in part) || typeof part.text !== 'string') {
      continue;
    }

    const model = extractClaudeModelFromTextContent(part.text);
    if (model) {
      return model;
    }
  }

  return null;
};

const readClaudeSessionModelFromJsonl = async (
  sessionId: string,
  jsonlPath: string,
): Promise<ProviderCurrentActiveModel | null> => {
  const content = await readFile(jsonlPath, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as ClaudeInitEvent;
      const model = extractClaudeEventModel(event, sessionId);
      if (model) {
        return { model };
      }
    } catch {
      // Skip malformed JSONL lines that can happen during concurrent writes.
    }
  }

  return null;
};

export class ClaudeProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    return (await fetchDynamicModels()) ?? CLAUDE_FALLBACK_MODELS;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      const jsonlPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;
      const activeModel = jsonlPath
        ? await readClaudeSessionModelFromJsonl(sessionId, jsonlPath)
        : null;
      if (activeModel?.model) {
        return activeModel;
      }
    } catch {
      // Fall through to the provider default when the session-backed lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('claude', input);
  }
}
