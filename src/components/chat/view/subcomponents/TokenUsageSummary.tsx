import { ActivityIcon } from 'lucide-react';

type TokenUsageSummaryProps = {
  usage: Record<string, unknown> | null;
};

const formatTokenCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  // Thresholds sit where rounding would carry into the next unit, so 9,960 reads "10K", not "10.0K".
  if (value >= 999_500) {
    return `${(value / 1_000_000).toFixed(value >= 9_950_000 ? 0 : 1)}M`;
  }

  if (value >= 9_950) {
    return `${Math.round(value / 1_000)}K`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return value.toLocaleString();
};

const readUsageNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export default function TokenUsageSummary({ usage }: TokenUsageSummaryProps) {
  const breakdown =
    usage?.breakdown && typeof usage.breakdown === 'object'
      ? usage.breakdown as Record<string, unknown>
      : null;
  const inputTokens = readUsageNumber(usage?.inputTokens ?? breakdown?.input);
  const outputTokens = readUsageNumber(usage?.outputTokens ?? breakdown?.output);
  const usedTokens = readUsageNumber(usage?.used) || inputTokens + outputTokens;

  return (
    <div
      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground sm:gap-2 sm:px-2.5"
      title={`${usedTokens.toLocaleString()} tokens used`}
    >
      {/* Decorative icon hidden on phones so a wider count cannot push the
          composer buttons onto a second row. */}
      <span className="hidden h-5 w-5 place-items-center rounded-md bg-primary/10 text-primary sm:grid">
        <ActivityIcon className="h-3.5 w-3.5" />
      </span>
      <span className="font-medium text-foreground">{formatTokenCount(usedTokens)}</span>
      <span className="hidden text-muted-foreground/70 sm:inline">tokens</span>
    </div>
  );
}
