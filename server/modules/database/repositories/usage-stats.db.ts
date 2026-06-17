/**
 * Token-usage statistics repository.
 *
 * Reads Claude's session JSONL logs under ~/.claude/projects/ (including
 * subagent logs) and maintains a durable per-day × model token aggregate
 * in SQLite. Designed around three reliability facts established from real
 * logs:
 *
 *   1. Dedup — one assistant turn is written on several JSONL lines that all
 *      repeat the SAME `usage` block. Counting raw lines overcounts ~1.7×.
 *      We dedup on `message.id` via the usage_seen table.
 *   2. Incremental — logs are append-only and large (hundreds of files, tens
 *      of thousands of messages). We persist a per-file byte cursor and only
 *      parse newly-appended bytes on each scan.
 *   3. Synthetic noise — harness-injected messages carry model `<synthetic>`
 *      and zero tokens; they are skipped.
 *
 * The day bucket is the LOCAL calendar day in CLAUDE_USAGE_TZ (default
 * Europe/Warsaw), baked in at scan time. Changing the timezone later does
 * not retroactively re-bucket already-aggregated history.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { getConnection } from '@/modules/database/connection.js';

const USAGE_ROOT = path.join(os.homedir(), '.claude', 'projects');
const USAGE_TZ = process.env.CLAUDE_USAGE_TZ || 'Europe/Warsaw';

// Don't re-walk the filesystem more than once per window unless forced.
const SCAN_THROTTLE_MS = 15_000;

// 'en-CA' formats as YYYY-MM-DD, which is exactly the key we store.
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: USAGE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

type DailyRow = {
  date: string;
  model: string;
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
  messages: number;
};

type ModelTotals = {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
  total: number;
  messages: number;
};

export type DailyUsage = {
  date: string;
  models: Record<string, ModelTotals>;
};

let lastScanAt = 0;
let scanInFlight: Promise<void> | null = null;

/** Local (CLAUDE_USAGE_TZ) calendar day for an ISO timestamp, or null. */
function localDay(timestamp: unknown): string | null {
  if (typeof timestamp !== 'string') return null;
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return null;
  return dayFormatter.format(new Date(ms));
}

/** Recursively collect every *.jsonl path under the projects root. */
function collectJsonlFiles(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { recursive: true, withFileTypes: true }) as fs.Dirent[];
  } catch {
    return []; // No logs yet — nothing to scan.
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      // parentPath is the dir holding the entry (Node 20.1+).
      files.push(path.join(entry.parentPath ?? root, entry.name));
    }
  }
  return files;
}

/**
 * Parse one JSONL line, returning the countable usage row or null.
 * Skips non-assistant lines, synthetic messages, and anything missing an id.
 */
function parseUsageLine(line: string): { id: string; day: string; model: string; row: Omit<DailyRow, 'date' | 'model'> } | null {
  if (!line) return null;
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  const msg = obj?.message;
  const usage = msg?.usage;
  const id = msg?.id;
  const model = msg?.model;
  if (!usage || typeof id !== 'string' || typeof model !== 'string') return null;
  if (model.startsWith('<')) return null; // <synthetic> etc.

  const day = localDay(obj?.timestamp);
  if (!day) return null;

  return {
    id,
    day,
    model,
    row: {
      input: usage.input_tokens || 0,
      output: usage.output_tokens || 0,
      cache_creation: usage.cache_creation_input_tokens || 0,
      cache_read: usage.cache_read_input_tokens || 0,
      messages: 1,
    },
  };
}

