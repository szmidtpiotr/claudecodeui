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

type DailyUsage = { date: string; models: Record<string, ModelTotals> };
type HourlyUsage = { hour: number; models: Record<string, ModelTotals> };
type ProjectUsage = { project: string; total: number; models: Record<string, ModelTotals> };

type DailyResponse = { success: boolean; timezone: string; updatedAt: string | null; days: DailyUsage[] };
type HourlyResponse = { success: boolean; date: string; hours: HourlyUsage[] };
type ProjectsResponse = { success: boolean; projects: ProjectUsage[] };

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

type Bucket = { label: string; models: Record<string, ModelTotals> };

/** Vertical stacked-bar chart over an ordered list of buckets (days or hours). */
function StackedBars({
  buckets,
  models,
  hideCacheRead,
  percentMode,
}: {
  buckets: Bucket[];
  models: string[];
  hideCacheRead: boolean;
  percentMode: boolean;
}) {
  const totals = buckets.map((b) =>
    models.reduce((sum, m) => sum + (b.models[m] ? modelTotal(b.models[m], hideCacheRead) : 0), 0),
  );
  const maxTotal = Math.max(1, ...totals);

  const H = 160;
  const labelH = 18;
  const colGap = 4;
  const n = buckets.length;
  const colW = n > 0 ? Math.max(6, Math.min(48, (640 - colGap * n) / n)) : 24;
  const W = n * (colW + colGap) + colGap;

  return (
    <svg
      viewBox={`0 0 ${Math.max(W, 320)} ${H + labelH}`}
      className="h-[178px] w-full"
      preserveAspectRatio="xMidYMax meet"
    >
      {buckets.map((b, i) => {
        const x = colGap + i * (colW + colGap);
        const total = totals[i];
        const scaleTotal = percentMode ? total || 1 : maxTotal;
        const barH = percentMode ? (total > 0 ? H : 0) : (total / maxTotal) * H;
        let yCursor = H - barH;
        const segments = models
          .filter((m) => b.models[m])
          .map((m) => {
            const val = modelTotal(b.models[m], hideCacheRead);
            const segH = scaleTotal > 0 ? (val / scaleTotal) * barH : 0;
            const seg = { m, y: yCursor, h: segH, val };
            yCursor += segH;
            return seg;
          });
        return (
          <g key={b.label + i}>
            {segments.map((s) => (
              <rect key={s.m} x={x} y={s.y} width={colW} height={Math.max(0, s.h)} fill={modelColor(s.m)} rx={1}>
                <title>{`${b.label} · ${modelShortName(s.m)}: ${fullNumber(s.val)}`}</title>
              </rect>
            ))}
            <text
              x={x + colW / 2}
              y={H + labelH - 5}
              textAnchor="middle"
              className="fill-muted-foreground"
              style={{ fontSize: 8 }}
            >
              {b.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default function UsageStatsTab() {
  const [data, setData] = useState<DailyResponse | null>(null);
  const [projects, setProjects] = useState<ProjectUsage[]>([]);
  const [hourly, setHourly] = useState<Record<string, HourlyUsage[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<RangeKey>('7');
  const [hideCacheRead, setHideCacheRead] = useState(false);
  const [percentMode, setPercentMode] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Models toggled off via the legend — excluded from the charts and the Σ.
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const fromParam = useMemo(() => (range === 'all' ? '' : isoDaysAgo(Number(range))), [range]);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (fromParam) params.set('from', fromParam);
      const projParams = params.toString();
      if (refresh) params.set('refresh', '1');
      const [dRes, pRes] = await Promise.all([
        authenticatedFetch(`/api/usage/daily?${params.toString()}`),
        authenticatedFetch(`/api/usage/projects?${projParams}`),
      ]);
      if (!dRes.ok) throw new Error(`HTTP ${dRes.status}`);
      const dJson: DailyResponse = await dRes.json();
      setData(dJson);
      setHourly({}); // range changed — drop cached hourly breakdowns
      if (pRes.ok) {
        const pJson: ProjectsResponse = await pRes.json();
        setProjects(pJson.projects ?? []);
      }
      if (dJson.days.length) setExpanded(new Set([dJson.days[0].date]));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [fromParam]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const fetchHourly = useCallback(async (date: string) => {
    if (hourly[date]) return;
    try {
      const res = await authenticatedFetch(`/api/usage/hourly?date=${date}`);
      if (!res.ok) return;
      const json: HourlyResponse = await res.json();
      setHourly((prev) => ({ ...prev, [date]: json.hours ?? [] }));
    } catch {
      /* non-fatal — hourly chart just won't render */
    }
  }, [hourly]);

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

  const visibleModels = useMemo(() => models.filter((m) => !hidden.has(m)), [models, hidden]);

  const grandTotal = useMemo(
    () =>
      days.reduce(
        (sum, d) =>
          sum +
          Object.entries(d.models).reduce((s, [m, t]) => (hidden.has(m) ? s : s + modelTotal(t, hideCacheRead)), 0),
        0,
      ),
    [days, hideCacheRead, hidden],
  );

  const dayBuckets = useMemo<Bucket[]>(
    () => [...days].reverse().map((d) => ({ label: d.date.slice(5), models: d.models })),
    [days],
  );

  const toggleModel = (model: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });

  const toggleDay = (date: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(date)) {
        next.delete(date);
      } else {
        next.add(date);
        void fetchHourly(date);
      }
      return next;
    });

  // Open day already expanded on first load needs its hourly data too.
  useEffect(() => {
    for (const date of expanded) void fetchHourly(date);
  }, [expanded, fetchHourly]);

  const updatedLabel = data?.updatedAt
    ? new Date(data.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;

  const maxProjectTotal = useMemo(
    () =>
      Math.max(
        1,
        ...projects.map((p) =>
          Object.entries(p.models).reduce((s, [m, t]) => (hidden.has(m) ? s : s + modelTotal(t, hideCacheRead)), 0),
        ),
      ),
    [projects, hidden, hideCacheRead],
  );

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
            {updatedLabel && <> · updated {updatedLabel}</>}
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

          {/* Daily chart + legend */}
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <StackedBars buckets={dayBuckets} models={visibleModels} hideCacheRead={hideCacheRead} percentMode={percentMode} />
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {models.map((m) => {
                const isHidden = hidden.has(m);
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => toggleModel(m)}
                    title={isHidden ? 'Click to show' : 'Click to hide'}
                    className={`flex items-center gap-1.5 rounded px-1 text-[11px] transition-opacity hover:bg-muted/50 ${
                      isHidden ? 'text-muted-foreground/50 line-through' : 'text-muted-foreground'
                    }`}
                  >
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-sm"
                      style={{ backgroundColor: isHidden ? 'transparent' : modelColor(m), border: `1.5px solid ${modelColor(m)}` }}
                    />
                    {modelShortName(m)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* By project */}
          {projects.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">By project</h4>
              <div className="space-y-1.5 rounded-lg border border-border bg-muted/20 p-3">
                {projects.map((p) => {
                  const visTotal = Object.entries(p.models).reduce(
                    (s, [m, t]) => (hidden.has(m) ? s : s + modelTotal(t, hideCacheRead)),
                    0,
                  );
                  return (
                    <div key={p.project} className="flex items-center gap-2 text-xs">
                      <span className="w-32 flex-shrink-0 truncate text-foreground" title={p.project}>{p.project}</span>
                      <div className="flex h-3 flex-1 overflow-hidden rounded bg-muted" style={{ maxWidth: `${(visTotal / maxProjectTotal) * 100}%` }}>
                        {visibleModels.map((m) => {
                          const t = p.models[m];
                          if (!t) return null;
                          const val = modelTotal(t, hideCacheRead);
                          if (val <= 0 || visTotal <= 0) return null;
                          return (
                            <div
                              key={m}
                              style={{ width: `${(val / visTotal) * 100}%`, backgroundColor: modelColor(m) }}
                              title={`${p.project} · ${modelShortName(m)}: ${fullNumber(val)}`}
                            />
                          );
                        })}
                      </div>
                      <span className="w-14 flex-shrink-0 text-right tabular-nums text-muted-foreground" title={fullNumber(visTotal)}>
                        {formatTokens(visTotal)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Daily breakdown table */}
          <div className="space-y-2">
            {days.map((d) => {
              const dayTotal = Object.entries(d.models).reduce((s, [m, t]) => (hidden.has(m) ? s : s + modelTotal(t, hideCacheRead)), 0);
              const isOpen = expanded.has(d.date);
              const modelEntries = Object.entries(d.models).sort((a, b) => b[1].total - a[1].total);
              const hourBuckets: Bucket[] = (hourly[d.date] ?? []).map((h) => ({
                label: String(h.hour).padStart(2, '0'),
                models: h.models,
              }));
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
                    <div>
                      {hourBuckets.length > 0 && (
                        <div className="border-t border-border bg-muted/10 px-3 py-2">
                          <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">By hour ({data?.timezone})</p>
                          <StackedBars buckets={hourBuckets} models={visibleModels} hideCacheRead={hideCacheRead} percentMode={percentMode} />
                        </div>
                      )}
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
