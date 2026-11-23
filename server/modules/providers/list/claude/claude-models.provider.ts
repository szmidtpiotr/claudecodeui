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
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

const MODELS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let modelsCache: { models: ProviderModelsDefinition; fetchedAt: number } | null = null;

type PricingEntry = { input?: string; output?: string; usageFactor?: string };

/**
 * Matched top-down, so generation-specific rows win over the family catch-alls.
 *
 * The models endpoint carries no pricing, so published per-token prices are only
 * listed for generations we have actually confirmed. Newer generations still match
 * their family row and show the usage multiplier alone rather than a guessed price.
 */
const MODEL_PRICING: Array<{ pattern: RegExp; pricing: PricingEntry }> = [
  { pattern: /^claude-fable-5(?![\d-])/, pricing: { input: '$5',    output: '$25',  usageFactor: '~2× limits' } },
  { pattern: /^claude-opus-4/,           pricing: { input: '$5',    output: '$25',  usageFactor: '1× limits' } },
  { pattern: /^claude-sonnet-4/,         pricing: { input: '$3',    output: '$15',  usageFactor: '0.5× limits' } },
  { pattern: /^claude-haiku-4/,          pricing: { input: '$1',    output: '$5',   usageFactor: '0.25× limits' } },
  { pattern: /^claude-fable/,            pricing: { usageFactor: '~2× limits' } },
  { pattern: /^claude-opus/,             pricing: { usageFactor: '1× limits' } },
  { pattern: /^claude-sonnet/,           pricing: { usageFactor: '0.5× limits' } },
  { pattern: /^claude-haiku/,            pricing: { usageFactor: '0.25× limits' } },
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
  if (pricing?.input && pricing.output) {
    parts.push(`$${pricing.input.replace('$', '')}/$${pricing.output.replace('$', '')} per Mtok`);
  } else if (pricing?.usageFactor) {
    parts.push(pricing.usageFactor);
  }
  return parts.length > 0 ? parts.join(' · ') : displayName;
}

/**
 * Effort levels in the order the picker should show them, not the order the API
 * happens to serialise them in.
 */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * The effort Claude Code itself uses for each pinned version when none is sent.
 * The models endpoint reports which levels a model accepts but not its default, so
 * without this table every version would start at `high`. Versions missing here keep
 * the `high` fallback.
 */
const CLAUDE_CODE_DEFAULT_EFFORT: Record<string, string> = {
  'claude-fable-5-2': 'medium',
  'claude-fable-5-1': 'high',
  'claude-fable-5': 'high',
  'claude-opus-5-5': 'medium',
  'claude-opus-5': 'high',
  'claude-opus-4-8': 'high',
  'claude-opus-4-7': 'xhigh',
  'claude-opus-4-6': 'high',
  'claude-sonnet-5-5': 'medium',
  'claude-sonnet-5': 'high',
  'claude-sonnet-4-6': 'high',
  'claude-haiku-5-5': 'medium',
};

type ClaudeApiModelCapability = { supported?: boolean } | undefined;

type ClaudeApiModel = {
  id: string;
  display_name: string;
  max_input_tokens?: number | null;
  capabilities?: {
    effort?: { supported?: boolean } & Record<string, ClaudeApiModelCapability | boolean>;
  };
};

/**
 * Translates the model endpoint's `capabilities.effort` block into the picker's
 * effort shape. Older models report `supported: false` and get no effort control.
 */
