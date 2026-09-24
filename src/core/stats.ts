/**
 * Descriptive statistics and derived analyses over a parsed {@link Run}.
 *
 * Every function here is a pure function of `(run, method, ...params)` —
 * no hidden state, no I/O — so each one is independently testable against
 * hand-computed values (see `tests/stats.test.ts`).
 */
import { PERSONAL_BEST, pick, type Run, type TimingMethod } from "./types.js";

/** Cumulative PB split time at segment `index` (0-based), or `null` if not recorded. */
export function pbCumulative(run: Run, index: number, method: TimingMethod): number | null {
  const segment = run.segments[index];
  if (!segment) return null;
  const split = segment.splitTimes.get(PERSONAL_BEST);
  return split ? pick(split, method) : null;
}

/** The PB's own duration for segment `index` (cumulative PB at `index` minus at `index - 1`). */
export function pbSegmentDuration(run: Run, index: number, method: TimingMethod): number | null {
  const current = pbCumulative(run, index, method);
  if (current === null) return null;
  if (index === 0) return current;
  const previous = pbCumulative(run, index - 1, method);
  if (previous === null) return null;
  return current - previous;
}

/** Total PB time (the cumulative PB split at the final segment). */
export function pbTotal(run: Run, method: TimingMethod): number | null {
  return run.segments.length === 0 ? null : pbCumulative(run, run.segments.length - 1, method);
}

/** Sum of best: the total if every segment's gold were run back to back. `complete` is false if any segment lacks a gold. */
export function sumOfBest(run: Run, method: TimingMethod): { value: number; complete: boolean } {
  let total = 0;
  let complete = true;
  for (const segment of run.segments) {
    const gold = pick(segment.bestSegmentTime, method);
    if (gold === null) {
      complete = false;
    } else {
      total += gold;
    }
  }
  return { value: total, complete };
}

/** Possible time save per segment: PB's own segment duration minus that segment's gold. `null` if either is unknown. */
export function possibleTimeSave(run: Run, method: TimingMethod): (number | null)[] {
  return run.segments.map((segment, index) => {
    const pbDuration = pbSegmentDuration(run, index, method);
    const gold = pick(segment.bestSegmentTime, method);
    if (pbDuration === null || gold === null) return null;
    return pbDuration - gold;
  });
}

export interface ConsistencyStats {
  readonly n: number;
  readonly median: number | null;
  readonly q1: number | null;
  readonly q3: number | null;
  readonly iqr: number | null;
  readonly stdDev: number | null;
  readonly percentWithinGold: number | null;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 1) return sorted[0] as number;
  const pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  const lowerVal = sorted[lower] as number;
  if (lower === upper) return lowerVal;
  const upperVal = sorted[upper] as number;
  return lowerVal + (upperVal - lowerVal) * (pos - lower);
}

/**
 * Consistency of one segment over its last `window` attempts: median, IQR,
 * (sample) standard deviation, and the share of those attempts within
 * `toleranceSeconds` of the segment's own gold. Skipped splits (a history
 * entry with no time recorded) are excluded, not treated as zero.
 */
export function segmentConsistency(
  run: Run,
  index: number,
  method: TimingMethod,
  window: number,
  toleranceSeconds: number,
): ConsistencyStats {
  const segment = run.segments[index];
  const empty: ConsistencyStats = {
    n: 0,
    median: null,
    q1: null,
    q3: null,
    iqr: null,
    stdDev: null,
    percentWithinGold: null,
  };
  if (!segment) return empty;

  const gold = pick(segment.bestSegmentTime, method);
  const recent = segment.history.slice(-window);
  const values = recent
    .map((h) => pick(h.time, method))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);

  if (values.length === 0) return empty;

  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.length > 1
      ? values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1)
      : 0;

  const withinGold =
    gold === null
      ? null
      : values.filter((v) => v <= gold + toleranceSeconds).length / values.length;

  return {
    n: values.length,
    median: quantile(values, 0.5),
    q1: quantile(values, 0.25),
    q3: quantile(values, 0.75),
    iqr: quantile(values, 0.75) - quantile(values, 0.25),
    stdDev: Math.sqrt(variance),
    percentWithinGold: withinGold,
  };
}

export interface TrendPoint {
  readonly attemptIndex: number;
  readonly attemptId: number;
  readonly totalSeconds: number;
}

export interface Trend {
  readonly points: readonly TrendPoint[];
  /** Seconds of change per attempt, from an ordinary least-squares fit (negative = improving). */
  readonly slopePerAttempt: number | null;
}

/** Improvement trend: finished attempts' total time, in run order, plus a linear-regression slope. */
export function improvementTrend(run: Run, method: TimingMethod): Trend {
  const points: TrendPoint[] = [];
  run.attempts.forEach((attempt, attemptIndex) => {
    const total = pick(attempt.time, method);
    if (total !== null) {
      points.push({ attemptIndex, attemptId: attempt.id, totalSeconds: total });
    }
  });

  if (points.length < 2) {
    return { points, slopePerAttempt: null };
  }

  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.attemptIndex, 0);
  const sumY = points.reduce((s, p) => s + p.totalSeconds, 0);
  const sumXY = points.reduce((s, p) => s + p.attemptIndex * p.totalSeconds, 0);
  const sumXX = points.reduce((s, p) => s + p.attemptIndex ** 2, 0);
  const denominator = n * sumXX - sumX * sumX;
  const slopePerAttempt = denominator === 0 ? null : (n * sumXY - sumX * sumY) / denominator;

  return { points, slopePerAttempt };
}