/** Read a file's newly-appended bytes and fold them into the aggregate. */
function scanFile(db: ReturnType<typeof getConnection>, filePath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }

  const known = db
    .prepare('SELECT mtime_ms, size, byte_offset FROM usage_files WHERE path = ?')
    .get(filePath) as { mtime_ms: number; size: number; byte_offset: number } | undefined;

  let offset = known?.byte_offset ?? 0;

  // Unchanged since last scan — skip.
  if (known && known.size === stat.size && known.mtime_ms === Math.floor(stat.mtimeMs)) {
    return;
  }
  // Truncated or rotated — restart from the top (usage_seen still guards
  // against double-counting any ids that reappear).
  if (offset > stat.size) offset = 0;

  const bytesToRead = stat.size - offset;
  let trailingPartialBytes = 0;

  if (bytesToRead > 0) {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.allocUnsafe(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, offset);
      const text = buf.toString('utf8');
      const lines = text.split('\n');

      // A trailing fragment without a newline is an incompletely-written
      // line; leave it for the next scan by rewinding the offset past it.
      const last = lines[lines.length - 1];
      if (last !== '') {
        trailingPartialBytes = Buffer.byteLength(last, 'utf8');
        lines.pop();
      } else {
        lines.pop(); // the empty string after the final newline
      }

      const insertSeen = db.prepare('INSERT OR IGNORE INTO usage_seen (msg_id) VALUES (?)');
      const upsertDaily = db.prepare(`
        INSERT INTO usage_daily (date, model, input, output, cache_creation, cache_read, messages)
        VALUES (@date, @model, @input, @output, @cache_creation, @cache_read, @messages)
        ON CONFLICT (date, model) DO UPDATE SET
          input = input + excluded.input,
          output = output + excluded.output,
          cache_creation = cache_creation + excluded.cache_creation,
          cache_read = cache_read + excluded.cache_read,
          messages = messages + excluded.messages
      `);

      const applyBatch = db.transaction((rawLines: string[]) => {
        for (const line of rawLines) {
          const parsed = parseUsageLine(line);
          if (!parsed) continue;
          // Only count a message the first time we ever see its id.
          if (insertSeen.run(parsed.id).changes === 0) continue;
          upsertDaily.run({ date: parsed.day, model: parsed.model, ...parsed.row });
        }
      });
      applyBatch(lines);
    } finally {
      fs.closeSync(fd);
    }
  }

  const newOffset = stat.size - trailingPartialBytes;
  db.prepare(`
    INSERT INTO usage_files (path, mtime_ms, size, byte_offset)
    VALUES (@path, @mtime_ms, @size, @byte_offset)
    ON CONFLICT (path) DO UPDATE SET
      mtime_ms = excluded.mtime_ms,
      size = excluded.size,
      byte_offset = excluded.byte_offset
  `).run({
    path: filePath,
    mtime_ms: Math.floor(stat.mtimeMs),
    size: stat.size,
    byte_offset: newOffset,
  });
}

/** Incrementally fold any new log bytes into usage_daily. Throttled. */
export async function scanUsage(force = false): Promise<void> {
  if (!force && Date.now() - lastScanAt < SCAN_THROTTLE_MS) return;
  if (scanInFlight) return scanInFlight;

  scanInFlight = (async () => {
    const db = getConnection();
    const files = collectJsonlFiles(USAGE_ROOT);
    for (const file of files) {
      try {
        scanFile(db, file);
      } catch (err) {
        // One bad file must not abort the whole scan.
        console.error(`[usage-stats] failed to scan ${file}:`, (err as Error).message);
      }
    }
    lastScanAt = Date.now();
  })();

  try {
    await scanInFlight;
  } finally {
    scanInFlight = null;
  }
}

export const usageStatsDb = {
  scan: scanUsage,

  /**
   * Per-day × model token totals, newest day first. `from`/`to` are
   * inclusive YYYY-MM-DD bounds (omit for all history).
   */
  getDaily(from?: string, to?: string): DailyUsage[] {
    const db = getConnection();
    const where: string[] = [];
    const params: string[] = [];
    if (from) { where.push('date >= ?'); params.push(from); }
    if (to) { where.push('date <= ?'); params.push(to); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = db
      .prepare(`SELECT * FROM usage_daily ${whereSql} ORDER BY date DESC, model ASC`)
      .all(...params) as DailyRow[];

    const byDay = new Map<string, DailyUsage>();
    for (const r of rows) {
      let day = byDay.get(r.date);
      if (!day) {
        day = { date: r.date, models: {} };
        byDay.set(r.date, day);
      }
      day.models[r.model] = {
        input: r.input,
        output: r.output,
        cache_creation: r.cache_creation,
        cache_read: r.cache_read,
        total: r.input + r.output + r.cache_creation + r.cache_read,
        messages: r.messages,
      };
    }
    return [...byDay.values()];
  },

  /** Timezone the day buckets are computed in (for UI display). */
  timezone(): string {
    return USAGE_TZ;
  },
};
