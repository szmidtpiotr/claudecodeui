import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';

import { Button } from '../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../utils/api';

type ModelTotals = {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
  total: number;
  messages: number;
};

type DailyUsage = {
  date: string;
  models: Record<string, ModelTotals>;
};

type DailyResponse = {
  success: boolean;
  timezone: string;
  days: DailyUsage[];
};

type RangeKey = '7' | '30' | 'all';

// Stable, theme-friendly palette. Known models get a fixed hue; anything
// else falls back to a hash so colours stay consistent across renders.
const MODEL_COLORS: Record<string, string> = {
  opus: '#a855f7',
  sonnet: '#3b82f6',
  haiku: '#14b8a6',
  fable: '#f97316',
};

function modelShortName(model: string): string {
  // claude-opus-4-8 -> opus-4-8 ; claude-haiku-4-5-20251001 -> haiku-4-5
  return model
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '');
}

function modelColor(model: string): string {
  const lower = model.toLowerCase();
  for (const key of Object.keys(MODEL_COLORS)) {
    if (lower.includes(key)) return MODEL_COLORS[key];
  }
  let hash = 0;
  for (let i = 0; i < model.length; i++) hash = (hash * 31 + model.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 65% 55%)`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

const fullNumber = (n: number) => n.toLocaleString();

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days + 1);
  return d.toISOString().slice(0, 10);
}

/** Sum the four token buckets for a model, optionally excluding cache_read. */
function modelTotal(m: ModelTotals, hideCacheRead: boolean): number {
  return hideCacheRead ? m.input + m.output + m.cache_creation : m.total;
}

function StackedBarChart({
  days,
  models,
  hideCacheRead,
  percentMode,
}: {
  days: DailyUsage[];
  models: string[];
  hideCacheRead: boolean;
  percentMode: boolean;
}) {
  // Oldest -> newest along the x-axis.
  const ordered = [...days].reverse();
  const dayTotals = ordered.map((d) =>
    models.reduce((sum, m) => sum + (d.models[m] ? modelTotal(d.models[m], hideCacheRead) : 0), 0),
  );
  const maxTotal = Math.max(1, ...dayTotals);

  const H = 180;
  const labelH = 22;
  const colGap = 6;
  const n = ordered.length;
  const colW = n > 0 ? Math.max(8, Math.min(48, (640 - colGap * n) / n)) : 24;
  const W = n * (colW + colGap) + colGap;

  return (
    <svg
      viewBox={`0 0 ${Math.max(W, 320)} ${H + labelH}`}
      className="h-[202px] w-full"
      preserveAspectRatio="xMidYMax meet"
    >
      {ordered.map((d, i) => {
        const x = colGap + i * (colW + colGap);
        const dayTotal = dayTotals[i];
        const scaleTotal = percentMode ? dayTotal || 1 : maxTotal;
        const barH = percentMode ? H : (dayTotal / maxTotal) * H;
        let yCursor = H - barH;
        const segments = models
          .filter((m) => d.models[m])
          .map((m) => {
            const val = modelTotal(d.models[m], hideCacheRead);
            const segH = scaleTotal > 0 ? (val / scaleTotal) * barH : 0;
            const seg = { m, y: yCursor, h: segH, val };
            yCursor += segH;
            return seg;
          });
        return (
          <g key={d.date}>
            {segments.map((s) => (
              <rect
                key={s.m}
                x={x}
                y={s.y}
                width={colW}
                height={Math.max(0, s.h)}
                fill={modelColor(s.m)}
                rx={1}
              >
                <title>{`${d.date} · ${modelShortName(s.m)}: ${fullNumber(s.val)}`}</title>
              </rect>
            ))}
            <text
              x={x + colW / 2}
              y={H + labelH - 6}
              textAnchor="middle"
              className="fill-muted-foreground"
              style={{ fontSize: 9 }}
            >
              {d.date.slice(5)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default function UsageStatsTab() {
  const [data, setData] = useState<DailyResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<RangeKey>('7');
  const [hideCacheRead, setHideCacheRead] = useState(false);
  const [percentMode, setPercentMode] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (range !== 'all') params.set('from', isoDaysAgo(Number(range)));
      if (refresh) params.set('refresh', '1');
      const res = await authenticatedFetch(`/api/usage/daily?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: DailyResponse = await res.json();
      setData(json);
      // Auto-expand the most recent day for quick reading.
      if (json.days.length) setExpanded(new Set([json.days[0].date]));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const days = useMemo(() => data?.days ?? [], [data]);

  // Models present across the range, ordered by overall token volume.
  const models = useMemo(() => {
    const totals = new Map<string, number>();
    for (const d of days) {
      for (const [m, t] of Object.entries(d.models)) {
        totals.set(m, (totals.get(m) ?? 0) + t.total);
      }
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  }, [days]);

  const grandTotal = useMemo(
    () => days.reduce((sum, d) => sum + Object.values(d.models).reduce((s, m) => s + modelTotal(m, hideCacheRead), 0), 0),
    [days, hideCacheRead],
  );

  const toggleDay = (date: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <BarChart3 className="h-4 w-4" /> Usage Stats
          </h3>
          <p className="text-xs text-muted-foreground">
            Tokens per day, per model · timezone {data?.timezone ?? '…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-border">
            {(['7', '30', 'all'] as RangeKey[]).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                  range === r ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50'
                }`}
              >
                {r === 'all' ? 'All' : `${r}d`}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={() => load(true)} disabled={loading} className="h-8 w-8 p-0">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">
          Failed to load usage: {error}
        </div>
      )}

      {!error && days.length === 0 && !loading && (
        <p className="py-8 text-center text-sm text-muted-foreground">No usage recorded yet.</p>
      )}

      {days.length > 0 && (
        <>
          {/* Chart controls */}
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <label className="flex items-center gap-1.5 text-muted-foreground">
              <input type="checkbox" checked={hideCacheRead} onChange={(e) => setHideCacheRead(e.target.checked)} />
              Hide cache reads
            </label>
            <label className="flex items-center gap-1.5 text-muted-foreground">
              <input type="checkbox" checked={percentMode} onChange={(e) => setPercentMode(e.target.checked)} />
              % share
            </label>
            <span className="ml-auto text-muted-foreground">
              Σ range: <span className="font-semibold tabular-nums text-foreground">{fullNumber(grandTotal)}</span> tokens
            </span>
          </div>

          {/* Chart */}
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <StackedBarChart days={days} models={models} hideCacheRead={hideCacheRead} percentMode={percentMode} />
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {models.map((m) => (
                <span key={m} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: modelColor(m) }} />
                  {modelShortName(m)}
                </span>
              ))}
            </div>
          </div>

          {/* Daily breakdown table */}
          <div className="space-y-2">
            {days.map((d) => {
              const dayTotal = Object.values(d.models).reduce((s, m) => s + modelTotal(m, hideCacheRead), 0);
              const isOpen = expanded.has(d.date);
              const modelEntries = Object.entries(d.models).sort((a, b) => b[1].total - a[1].total);
              return (
                <div key={d.date} className="overflow-hidden rounded-lg border border-border">
                  <button
                    onClick={() => toggleDay(d.date)}
                    className="flex w-full items-center justify-between bg-muted/30 px-3 py-2 text-sm hover:bg-muted/50"
                  >
                    <span className="flex items-center gap-2 font-medium text-foreground">
                      {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      {d.date}
                    </span>
                    <span className="text-muted-foreground">
                      Σ <span className="font-semibold tabular-nums text-foreground" title={fullNumber(dayTotal)}>{formatTokens(dayTotal)}</span>
                    </span>
                  </button>
                  {isOpen && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-t border-border text-muted-foreground">
                            <th className="px-3 py-1.5 text-left font-medium">Model</th>
                            <th className="px-3 py-1.5 text-right font-medium">input</th>
                            <th className="px-3 py-1.5 text-right font-medium">output</th>
                            <th className="px-3 py-1.5 text-right font-medium">cache·crt</th>
                            <th className="px-3 py-1.5 text-right font-medium">cache·rd</th>
                            <th className="px-3 py-1.5 text-right font-medium">total</th>
                          </tr>
                        </thead>
                        <tbody className="tabular-nums">
                          {modelEntries.map(([m, t]) => (
                            <tr key={m} className="border-t border-border/50">
                              <td className="px-3 py-1.5 text-left">
                                <span className="flex items-center gap-1.5 text-foreground">
                                  <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: modelColor(m) }} />
                                  {modelShortName(m)}
                                </span>
                              </td>
                              <td className="px-3 py-1.5 text-right" title={fullNumber(t.input)}>{formatTokens(t.input)}</td>
                              <td className="px-3 py-1.5 text-right" title={fullNumber(t.output)}>{formatTokens(t.output)}</td>
                              <td className="px-3 py-1.5 text-right" title={fullNumber(t.cache_creation)}>{formatTokens(t.cache_creation)}</td>
                              <td className="px-3 py-1.5 text-right" title={fullNumber(t.cache_read)}>{formatTokens(t.cache_read)}</td>
                              <td className="px-3 py-1.5 text-right font-semibold text-foreground" title={fullNumber(t.total)}>{formatTokens(t.total)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
