import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getReportedClaudeContextWindow,
  readReportedClaudeContextWindow,
  rememberClaudeContextWindow,
  resolveClaudeContextWindow,
} from '@/shared/utils.js';

const result = (modelUsage: Record<string, unknown> | undefined) => ({
  type: 'result',
  ...(modelUsage ? { modelUsage } : {}),
});

test('the main thread model picks its own window, not a subagent model', () => {
  const message = result({
    'claude-haiku-4-5': { contextWindow: 200_000 },
    'claude-sonnet-5-5[1m]': { contextWindow: 1_000_000 },
  });

  assert.equal(readReportedClaudeContextWindow(message, 'claude-sonnet-5-5'), 1_000_000);
  assert.equal(readReportedClaudeContextWindow(message, 'claude-haiku-4-5'), 200_000);
});

test('canonicalModel matches the bare id', () => {
  const message = result({
    'opus-alias': { contextWindow: 1_000_000, canonicalModel: 'claude-opus-5-5' },
    'claude-haiku-4-5': { contextWindow: 200_000 },
  });

  assert.equal(readReportedClaudeContextWindow(message, 'claude-opus-5-5'), 1_000_000);
});

test('a single billed model is used whatever it is called', () => {
  assert.equal(readReportedClaudeContextWindow(result({ 'local-model': { contextWindow: 32_000 } }), null), 32_000);
});

test('no window is read from non-result messages or results without one', () => {
  assert.equal(readReportedClaudeContextWindow({ type: 'assistant', modelUsage: { m: { contextWindow: 1 } } }, 'm'), null);
  assert.equal(readReportedClaudeContextWindow(result(undefined), 'm'), null);
  assert.equal(readReportedClaudeContextWindow(result({ m: { contextWindow: 0 } }), 'm'), null);
  // Two models, neither the main one: ambiguous, so no window.
  assert.equal(readReportedClaudeContextWindow(result({ a: { contextWindow: 1 }, b: { contextWindow: 2 } }), 'c'), null);
});

test('resolve falls back to CONTEXT_WINDOW, then 160000', () => {
  const previous = process.env.CONTEXT_WINDOW;
  try {
    delete process.env.CONTEXT_WINDOW;
    assert.equal(resolveClaudeContextWindow(null), 160_000);
    process.env.CONTEXT_WINDOW = '200000';
    assert.equal(resolveClaudeContextWindow(undefined), 200_000);
    assert.equal(resolveClaudeContextWindow(1_000_000), 1_000_000);
  } finally {
    if (previous === undefined) delete process.env.CONTEXT_WINDOW;
    else process.env.CONTEXT_WINDOW = previous;
  }
});

test('a remembered window is returned per session and invalid values are ignored', () => {
  rememberClaudeContextWindow('session-a', 1_000_000);
  rememberClaudeContextWindow('session-a', 0);
  rememberClaudeContextWindow('', 5);

  assert.equal(getReportedClaudeContextWindow('session-a'), 1_000_000);
  assert.equal(getReportedClaudeContextWindow('session-b'), undefined);
  assert.equal(getReportedClaudeContextWindow(null), undefined);
});
