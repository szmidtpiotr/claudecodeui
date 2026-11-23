import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildModelsDefinition,
  CLAUDE_FALLBACK_MODELS,
  extractClaudeEventModel,
  findClaudeModelOption,
} from '@/modules/providers/list/claude/claude-models.provider.js';

const SESSION_ID = 'session-1';

// Pinned versions as Claude Code's own model picker declares them: id, effort default,
// whether xhigh is offered. `null` marks a model with no effort control.
const PINNED_MODELS: ReadonlyArray<[id: string, defaultEffort: string | null, xhigh: boolean]> = [
  ['claude-fable-5-2', 'medium', true],
  ['claude-fable-5-1', 'high', true],
  ['claude-fable-5', 'high', true],
  ['claude-opus-5-5', 'medium', true],
  ['claude-opus-5', 'high', true],
  ['claude-opus-4-8', 'high', true],
  ['claude-opus-4-7', 'xhigh', true],
  ['claude-opus-4-6', 'high', false],
  ['claude-sonnet-5-5', 'medium', true],
  ['claude-sonnet-5', 'high', true],
  ['claude-sonnet-4-6', 'high', false],
  ['claude-haiku-5-5', 'medium', true],
  ['claude-haiku-4-5-20251001', null, false],
];

test('fallback catalog offers each pinned version with the effort levels and default Claude Code uses', () => {
  for (const [id, defaultEffort, xhigh] of PINNED_MODELS) {
    const option = findClaudeModelOption(id);
    assert.ok(option, `${id} is missing from the catalog`);

    if (defaultEffort === null) {
      assert.equal(option.effort, undefined, `${id} should have no effort control`);
      continue;
    }

    const levels = option.effort?.values.map((level) => level.value) ?? [];
    assert.equal(option.effort?.default, defaultEffort, `${id} default effort`);
    assert.ok(levels.includes(defaultEffort), `${id} default must be one of its levels`);
    assert.equal(levels.includes('xhigh'), xhigh, `${id} xhigh`);
  }
});

test('fallback catalog keeps the aliases first, the default unchanged, and every model id unique', () => {
  const values = CLAUDE_FALLBACK_MODELS.OPTIONS.map((option) => option.value);

  assert.equal(CLAUDE_FALLBACK_MODELS.DEFAULT, 'default');
  assert.equal(CLAUDE_FALLBACK_MODELS.fallback, true);
  assert.deepEqual(values.slice(0, 5), ['default', 'fable', 'opus', 'sonnet', 'haiku']);
  assert.equal(new Set(values).size, values.length);
});

test('offers Haiku the effort levels Claude Code accepts for it, starting at its own default', () => {
  const haikuEffort = findClaudeModelOption('haiku')?.effort;
  const levels = haikuEffort?.values.map((level) => level.value);

  assert.deepEqual(levels, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(haikuEffort?.default, 'medium');
});

test('fallback aliases follow the newest release, so their labels carry no version', () => {
  for (const alias of ['fable', 'opus', 'sonnet', 'haiku']) {
    const option = findClaudeModelOption(alias);
    assert.ok(option, `${alias} is missing`);
    assert.doesNotMatch(option.label, /\d/, `${alias} label`);
    assert.doesNotMatch(option.description ?? '', /(Fable|Opus|Sonnet|Haiku) \d/, `${alias} description`);
  }
});

const ALL_LEVELS = { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } };

test('live catalog starts each version at Claude Code\'s default effort, the default alias at high', () => {
  const definition = buildModelsDefinition([
    { id: 'claude-fable-5-2', display_name: 'Claude Fable 5.2', capabilities: { effort: ALL_LEVELS } },
    { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', capabilities: { effort: ALL_LEVELS } },
    { id: 'claude-opus-5', display_name: 'Claude Opus 5', capabilities: { effort: ALL_LEVELS } },
    { id: 'claude-future-9', display_name: 'Claude Future 9', capabilities: { effort: ALL_LEVELS } },
  ], 'oauth');
  const defaults = Object.fromEntries(definition.OPTIONS.map((option) => [option.value, option.effort?.default]));

  assert.deepEqual(defaults, {
    default: 'high',
    'claude-fable-5-2': 'medium',
    'claude-opus-4-7': 'xhigh',
    'claude-opus-5': 'high',
    'claude-future-9': 'high',
  });
});

test('live catalog describes the newest generations by usage multiplier, not a guessed price', () => {
  const definition = buildModelsDefinition([
    { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' },
    { id: 'claude-fable-5-2', display_name: 'Claude Fable 5.2' },
    { id: 'claude-fable-5', display_name: 'Claude Fable 5' },
    { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' },
  ]);
  const descriptions = Object.fromEntries(definition.OPTIONS.map((option) => [option.value, option.description]));

  assert.equal(descriptions['claude-opus-5-5'], '1× limits');
  assert.equal(descriptions['claude-sonnet-5-5'], '0.5× limits');
  assert.equal(descriptions['claude-haiku-5-5'], '0.25× limits');
  assert.equal(descriptions['claude-fable-5-2'], '~2× limits');
  assert.equal(descriptions['claude-fable-5'], '$5/$25 per Mtok');
  assert.equal(descriptions['claude-haiku-4-5-20251001'], '$1/$5 per Mtok');
});

test('ignores the <synthetic> placeholder Claude Code stamps on synthesized rows', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: '<synthetic>' } },
      SESSION_ID,
    ),
    null,
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: '<synthetic>' }, SESSION_ID),
    null,
  );
});

test('still surfaces real model ids from message and event fields', () => {
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { model: 'claude-sonnet-5' } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel({ sessionId: SESSION_ID, model: 'opus' }, SESSION_ID),
    'opus',
  );
});

test('skips a placeholder content part so a later real model tag still wins', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: [
            { text: '<model><synthetic></model>' },
            { text: '<model>claude-sonnet-5</model>' },
          ],
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('a placeholder stdout hit does not shadow a real <model> tag in the same text', () => {
  const text = '<local-command-stdout>Set model to <synthetic></local-command-stdout>'
    + '<model>claude-sonnet-5</model>';
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: text } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
  assert.equal(
    extractClaudeEventModel(
      { sessionId: SESSION_ID, message: { content: [{ text }] } },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});

test('falls back to the message model when every content hit is a placeholder', () => {
  assert.equal(
    extractClaudeEventModel(
      {
        sessionId: SESSION_ID,
        message: {
          content: '<model><synthetic></model>',
          model: 'claude-sonnet-5',
        },
      },
      SESSION_ID,
    ),
    'claude-sonnet-5',
  );
});