function buildModelEffort(
  model: ClaudeApiModel,
  { useClaudeCodeDefault = true }: { useClaudeCodeDefault?: boolean } = {},
): ProviderModelOption['effort'] | undefined {
  const effort = model.capabilities?.effort;
  if (!effort || effort.supported !== true) {
    return undefined;
  }

  const values = EFFORT_LEVELS
    .filter((level) => {
      const capability = effort[level];
      return typeof capability === 'object' && capability?.supported === true;
    })
    .map((level) => ({ value: level as string }));

  if (values.length === 0) {
    return undefined;
  }

  const claudeCodeDefault = useClaudeCodeDefault ? CLAUDE_CODE_DEFAULT_EFFORT[model.id] : undefined;
  const preferred = claudeCodeDefault && values.some((entry) => entry.value === claudeCodeDefault)
    ? claudeCodeDefault
    : values.some((entry) => entry.value === 'high')
      ? 'high'
      : values[values.length - 1].value;

  return { default: preferred, values };
}

/** Exported for tests. */
export function buildModelsDefinition(
  apiModels: ClaudeApiModel[],
  authType?: 'api_key' | 'oauth',
): ProviderModelsDefinition {
  const defaultDesc = authType === 'oauth'
    ? 'Best available model · 1M ctx'
    : 'Best available model · 1M ctx · API default';
  const OPTIONS: ProviderModelOption[] = [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: defaultDesc,
      // `default` resolves to the newest model, so it inherits that model's effort range,
      // but keeps starting at `high` as before rather than that model's own default.
      ...(apiModels[0]
        ? { effort: buildModelEffort(apiModels[0], { useClaudeCodeDefault: false }) }
        : {}),
    },
    ...apiModels.map((m) => ({
      value: m.id,
      label: m.display_name.replace(/^Claude\s+/i, ''),
      description: buildModelDescription(m.display_name, m.id, m.max_input_tokens, authType),
      effort: buildModelEffort(m),
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
    // The SDK model type predates `capabilities`, which the endpoint does return.
    const models = ((result.data ?? []) as unknown as ClaudeApiModel[]).filter(
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

const EFFORT_LEVELS_WITH_XHIGH = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
// Opus 4.6 and Sonnet 4.6 predate the xhigh level; Claude Code rejects it for them.
const EFFORT_LEVELS_WITHOUT_XHIGH = ['low', 'medium', 'high', 'max'] as const;

/** One pinned version's effort control. Arrays are built per call so options never share them. */
const buildPinnedModelEffort = (
  modelId: string,
  levels: readonly string[],
): NonNullable<ProviderModelOption['effort']> => ({
  default: CLAUDE_CODE_DEFAULT_EFFORT[modelId] ?? 'high',
  values: levels.map((value) => ({ value })),
});

const pinnedModel = (
  value: string,
  label: string,
  levels: readonly string[] | null,
  note = '',
): ProviderModelOption => ({
  value,
  label,
  description: `Pinned to ${label}${note}.`,
  ...(levels ? { effort: buildPinnedModelEffort(value, levels) } : {}),
});

/**
 * Exact model versions, listed after the aliases in the fallback catalog. An alias such
 * as `opus` follows whichever release is newest; these stay on one release. The set
 * matches the versions Claude Code's own model picker offers. The live catalog gets the
 * same versions straight from the models endpoint.
 */
const CLAUDE_PINNED_MODEL_OPTIONS: ProviderModelOption[] = [
  pinnedModel('claude-fable-5-2', 'Fable 5.2', EFFORT_LEVELS_WITH_XHIGH, ', the current Fable release'),
  pinnedModel('claude-fable-5-1', 'Fable 5.1', EFFORT_LEVELS_WITH_XHIGH),
  pinnedModel('claude-fable-5', 'Fable 5', EFFORT_LEVELS_WITH_XHIGH),
  pinnedModel('claude-opus-5-5', 'Opus 5.5', EFFORT_LEVELS_WITH_XHIGH, ', the current Opus release'),
  pinnedModel('claude-opus-5', 'Opus 5', EFFORT_LEVELS_WITH_XHIGH),
  pinnedModel('claude-opus-4-8', 'Opus 4.8', EFFORT_LEVELS_WITH_XHIGH),
  pinnedModel('claude-opus-4-7', 'Opus 4.7', EFFORT_LEVELS_WITH_XHIGH),
  pinnedModel('claude-opus-4-6', 'Opus 4.6', EFFORT_LEVELS_WITHOUT_XHIGH),
  pinnedModel('claude-sonnet-5-5', 'Sonnet 5.5', EFFORT_LEVELS_WITH_XHIGH, ', the current Sonnet release'),
  pinnedModel('claude-sonnet-5', 'Sonnet 5', EFFORT_LEVELS_WITH_XHIGH),
  pinnedModel('claude-sonnet-4-6', 'Sonnet 4.6', EFFORT_LEVELS_WITHOUT_XHIGH),
  pinnedModel('claude-haiku-5-5', 'Haiku 5.5', EFFORT_LEVELS_WITH_XHIGH, ', the current Haiku release'),
  // Claude Code's picker sends the dated id for this release, so the catalog does too.
  pinnedModel('claude-haiku-4-5-20251001', 'Haiku 4.5', null, '. Has no effort control'),
];

export const CLAUDE_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'default',
      label: 'Default (recommended)',
      description: 'Recommended model for your account · 1M ctx',
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
      description: 'Latest Fable · Most capable for hardest tasks · Uses limits ~2× faster than Opus',
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
      label: 'Opus',
      description: 'Latest Opus · Complex reasoning and coding · 1× limits',
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
      label: 'Sonnet',
      description: 'Latest Sonnet · Efficient for routine tasks · 0.5× limits',
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
      value: 'haiku',
      label: 'Haiku',
      description: 'Latest Haiku · Fastest for quick answers · 0.25× limits',
      // `medium` is the level Claude Code already runs Haiku at when none is sent.
      effort: {
        default: 'medium',
        values: [
          { value: 'low' },
          { value: 'medium' },
          { value: 'high' },
          { value: 'xhigh' },
          { value: 'max' },
        ],
      },
    },
    ...CLAUDE_PINNED_MODEL_OPTIONS,
  ],
  DEFAULT: 'default',
  fallback: true,
};

/**
 * Looks a model id up in the fallback catalog, which is the one list that is always
 * available without a network call. Exported for tests.
 */
export const findClaudeModelOption = (model: string | undefined | null): ProviderModelOption | null => {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (!normalizedModel) {
    return null;
  }

  return CLAUDE_FALLBACK_MODELS.OPTIONS.find((option) => option.value === normalizedModel) ?? null;
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

/**
 * Claude Code stamps locally-synthesized rows (API-error placeholders and the
 * like) with `model: "<synthetic>"`. Angle-bracketed values are placeholders,
 * never real model ids, and must not be surfaced as the session's model.
 */
const isPlaceholderModel = (model: string): boolean => model.startsWith('<') && model.endsWith('>');

/** Exported for tests. */
export const extractClaudeEventModel = (event: ClaudeInitEvent, sessionId: string): string | null => {
  const eventSessionId = event.sessionId ?? event.session_id;
  if (eventSessionId && eventSessionId !== sessionId) {
    return null;
  }

  const contentModel = extractClaudeModelFromMessageContent(event.message?.content);
  if (contentModel) {
    return contentModel;
  }

  const directModel = event.model?.trim();
  if (directModel && !isPlaceholderModel(directModel)) {
    return directModel;
  }

  const messageModel = event.message?.model?.trim();
  return messageModel && !isPlaceholderModel(messageModel) ? messageModel : null;
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
    const stdoutModel = changedModel?.[1]?.trim();
    // A placeholder stdout hit must not shadow a real <model> tag further down.
    if (stdoutModel && !isPlaceholderModel(stdoutModel)) {
      return stdoutModel;
    }
  }

  const modelTag = extractTaggedContent(content, 'model')?.trim();
  return modelTag && !isPlaceholderModel(modelTag) ? modelTag : null;
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

    // extractClaudeModelFromTextContent rejects placeholders, so a placeholder
    // part yields null here and a later part can still supply the real model.
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
