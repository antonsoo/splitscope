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
 * Two assumptions make this tractable, and both are optimistic in the same
 * direction (a real run has more structure than this model does):
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
import { mulberry32, type Rng, seedFromString } from "./rng.js";
import { furthestSegmentIndex, normalCdf } from "./stats.js";
import type { Run, TimingMethod } from "./types.js";
import { pick } from "./types.js";

export interface PbOddsOptions {
  readonly method: TimingMethod;
  /** How many of the most recent attempts to treat as "current form" for both sampling and hazard. */
  readonly recentWindow: number;
  readonly simulations: number;
  readonly seed?: number;
  /** Attempts to look ahead for "probability of at least one PB in the next K". */
  readonly lookaheadAttempts: number;
}

export interface PbOddsResult {
  readonly simulations: number;
  readonly pbTime: number | null;
  readonly finishProbability: number;
  readonly pbProbabilityGivenFinish: number | null;
  /** Unconditional probability a single future attempt both finishes and beats PB. */
  readonly pbProbabilityPerAttempt: number;
  /** 95% Wilson score confidence interval on {@link pbProbabilityPerAttempt}. */
  readonly pbProbabilityPerAttemptCi: readonly [number, number];
  readonly lookaheadAttempts: number;
  /** P(at least one PB in the next `lookaheadAttempts`), assuming independent attempts. */
  readonly probabilityAtLeastOnePb: number;
  /** Geometric-distribution expected attempts to first PB; `null` if the per-attempt probability is 0. */
  readonly expectedAttemptsUntilPb: number | null;
  readonly insufficientData: boolean;
  readonly assumptions: readonly string[];
}

const ASSUMPTIONS = [
  "Segment times are drawn independently of each other (a slow segment doesn't change the odds of the next one being slow or fast).",
  "The recent-form window is assumed stationary: it represents skill for every simulated future attempt, not a runner who is still improving.",
  "Reset hazard per segment is estimated from historical frequency and assumed constant going forward.",
  "Attempts are treated as independent trials when combining single-attempt odds into a multi-attempt probability.",
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

function buildSegmentModels(run: Run, method: TimingMethod, window: number): SegmentModel[] {
  const attemptsInWindow = run.attempts.slice(-window);
  const idsInWindow = new Set(attemptsInWindow.map((a) => a.id));
  const furthestById = new Map(
    attemptsInWindow.map((a) => [a.id, furthestSegmentIndex(run, a.id)]),
  );
  const finishedIds = new Set(
    attemptsInWindow.filter((a) => a.time.realTime !== null).map((a) => a.id),
  );

  return run.segments.map((segment, i) => {
    const pool = segment.history
      .filter((h) => idsInWindow.has(h.attemptId))
      .map((h) => pick(h.time, method))
      .filter((v): v is number => v !== null);

    const started = attemptsInWindow.filter((a) => (furthestById.get(a.id) ?? -1) >= i - 1).length;
    const deaths = attemptsInWindow.filter(
      (a) => !finishedIds.has(a.id) && (furthestById.get(a.id) ?? -1) === i - 1,
    ).length;
    const hazard = started === 0 ? 0 : deaths / started;

    return { pool, hazard };
  });
}

function simulateOne(rng: Rng, models: readonly SegmentModel[]): number | null {
  let total = 0;
  for (const model of models) {
    if (rng() < model.hazard) return null;
    if (model.pool.length === 0) return null;
    const index = Math.floor(rng() * model.pool.length);
    total += model.pool[Math.min(index, model.pool.length - 1)] as number;
  }
  return total;
}

/** Runs the Monte Carlo PB-odds simulation described above. */
export function simulatePbOdds(
  run: Run,
  pbTime: number | null,
  options: PbOddsOptions,
): PbOddsResult {
  const models = buildSegmentModels(run, options.method, options.recentWindow);
  const insufficientData = run.segments.length === 0 || models.some((m) => m.pool.length === 0);

  const seed =
    options.seed ?? seedFromString(`${run.gameName}|${run.categoryName}|${run.attemptCount}`);
  const rng = mulberry32(seed);

  let finished = 0;
  let beatPb = 0;
  const S = Math.max(1, options.simulations);

  if (!insufficientData) {
    for (let i = 0; i < S; i++) {
      const total = simulateOne(rng, models);
      if (total !== null) {
        finished++;
        if (pbTime !== null && total < pbTime) beatPb++;
      }
    }
  }

  const finishProbability = insufficientData ? 0 : finished / S;
  const pbProbabilityPerAttempt = insufficientData ? 0 : beatPb / S;
  const pbProbabilityGivenFinish = finished === 0 ? null : beatPb / finished;
  const K = options.lookaheadAttempts;
  const probabilityAtLeastOnePb = 1 - (1 - pbProbabilityPerAttempt) ** K;
  const expectedAttemptsUntilPb = pbProbabilityPerAttempt > 0 ? 1 / pbProbabilityPerAttempt : null;

  return {
    simulations: S,
    pbTime,
    finishProbability,
    pbProbabilityGivenFinish,
    pbProbabilityPerAttempt,
    pbProbabilityPerAttemptCi: wilsonCi(pbProbabilityPerAttempt, S),
    lookaheadAttempts: K,
    probabilityAtLeastOnePb,
    expectedAttemptsUntilPb,
    insufficientData,
    assumptions: ASSUMPTIONS,
  };
}

/**
 * Closed-form P(total < threshold) for independent normal segment times,
 * used as the oracle in `tests/montecarlo.test.ts`. Exported so the UI can
 * (optionally) show it as a sanity comparison for the "constant-times"
 * edge case in a diagnostics panel, but its primary purpose is the test.
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
