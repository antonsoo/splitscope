// Prototype variants of src/core/montecarlo.ts used by the study (pool, joint, trend, hazardPrior).
// Defaults reproduce the checkout before the study's change. Not shipped.
/**
 * Monte Carlo model for PB odds.
 *
 * The model: a simulated attempt walks through the segments in order. At
 * each segment it first rolls the segment's empirical **reset hazard** (the
 * historical probability of resetting while attempting that segment, given
 * the run got that far); if it survives, it draws a duration by
 * **bootstrap resampling** (sampling with replacement) from that segment's
 * own recent `SegmentHistory` times. This is deliberately simple: it is two
 * well-known, auditable techniques (bootstrap + hazard simulation) composed
 * segment by segment, not a black box.
 *
 * Two simplifying assumptions make this tractable. Real runs have more
 * structure; departures from these assumptions can bias results in either direction:
 *
 * 1. **Independence between segments.** A slow Segment 2 doesn't make
 *    Segment 3 more or less likely to be slow, even though in practice a
 *    bad split can rattle a runner or a fast split can reflect them being
 *    "on it" that session.
 * 2. **Stationarity.** The recent-window sample is assumed to represent the
 *    runner's *current* skill for the whole simulated future, i.e. they are
 *    not still improving (or fatiguing) attempt to attempt.
 *
 * `tests/montecarlo.test.ts` checks this implementation against two
 * closed-form oracles: a zero-variance constant-time case, and independent
 * normal segment times (via `normalCdf`).
 */
import { mulberry32, type Rng, seedFromString } from "../../src/core/rng.js";
import {
  hasCompletionTime,
  normalCdf,
  reachedSegmentIndex,
  segmentTimes,
} from "../../src/core/stats.js";
import { type Attempt, pick, type Run, type TimingMethod } from "../../src/core/types.js";

export interface PbOddsOptions {
  readonly method: TimingMethod;
  /** How many of the most recent attempts to treat as "current form" for both sampling and hazard. */
  readonly recentWindow: number;
  readonly simulations: number;
  readonly seed?: number;
  /** Attempts to look ahead for "probability of at least one PB in the next K". */
  readonly lookaheadAttempts: number;
  /**
   * Which attempts supply the segment durations. `"all"` (the default) uses every attempt in
   * the window; `"finished"` uses only completed attempts, so durations are conditioned on
   * the run having survived to the end.
   */
  readonly pool?: "all" | "finished";
  /** With `pool: "finished"`: widen the duration window backwards until it holds this many completed attempts. */
  readonly minFinishedRuns?: number;
  /** Draw a surviving attempt's segment times together from one past completed run instead of segment by segment. */
  readonly joint?: boolean;
  /**
   * Shift simulated totals by the improvement rate fitted to recent completed attempts
   * (log-linear in attempt number), to the middle of the look-ahead. Never below the sum of
   * the best durations seen so far.
   */
  readonly trend?: boolean | "improving" | "shrunk";
  /** Widen the window, for sampling and hazard alike, until every segment has this many timed samples. */
  readonly minSegmentSamples?: number;
  /** Pseudo-attempts that pull each segment's reset hazard toward the run-wide per-segment rate. */
  readonly hazardPrior?: number;
  /** Completed attempts used for the trend fit (default 20); the fit needs at least 6. */
  readonly trendFinishes?: number;
}

export interface PbOddsResult {
  readonly simulations: number;
  readonly pbTime: number | null;
  readonly recentAttempts: number;
  readonly finishProbability: number | null;
  readonly pbProbabilityGivenFinish: number | null;
  /** Unconditional probability a single future attempt both finishes and beats PB. */
  readonly pbProbabilityPerAttempt: number | null;
  /** 95% Wilson score confidence interval on {@link pbProbabilityPerAttempt}. */
  readonly pbProbabilityPerAttemptCi: readonly [number | null, number | null];
  readonly lookaheadAttempts: number;
  /** P(at least one PB in the next `lookaheadAttempts`), assuming independent attempts. */
  readonly probabilityAtLeastOnePb: number | null;
  /** {@link pbProbabilityPerAttemptCi} carried through the same formula (it is monotonic in p). */
  readonly probabilityAtLeastOnePbCi: readonly [number | null, number | null];
  /** Geometric-distribution expected attempts to first PB; `null` if the per-attempt probability is 0. */
  readonly expectedAttemptsUntilPb: number | null;
  /** `1 / p` at the CI's upper and lower ends; the upper bound is `null` (unbounded) when the CI reaches 0. */
  readonly expectedAttemptsUntilPbCi: readonly [number | null, number | null];
  readonly insufficientData: boolean;
  readonly unavailableReason: string | null;
  readonly assumptions: readonly string[];
}