/**
 * The furthest segment index (0-based) an attempt's `SegmentHistory` entries
 * reach. `-1` means the attempt has no recorded segment history at all (it
 * reset before completing the first segment). This is the basis for both
 * reset/survival analysis and the Monte Carlo hazard model.
 */
export function furthestSegmentIndex(run: Run, attemptId: number): number {
  let furthest = -1;
  run.segments.forEach((segment, index) => {
    if (segment.history.some((h) => h.attemptId === attemptId)) furthest = index;
  });
  return furthest;
}

/** Whether an attempt finished the run (has an overall RealTime — the wall-clock completion signal). */
export function attemptFinished(run: Run, attemptId: number): boolean {
  const attempt = run.attempts.find((a) => a.id === attemptId);
  return attempt !== undefined && attempt.time.realTime !== null;
}

export interface SurvivalPoint {
  readonly segmentIndex: number;
  readonly segmentName: string;
  /** Share of all attempts that reached (started attempting) this segment. */
  readonly survivalRate: number;
  /** Count of attempts that reset while attempting this specific segment. */
  readonly deaths: number;
}

export interface ResetAnalysis {
  readonly totalAttempts: number;
  readonly finishedAttempts: number;
  readonly points: readonly SurvivalPoint[];
}

/** Survival curve and "where runs die" histogram, over every recorded attempt. */
export function resetAnalysis(run: Run): ResetAnalysis {
  const n = run.segments.length;
  const furthest = run.attempts.map((a) => ({
    id: a.id,
    furthest: furthestSegmentIndex(run, a.id),
    finished: a.time.realTime !== null,
  }));
  const total = furthest.length;

  const points: SurvivalPoint[] = [];
  for (let i = 0; i < n; i++) {
    const started = furthest.filter((a) => a.furthest >= i - 1).length;
    const deaths = furthest.filter((a) => !a.finished && a.furthest === i - 1).length;
    points.push({
      segmentIndex: i,
      segmentName: run.segments[i]?.name ?? `Segment ${i + 1}`,
      survivalRate: total === 0 ? 0 : started / total,
      deaths,
    });
  }

  return {
    totalAttempts: total,
    finishedAttempts: furthest.filter((a) => a.finished).length,
    points,
  };
}

export interface PlaytimeSummary {
  readonly totalAttempts: number;
  readonly finishedAttempts: number;
  /** Wall-clock seconds, summed from `ended - started` where both are known. */
  readonly totalPlaytimeSeconds: number;
  /** Attempts lacking a `started`/`ended` timestamp pair, excluded from the playtime sum. */
  readonly attemptsMissingTimestamps: number;
}

function parseLiveSplitTimestamp(text: string): number | null {
  // LiveSplit writes "M/D/YYYY H:mm:ss" (see docs/format.md); Date.parse doesn't reliably
  // accept that shape across engines, so it's parsed by hand.
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [, month, day, year, hour, minute, second] = m;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
}

export function playtimeSummary(run: Run): PlaytimeSummary {
  let totalPlaytimeSeconds = 0;
  let attemptsMissingTimestamps = 0;
  let finishedAttempts = 0;

  for (const attempt of run.attempts) {
    if (attempt.time.realTime !== null) finishedAttempts++;
    const started = attempt.started === null ? null : parseLiveSplitTimestamp(attempt.started);
    const ended = attempt.ended === null ? null : parseLiveSplitTimestamp(attempt.ended);
    if (started === null || ended === null || ended < started) {
      attemptsMissingTimestamps++;
      continue;
    }
    totalPlaytimeSeconds += (ended - started) / 1000;
  }

  return {
    totalAttempts: run.attempts.length,
    finishedAttempts,
    totalPlaytimeSeconds,
    attemptsMissingTimestamps,
  };
}

export interface GoldHistoryPoint {
  readonly attemptId: number;
  readonly seconds: number;
}

/** The sequence of new segment records over time (a running minimum of the segment's history). */
export function goldHistory(run: Run, index: number, method: TimingMethod): GoldHistoryPoint[] {
  const segment = run.segments[index];
  if (!segment) return [];
  const points: GoldHistoryPoint[] = [];
  let best = Number.POSITIVE_INFINITY;
  for (const entry of segment.history) {
    const value = pick(entry.time, method);
    if (value !== null && value < best) {
      best = value;
      points.push({ attemptId: entry.attemptId, seconds: value });
    }
  }
  return points;
}

/**
 * Standard normal CDF via the Abramowitz & Stegun 7.1.26 rational
 * approximation (max absolute error ~1.5e-7). Used to cross-check the Monte
 * Carlo PB-odds simulation against the closed-form answer for independent
 * normal segment times (see `tests/montecarlo.test.ts`), and exposed for the
 * UI's confidence-interval display.
 */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}
