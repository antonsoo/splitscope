import { formatSeconds } from "../core/timespan.js";

/** Formats a delta (this − comparison) LiveSplit-style: a leading sign, dash when unknown. */
export function formatDelta(seconds: number | null): string {
  if (seconds === null) return "—";
  const sign = seconds > 0 ? "+" : seconds < 0 ? "−" : "";
  return `${sign}${formatSeconds(Math.abs(seconds))}`;
}

/** Which semantic color a delta should render in: green if ahead, red if behind, gold if exactly gold-tying. */
export function deltaClass(seconds: number | null): "is-green" | "is-red" | "is-flat" {
  if (seconds === null) return "is-flat";
  if (seconds < 0) return "is-green";
  if (seconds > 0) return "is-red";
  return "is-flat";
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
