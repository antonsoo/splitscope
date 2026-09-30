import { formatSeconds } from "../core/timespan.js";

/** Formats a delta (this − comparison) LiveSplit-style: a leading sign, dash when unknown. */
export function formatDelta(seconds: number | null): string {
  if (seconds === null) return "—";
  const sign = seconds > 0 ? "+" : seconds < 0 ? "−" : "";
  return `${sign}${formatSeconds(Math.abs(seconds))}`;
}

export function formatPercent(fraction: number | null, digits = 1): string {
  if (fraction === null || Number.isNaN(fraction)) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatHours(seconds: number): string {
  return `${(seconds / 3600).toFixed(1)}h`;
}

export { formatSeconds };

/** An attempts-count interval; an upper bound of `null` means the interval has no finite end. */
export function formatAttemptsRange(range: readonly [number | null, number | null]): string {
  const [lo, hi] = range;
  if (lo === null) return "—";
  const low = formatCount(Math.round(lo));
  return hi === null ? `${low} or more` : `${low} – ${formatCount(Math.round(hi))}`;
}
