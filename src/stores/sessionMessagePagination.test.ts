import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from './useSessionStore';
import {
  buildSessionMessagesUrl,
  findLatestPageOverlapLength,
  hasReachedCachedTailTimeBoundary,
  mergeLatestServerPage,
  mergeOlderServerPage,
  planLatestPageBridge,
  resolveLatestPagePagination,
} from './sessionMessagePagination';

function message(
  number: number,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage {
  return {
    id: `m${number}`,
    sessionId: 'session-1',
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, number)).toISOString(),
    provider: 'claude',
    kind: 'text',
    role: number % 2 === 0 ? 'assistant' : 'user',
    content: `message ${number}`,
    ...overrides,
  };
}

function range(start: number, end: number): NormalizedMessage[] {
  return Array.from({ length: end - start + 1 }, (_, index) => message(start + index));
}

test('automatic latest-history URL is explicitly bounded to the newest page', () => {
  assert.equal(
    buildSessionMessagesUrl('session/1', { limit: 20, offset: 0 }),
    '/api/providers/sessions/session%2F1/messages?limit=20&offset=0',
  );
});

test('overlapping latest page retains loaded older messages and replaces the tail', () => {
  const cached = range(21, 40);
  const latest = range(31, 50);
  latest[0] = { ...latest[0], content: 'fresh persisted value' };

  const result = mergeLatestServerPage(cached, latest);

  assert.equal(result.overlapLength, 10);
  assert.deepEqual(result.messages.map((item) => item.id), range(21, 50).map((item) => item.id));
  assert.equal(result.messages[10].content, 'fresh persisted value');
  assert.equal(new Set(result.messages.map((item) => item.id)).size, result.messages.length);
});

test('Codex rows with regenerated IDs overlap by stable transcript fields', () => {
  const cached = range(1, 20).map((item) => ({
    ...item,
    id: `codex-old-${item.id}`,
    provider: 'codex' as const,
  }));
  const latest = range(11, 30).map((item) => ({
    ...item,
    id: `codex-new-${item.id}`,
    provider: 'codex' as const,
  }));

  assert.equal(findLatestPageOverlapLength(cached, latest), 10);
  const merged = mergeLatestServerPage(cached, latest);
  assert.equal(merged.messages.length, 30);
  assert.deepEqual(
    merged.messages.slice(0, 10).map((item) => item.id),
    cached.slice(0, 10).map((item) => item.id),
  );
});

test('large appended turns request only the missing bridge and one anchor', () => {
  const cached = range(81, 100);
  const latest = range(106, 125);

  assert.deepEqual(planLatestPageBridge(cached, latest, 100, 125), {
    offset: 20,
    limit: 6,
  });

  const bridge = range(100, 105);
  const merged = mergeLatestServerPage(cached, [...bridge, ...latest]);
  assert.equal(merged.overlapLength, 1);
  assert.deepEqual(merged.messages.map((item) => item.id), range(81, 125).map((item) => item.id));
});

test('tool-result totals walk bounded bridge chunks until a contiguous anchor', () => {
  const cached = range(81, 100);
  const latest = range(106, 125);

  // Claude reports only 15 renderable additions for a 25-row normalized turn.
  assert.deepEqual(planLatestPageBridge(cached, latest, 100, 115), {
    offset: 20,
    limit: 1,
  });
  assert.deepEqual(planLatestPageBridge(cached, latest, 100, 115, 1), {
    offset: 21,
    limit: 20,
  });
});

test('hasReachedCachedTailTimeBoundary returns true when fetched chunk predates cached tail', () => {
  const cached = range(11, 20);
  const fetched = range(1, 10);

  assert.equal(hasReachedCachedTailTimeBoundary(cached, fetched), true);
});

test('hasReachedCachedTailTimeBoundary returns false when fetched chunk is newer', () => {
  const cached = range(1, 10);
  const fetched = range(11, 20);

  assert.equal(hasReachedCachedTailTimeBoundary(cached, fetched), false);
});

test('mergeOlderServerPage prepends non-overlapping older messages', () => {
  const cached = range(11, 20);
  const older = range(1, 10);

  const result = mergeOlderServerPage(cached, older);
  assert.equal(result.overlapLength, 0);
  assert.equal(result.prependedCount, 10);
  assert.deepEqual(result.messages.map((item) => item.id), range(1, 20).map((item) => item.id));
});

test('mergeOlderServerPage handles overlap when transcript grew during fetch', () => {
  const cached = range(6, 20);
  const older = range(1, 10);

  const result = mergeOlderServerPage(cached, older);
  assert.equal(result.overlapLength, 5);
  assert.equal(result.prependedCount, 5);
  assert.deepEqual(result.messages.map((item) => item.id), range(1, 20).map((item) => item.id));
});

test('resolveLatestPagePagination initializes hasMore from the oldest fetched page', () => {
  assert.deepEqual(resolveLatestPagePagination(0, 20, false, true), {
    offset: 20,
    hasMore: true,
  });
});

test('resolveLatestPagePagination preserves cached hasMore for subsequent refreshes', () => {
  assert.deepEqual(resolveLatestPagePagination(20, 30, true, true), {
    offset: 30,
    hasMore: true,
  });
  assert.deepEqual(resolveLatestPagePagination(20, 30, false, true), {
    offset: 30,
    hasMore: false,
  });
});