const ASSUMPTIONS = [
  "Segment times are drawn independently of each other (a slow segment doesn't change the odds of the next one being slow or fast).",
  "The recent-form window is assumed stationary: it represents skill for every simulated future attempt, not a runner who is still improving.",
  "Reset hazard per segment is estimated from historical frequency and assumed constant going forward.",
  "Attempts are treated as independent trials when combining single-attempt odds into a multi-attempt probability.",
  "The 95% intervals cover simulation noise only: they narrow as you add simulations, not as you add attempts, so they don't measure how well the recent-form window represents you.",
];

/**
 * 95% Wilson score interval for a binomial proportion. Preferred over the
 * simpler Wald interval (`p ± z·√(p(1−p)/n)`) here specifically because PB
 * probabilities in this domain are frequently under 1%: Wald's coverage
 * degrades badly for proportions near 0 or 1 (it can even produce a
 * negative lower bound before clamping), while Wilson stays well-calibrated
 * across the whole range without needing an ad hoc clamp.
 */
function wilsonCi(p: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

interface SegmentModel {
  readonly pool: readonly number[];
  readonly hazard: number;
}

interface Models {
  readonly segments: readonly SegmentModel[];
  /** One complete duration vector per past completed attempt, or null when `joint` is off. */
  readonly runs: readonly (readonly number[])[] | null;
}

function buildSegmentModels(
  run: Run,
  method: TimingMethod,
  window: number,
  options: Pick<PbOddsOptions, "pool" | "minFinishedRuns" | "joint" | "hazardPrior">,
): Models {
  const attemptsInWindow = run.attempts.slice(-window);
  const idsInWindow = new Set(attemptsInWindow.map((a) => a.id));
  const furthestById = new Map(attemptsInWindow.map((a) => [a.id, reachedSegmentIndex(run, a)]));
  const finishedIds = new Set(attemptsInWindow.filter(hasCompletionTime).map((a) => a.id));

  // Attempts whose durations feed the pools. By default that is the window itself.
  let poolIds = idsInWindow;
  if (options.pool === "finished") {
    const wanted = Math.max(0, options.minFinishedRuns ?? 0);
    let from = Math.max(0, run.attempts.length - window);
    let have = run.attempts.slice(from).filter(hasCompletionTime).length;
    while (have < wanted && from > 0) {
      from--;
      if (hasCompletionTime(run.attempts[from] as Attempt)) have++;
    }
    poolIds = new Set(
      run.attempts
        .slice(from)
        .filter(hasCompletionTime)
        .map((a) => a.id),
    );
  }

  const segments = run.segments.map((_segment, i) => {
    // The segment's own durations only: a skipped split and the combined time
    // recorded after one are left out (see `segmentTimes`).
    const pool = segmentTimes(run, i, method)
      .filter((t) => poolIds.has(t.attemptId))
      .map((t) => t.seconds)
      .filter((v): v is number => v !== null);

    const started = attemptsInWindow.filter((a) => (furthestById.get(a.id) ?? -1) >= i - 1).length;
    const deaths = attemptsInWindow.filter(
      (a) => !finishedIds.has(a.id) && (furthestById.get(a.id) ?? -1) === i - 1,
    ).length;
    return { pool, started, deaths };
  });
  const totalStarted = segments.reduce((sum, m) => sum + m.started, 0);
  const meanHazard =
    totalStarted === 0 ? 0 : segments.reduce((sum, m) => sum + m.deaths, 0) / totalStarted;
  const prior = Math.max(0, options.hazardPrior ?? 0);
  const segmentModels: SegmentModel[] = segments.map((m) => ({
    pool: m.pool,
    hazard: m.started + prior === 0 ? 0 : (m.deaths + prior * meanHazard) / (m.started + prior),
  }));

  let runs: number[][] | null = null;
  if (options.joint) {
    const byAttempt = new Map<number, number[]>();
    run.segments.forEach((_segment, i) => {
      for (const t of segmentTimes(run, i, method)) {
        if (!poolIds.has(t.attemptId) || t.seconds === null) continue;
        const v = byAttempt.get(t.attemptId) ?? [];
        v[i] = t.seconds;
        byAttempt.set(t.attemptId, v);
      }
    });
    runs = [...byAttempt.values()].filter(
      (v) => v.length === run.segments.length && v.every((x) => x !== undefined),
    );
  }
  return { segments: segmentModels, runs };
}

function simulateOne(rng: Rng, models: Models): number | null {
  let total = 0;
  for (const model of models.segments) {
    if (rng() < model.hazard) return null;
    if (model.pool.length === 0) return null;
    if (models.runs === null) {
      const index = Math.floor(rng() * model.pool.length);
      total += model.pool[Math.min(index, model.pool.length - 1)] as number;
    }
  }
  if (models.runs !== null) {
    if (models.runs.length === 0) return null;
    const run =
      models.runs[Math.min(Math.floor(rng() * models.runs.length), models.runs.length - 1)];
    for (const v of run as readonly number[]) total += v;
  }
  return total;
}

/**
 * The recent window, widened until each segment has `minSamples` timed durations in it.
 * Never narrower than `window`; all attempts if the history cannot supply that many.
 */
export function effectiveWindow(
  run: Run,
  method: TimingMethod,
  window: number,
  minSamples: number,
): number {
  if (minSamples <= 0) return window;
  const n = run.attempts.length;
  const ordinal = new Map(run.attempts.map((a, i) => [a.id, i]));
  let needed = window;
  for (let i = 0; i < run.segments.length; i++) {
    const positions = segmentTimes(run, i, method)
      .filter((t) => t.seconds !== null && ordinal.has(t.attemptId))
      .map((t) => ordinal.get(t.attemptId) as number)
      .sort((a, b) => b - a);
    const nth = positions[minSamples - 1];
    needed = Math.max(needed, nth === undefined ? n : n - nth);
  }
  return Math.min(needed, Math.max(n, window));
}

/**
 * Least-squares slope of log(overall time) against attempt number over the last `count`
 * completed attempts, plus the mean attempt number of those. `null` below 6 completions.
 */
export function improvementSlope(
  run: Run,
  method: TimingMethod,
  count: number,
): { slope: number; centre: number; se: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  run.attempts.forEach((a, i) => {
    const t = pick(a.time, method);
    if (t !== null && t > 0) {
      xs.push(i);
      ys.push(Math.log(t));
    }
  });
  const x = xs.slice(-count);
  const y = ys.slice(-count);
  if (x.length < 6) return null;
  const mx = x.reduce((s, v) => s + v, 0) / x.length;
  const my = y.reduce((s, v) => s + v, 0) / y.length;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += ((x[i] as number) - mx) * ((y[i] as number) - my);
    sxx += ((x[i] as number) - mx) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  let sse = 0;
  for (let i = 0; i < x.length; i++) {
    sse += ((y[i] as number) - my - slope * ((x[i] as number) - mx)) ** 2;
  }
  return { slope, centre: mx, se: Math.sqrt(sse / (x.length - 2) / sxx) };
}

/** Runs the Monte Carlo PB-odds simulation described above. */
export function simulatePbOdds(
  run: Run,
  pbTime: number | null,
  options: PbOddsOptions,
): PbOddsResult {
  for (const [name, value] of Object.entries({
    recentWindow: options.recentWindow,
    simulations: options.simulations,
    lookaheadAttempts: options.lookaheadAttempts,
  })) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`${name} must be a positive safe integer.`);
  }
  if (options.simulations > 1_000_000)
    throw new RangeError("At most 1,000,000 simulations are supported.");
  if (pbTime !== null && !Number.isFinite(pbTime))
    throw new RangeError("PB time must be finite or null.");
  const window = effectiveWindow(
    run,
    options.method,
    options.recentWindow,
    options.minSegmentSamples ?? 0,
  );
  const models = buildSegmentModels(run, options.method, window, options);
  const unknownOutcome = run.attempts
    .slice(-window)
    .some((a) => !hasCompletionTime(a) && reachedSegmentIndex(run, a) >= run.segments.length - 1);
  const unavailableReason = unknownOutcome
    ? "A recent attempt reaches the final segment but has no overall time. Its completion/reset outcome is unknown, so PB odds are unavailable."
    : run.segments.length === 0 ||
        models.segments.some((m) => m.pool.length === 0) ||
        (models.runs !== null && models.runs.length === 0)
      ? "Not enough segment history in the selected window to simulate a full run. Try a larger recent-form window."
      : null;
  const insufficientData = unavailableReason !== null;

  const seed =
    options.seed ?? seedFromString(`${run.gameName}|${run.categoryName}|${run.attemptCount}`);
  const rng = mulberry32(seed);

  let finished = 0;
  let beatPb = 0;
  const S = options.simulations;

  let factor = 1;
  let floor = 0;
  if (options.trend && !insufficientData) {
    const fit = improvementSlope(run, options.method, options.trendFinishes ?? 20);
    if (fit && (options.trend !== "improving" || fit.slope < 0)) {
      const windowSize = Math.min(options.recentWindow, run.attempts.length);
      const windowCentre = run.attempts.length - 1 - (windowSize - 1) / 2;
      const ahead = run.attempts.length + options.lookaheadAttempts / 2 - windowCentre;
      const weight =
        options.trend === "shrunk" ? fit.slope ** 2 / (fit.slope ** 2 + fit.se ** 2) : 1;
      factor = Math.exp(fit.slope * weight * ahead);
    }
    run.segments.forEach((_segment, i) => {
      const seen = segmentTimes(run, i, options.method)
        .map((t) => t.seconds)
        .filter((v): v is number => v !== null);
      floor += seen.length === 0 ? 0 : Math.min(...seen);
    });
  }
  if (!insufficientData) {
    for (let i = 0; i < S; i++) {
      let total = simulateOne(rng, models);
      if (total !== null && factor !== 1) total = Math.max(total * factor, floor);
      if (total !== null) {
        finished++;
        if (pbTime !== null && total < pbTime) beatPb++;
      }
    }
  }

  const canEstimatePb = !insufficientData && pbTime !== null;
  const finishProbability = insufficientData ? null : finished / S;
  const pbProbabilityPerAttempt = canEstimatePb ? beatPb / S : null;
  const pbProbabilityGivenFinish = !canEstimatePb || finished === 0 ? null : beatPb / finished;
  const K = options.lookaheadAttempts;
  const atLeastOne = (p: number | null) =>
    p === null ? null : p === 1 ? 1 : -Math.expm1(K * Math.log1p(-p));
  const probabilityAtLeastOnePb = atLeastOne(pbProbabilityPerAttempt);
  const expectedAttemptsUntilPb =
    pbProbabilityPerAttempt !== null && pbProbabilityPerAttempt > 0
      ? 1 / pbProbabilityPerAttempt
      : null;
  const [ciLow, ciHigh] =
    pbProbabilityPerAttempt === null ? [null, null] : wilsonCi(pbProbabilityPerAttempt, S);

  return {
    simulations: insufficientData ? 0 : S,
    recentAttempts: Math.min(window, run.attempts.length),
    pbTime,
    finishProbability,
    pbProbabilityGivenFinish,
    pbProbabilityPerAttempt,
    pbProbabilityPerAttemptCi: [ciLow, ciHigh],
    lookaheadAttempts: K,
    probabilityAtLeastOnePb,
    probabilityAtLeastOnePbCi: [atLeastOne(ciLow), atLeastOne(ciHigh)],
    expectedAttemptsUntilPb,
    expectedAttemptsUntilPbCi: [
      ciHigh !== null && ciHigh > 0 ? 1 / ciHigh : null,
      ciLow !== null && ciLow > 0 ? 1 / ciLow : null,
    ],
    insufficientData,
    unavailableReason,
    assumptions: ASSUMPTIONS,
  };
}

/**
 * Closed-form P(total < threshold) for independent normal segment times.
 * Not used by the running app — it exists purely as the oracle
 * `tests/montecarlo.test.ts` checks `simulatePbOdds` against, exported so
 * the test can import it rather than duplicating the formula inline.
 */
export function normalSumBeatsThreshold(
  means: readonly number[],
  stdDevs: readonly number[],
  threshold: number,
): number {
  const mean = means.reduce((s, m) => s + m, 0);
  const variance = stdDevs.reduce((s, sd) => s + sd * sd, 0);
  const sd = Math.sqrt(variance);
  if (sd === 0) return mean < threshold ? 1 : 0;
  return normalCdf((threshold - mean) / sd);
}
