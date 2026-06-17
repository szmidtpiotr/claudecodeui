/**
 * Token-usage statistics repository.
 *
 * Reads Claude's session JSONL logs under ~/.claude/projects/ (including
 * subagent logs) and maintains a durable token aggregate in SQLite at the
 * finest granularity we report: local day × local hour × project × model.
 * Every view (daily, hourly, by-project) is a GROUP BY over usage_agg.
 *
 * Designed around three reliability facts established from real logs:
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
 * The day/hour buckets are LOCAL to CLAUDE_USAGE_TZ (default Europe/Warsaw),
 * baked in at scan time. Changing the timezone later does not retroactively
 * re-bucket already-aggregated history.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { getConnection } from '@/modules/database/connection.js';

const USAGE_ROOT = path.join(os.homedir(), '.claude', 'projects');
const USAGE_TZ = process.env.CLAUDE_USAGE_TZ || 'Europe/Warsaw';

// Don't re-walk the filesystem more than once per window unless forced.
const SCAN_THROTTLE_MS = 15_000;

// 'en-CA' formats the date as YYYY-MM-DD; 'h23' gives a 00–23 hour.
const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: USAGE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

type ModelTotals = {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
  total: number;
  messages: number;
};

export type DailyUsage = { date: string; models: Record<string, ModelTotals> };
export type HourlyUsage = { hour: number; models: Record<string, ModelTotals> };
export type ProjectUsage = { project: string; total: number; models: Record<string, ModelTotals> };

type SumRow = {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
  messages: number;
};

let lastScanAt = 0;
let scanInFlight: Promise<void> | null = null;

/** Local (CLAUDE_USAGE_TZ) calendar day + hour for an ISO timestamp. */
function localDayHour(timestamp: unknown): { day: string; hour: number } | null {
  if (typeof timestamp !== 'string') return null;
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return null;
  const parts = partsFormatter.formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  if (!year || !month || !day || hour === undefined) return null;
  return { day: `${year}-${month}-${day}`, hour: Number(hour) };
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

type ParsedLine = {
  id: string;
  day: string;
  hour: number;
  project: string;
  model: string;
  row: SumRow;
};

/**
 * Parse one JSONL line into a countable usage row, or null. Skips
 * non-assistant lines, synthetic messages, and anything missing an id.
 * `fallbackProject` is used when the line carries no `cwd`.
 */
function parseUsageLine(line: string, fallbackProject: string): ParsedLine | null {
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

  const when = localDayHour(obj?.timestamp);
  if (!when) return null;

  const cwd = obj?.cwd;
  const project = typeof cwd === 'string' && cwd ? path.basename(cwd) || fallbackProject : fallbackProject;

  return {
    id,
    day: when.day,
    hour: when.hour,
    project,
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

  // The top-level directory under the projects root identifies the project
  // when a line has no cwd of its own.
  const relative = path.relative(USAGE_ROOT, filePath);
  const fallbackProject = relative.split(path.sep)[0] || 'unknown';

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
      const upsertAgg = db.prepare(`
        INSERT INTO usage_agg (date, hour, project, model, input, output, cache_creation, cache_read, messages)
        VALUES (@date, @hour, @project, @model, @input, @output, @cache_creation, @cache_read, @messages)
        ON CONFLICT (date, hour, project, model) DO UPDATE SET
          input = input + excluded.input,
          output = output + excluded.output,
          cache_creation = cache_creation + excluded.cache_creation,
          cache_read = cache_read + excluded.cache_read,
          messages = messages + excluded.messages
      `);

      const applyBatch = db.transaction((rawLines: string[]) => {
        for (const line of rawLines) {
          const parsed = parseUsageLine(line, fallbackProject);
          if (!parsed) continue;
          // Only count a message the first time we ever see its id.
          if (insertSeen.run(parsed.id).changes === 0) continue;
          upsertAgg.run({
            date: parsed.day,
            hour: parsed.hour,
            project: parsed.project,
            model: parsed.model,
            ...parsed.row,
          });
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

/** Incrementally fold any new log bytes into usage_agg. Throttled. */
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

function toTotals(r: SumRow): ModelTotals {
  return {
    input: r.input,
    output: r.output,
    cache_creation: r.cache_creation,
    cache_read: r.cache_read,
    total: r.input + r.output + r.cache_creation + r.cache_read,
    messages: r.messages,
  };
}

const SUM_COLS = `
  SUM(input) AS input,
  SUM(output) AS output,
  SUM(cache_creation) AS cache_creation,
  SUM(cache_read) AS cache_read,
  SUM(messages) AS messages
`;

function dateRange(from?: string, to?: string): { whereSql: string; params: string[] } {
  const where: string[] = [];
  const params: string[] = [];
  if (from) { where.push('date >= ?'); params.push(from); }
  if (to) { where.push('date <= ?'); params.push(to); }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export const usageStatsDb = {
  scan: scanUsage,

  /** Per-day × model totals, newest day first. */
  getDaily(from?: string, to?: string): DailyUsage[] {
    const db = getConnection();
    const { whereSql, params } = dateRange(from, to);
    const rows = db
      .prepare(`SELECT date, model, ${SUM_COLS} FROM usage_agg ${whereSql} GROUP BY date, model ORDER BY date DESC, model ASC`)
      .all(...params) as (SumRow & { date: string; model: string })[];

    const byDay = new Map<string, DailyUsage>();
    for (const r of rows) {
      let day = byDay.get(r.date);
      if (!day) { day = { date: r.date, models: {} }; byDay.set(r.date, day); }
      day.models[r.model] = toTotals(r);
    }
    return [...byDay.values()];
  },

  /** Per-hour × model totals for one day (00–23, ascending). */
  getHourly(date: string): HourlyUsage[] {
    const db = getConnection();
    const rows = db
      .prepare(`SELECT hour, model, ${SUM_COLS} FROM usage_agg WHERE date = ? GROUP BY hour, model ORDER BY hour ASC`)
      .all(date) as (SumRow & { hour: number; model: string })[];

    const byHour = new Map<number, HourlyUsage>();
    for (const r of rows) {
      let h = byHour.get(r.hour);
      if (!h) { h = { hour: r.hour, models: {} }; byHour.set(r.hour, h); }
      h.models[r.model] = toTotals(r);
    }
    return [...byHour.values()];
  },

  /** Per-project × model totals over a date range, biggest project first. */
  getProjects(from?: string, to?: string): ProjectUsage[] {
    const db = getConnection();
    const { whereSql, params } = dateRange(from, to);
    const rows = db
      .prepare(`SELECT project, model, ${SUM_COLS} FROM usage_agg ${whereSql} GROUP BY project, model`)
      .all(...params) as (SumRow & { project: string; model: string })[];

    const byProject = new Map<string, ProjectUsage>();
    for (const r of rows) {
      let p = byProject.get(r.project);
      if (!p) { p = { project: r.project, total: 0, models: {} }; byProject.set(r.project, p); }
      const t = toTotals(r);
      p.models[r.model] = t;
      p.total += t.total;
    }
    return [...byProject.values()].sort((a, b) => b.total - a.total);
  },

  /** ISO timestamp of the last completed scan, or null if none yet. */
  lastScanAt(): string | null {
    return lastScanAt ? new Date(lastScanAt).toISOString() : null;
  },

  /** Timezone the buckets are computed in (for UI display). */
  timezone(): string {
    return USAGE_TZ;
  },
};
