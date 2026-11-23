import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildLookupMap, extractFirstValidJsonlData } from '@/shared/utils.js';

// Regression tests: a single malformed JSONL line must not discard the rest of
// the file, and extractFirstValidJsonlData must release the file handle on
// every exit path. Both helpers back the per-provider session synchronizers.

test('buildLookupMap keeps entries after a malformed line instead of stopping there', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'jsonl-lookup-'));

  try {
    const filePath = path.join(tempRoot, 'history.jsonl');
    await writeFile(
      filePath,
      [
        JSON.stringify({ sessionId: 'session-before', title: 'Before the bad line' }),
        '{ this is not valid json',
        JSON.stringify({ sessionId: 'session-after', title: 'After the bad line' }),
        '',
      ].join('\n'),
      'utf8',
    );

    const lookup = await buildLookupMap(filePath, 'sessionId', 'title');

    assert.equal(lookup.get('session-before'), 'Before the bad line');
    assert.equal(lookup.get('session-after'), 'After the bad line', 'the entry after a malformed line must survive');
    assert.equal(lookup.size, 2);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('extractFirstValidJsonlData skips a malformed line and returns a later valid row', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'jsonl-extract-'));

  try {
    const filePath = path.join(tempRoot, 'session.jsonl');
    await writeFile(
      filePath,
      [
        '{ half-written line',
        JSON.stringify({ type: 'summary', sessionId: 'session-xyz' }),
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await extractFirstValidJsonlData(filePath, (row) => {
      const record = row as Record<string, unknown>;
      return typeof record.sessionId === 'string' ? record.sessionId : null;
    });

    assert.equal(result, 'session-xyz');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('extractFirstValidJsonlData closes the file stream on the no-match path', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'jsonl-fd-'));
  // Count close() calls rather than checking `destroyed`: the no-match fixture
  // reaches EOF and Node destroys the stream there anyway.
  let closeCalls = 0;
  let createdStreams = 0;
  const originalCreateReadStream = nodeFs.createReadStream;
  (nodeFs as { createReadStream: typeof nodeFs.createReadStream }).createReadStream = ((
    ...args: Parameters<typeof nodeFs.createReadStream>
  ) => {
    const stream = originalCreateReadStream(...args);
    createdStreams += 1;
    const originalClose = stream.close.bind(stream);
    stream.close = ((...closeArgs: Parameters<typeof stream.close>) => {
      closeCalls += 1;
      return originalClose(...closeArgs);
    }) as typeof stream.close;
    return stream;
  }) as typeof nodeFs.createReadStream;

  try {
    const filePath = path.join(tempRoot, 'session.jsonl');
    await writeFile(filePath, ['{ bad one', '{ bad two', ''].join('\n'), 'utf8');

    const result = await extractFirstValidJsonlData(filePath, () => 'never');

    assert.equal(result, null);
    assert.equal(createdStreams, 1);
    assert.equal(closeCalls, 1, 'the read stream must be closed even when no row matches');
  } finally {
    (nodeFs as { createReadStream: typeof nodeFs.createReadStream }).createReadStream = originalCreateReadStream;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('JSONL helpers return empty results for a missing file', { concurrency: false }, async () => {
  const missing = path.join(os.tmpdir(), `missing-${process.pid}-${Date.now()}.jsonl`);

  assert.equal((await buildLookupMap(missing, 'sessionId', 'title')).size, 0);
  assert.equal(await extractFirstValidJsonlData(missing, () => 'x'), null);
});
