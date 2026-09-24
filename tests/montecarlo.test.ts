import { describe, expect, it } from "vitest";
import { normalSumBeatsThreshold, simulatePbOdds } from "../src/core/montecarlo.js";
import { mulberry32 } from "../src/core/rng.js";
import type { Attempt, DualTime, Run, Segment } from "../src/core/types.js";

const dt = (realTime: number | null): DualTime => ({ realTime, gameTime: null });

function makeAttempt(id: number, total: number): Attempt {
  return {
    id,
    started: null,
    isStartedSynced: false,
    ended: null,
    isEndedSynced: false,
    pauseTime: null,
    time: dt(total),
  };
}

function makeSegment(name: string, values: readonly number[]): Segment {
  return makeSegmentWithIds(
    name,
    values.map((v, i) => [i + 1, v]),
  );
}

function makeSegmentWithIds(
  name: string,
  entries: ReadonlyArray<readonly [number, number]>,
): Segment {
  return {
    name,
    splitTimes: new Map(),
    bestSegmentTime: dt(null),
    history: entries.map(([attemptId, v]) => ({ attemptId, time: dt(v) })),
  };
}

describe("simulatePbOdds — constant segment times (zero-variance oracle)", () => {
  // Every attempt: segment A = 10s, segment B = 20s, total = 30s exactly, no resets.
  const n = 20;
  const run: Run = {
    gameName: "G",
    categoryName: "C",
    formatVersion: "1.8.1.0",
    offset: 0,
    attemptCount: n,
    attempts: Array.from({ length: n }, (_, i) => makeAttempt(i + 1, 30)),
    segments: [makeSegment("A", Array(n).fill(10)), makeSegment("B", Array(n).fill(20))],
  };

  it("always beats a PB it is strictly faster than (probability exactly 1)", () => {
    const result = simulatePbOdds(run, 31, {
      method: "RealTime",
      recentWindow: n,
      simulations: 500,
      lookaheadAttempts: 10,
      seed: 1,
    });
    expect(result.insufficientData).toBe(false);
    expect(result.finishProbability).toBe(1);
    expect(result.pbProbabilityPerAttempt).toBe(1);
  });

  it("never beats a PB it is strictly slower than (probability exactly 0)", () => {
    const result = simulatePbOdds(run, 29, {
      method: "RealTime",
      recentWindow: n,
      simulations: 500,
      lookaheadAttempts: 10,
      seed: 1,
    });
    expect(result.pbProbabilityPerAttempt).toBe(0);
    expect(result.expectedAttemptsUntilPb).toBeNull();
  });

  it("combines per-attempt probability into a multi-attempt probability via 1 - (1-p)^K", () => {
    // p=1 per attempt -> certain to PB within any K >= 1.
    const result = simulatePbOdds(run, 31, {
      method: "RealTime",
      recentWindow: n,
      simulations: 200,
      lookaheadAttempts: 5,
      seed: 1,
    });
    expect(result.probabilityAtLeastOnePb).toBeCloseTo(1, 10);
    expect(result.expectedAttemptsUntilPb).toBeCloseTo(1, 10);
  });
});

describe("simulatePbOdds — independent normal segments (closed-form oracle)", () => {
  // Two independent segments, Normal(30, 4) and Normal(50, 6). No resets. Large bootstrap
  // pools (drawn once, deterministically) so resampling closely approximates the underlying
  // normal distribution, and the Monte Carlo total should track the closed-form P(total < PB).
  const rng = mulberry32(42);
  function boxMuller(): number {
    const u1 = Math.max(rng(), 1e-12);
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  const poolSize = 4000;
  const meanA = 30;
  const sdA = 4;
  const meanB = 50;
  const sdB = 6;
  const samplesA = Array.from({ length: poolSize }, () => meanA + sdA * boxMuller());
  const samplesB = Array.from({ length: poolSize }, () => meanB + sdB * boxMuller());

  const run: Run = {
    gameName: "G",
    categoryName: "C",
    formatVersion: "1.8.1.0",
    offset: 0,
    attemptCount: poolSize,
    attempts: Array.from({ length: poolSize }, (_, i) =>
      makeAttempt(i + 1, samplesA[i]! + samplesB[i]!),
    ),
    segments: [makeSegment("A", samplesA), makeSegment("B", samplesB)],
  };

  it("tracks the closed-form normal-sum probability within Monte Carlo tolerance", () => {
    const pbTime = meanA + meanB - 5; // a bit better than the mean total
    const closedForm = normalSumBeatsThreshold([meanA, meanB], [sdA, sdB], pbTime);

    const result = simulatePbOdds(run, pbTime, {
      method: "RealTime",
      recentWindow: poolSize,
      simulations: 30000,
      lookaheadAttempts: 10,
      seed: 7,
    });

    expect(result.pbProbabilityPerAttempt).toBeGreaterThan(0);
    expect(result.pbProbabilityPerAttempt).toBeLessThan(1);
    // Bootstrap resampling from a finite (if large) empirical sample plus Monte Carlo
    // noise both contribute error; 0.02 is generous relative to sqrt(p(1-p)/30000) ~ 0.003.
    expect(Math.abs(result.pbProbabilityPerAttempt - closedForm)).toBeLessThan(0.02);
  });

  it("reports a 95% CI that contains the closed-form probability", () => {
    const pbTime = meanA + meanB; // right at the mean: closed-form probability is ~0.5
    const closedForm = normalSumBeatsThreshold([meanA, meanB], [sdA, sdB], pbTime);
    const result = simulatePbOdds(run, pbTime, {
      method: "RealTime",
      recentWindow: poolSize,
      simulations: 30000,
      lookaheadAttempts: 10,
      seed: 99,
    });
    const [lo, hi] = result.pbProbabilityPerAttemptCi;
    expect(closedForm).toBeGreaterThanOrEqual(lo - 1e-9);
    expect(closedForm).toBeLessThanOrEqual(hi + 1e-9);
  });
});

describe("simulatePbOdds — reset hazard", () => {
  // 10 attempts on a single segment: attempts 1-4 reset immediately (no segment history at
  // all -> hazard at segment A = 4/10), attempts 5-10 reach and finish segment A in 10s flat.
  const resetAttempts: Attempt[] = Array.from({ length: 4 }, (_, i) => {
    const a = makeAttempt(i + 1, 10);
    return { ...a, time: dt(null) };
  });
  const finishedAttempts: Attempt[] = Array.from({ length: 6 }, (_, i) => makeAttempt(i + 5, 10));
  const run: Run = {
    gameName: "G",
    categoryName: "C",
    formatVersion: "1.8.1.0",
    offset: 0,
    attemptCount: 10,
    attempts: [...resetAttempts, ...finishedAttempts],
    segments: [
      makeSegmentWithIds(
        "A",
        finishedAttempts.map((a) => [a.id, 10] as const),
      ),
    ],
  };

  it("estimates the segment hazard as (resets at that segment) / (attempts that started it)", () => {
    const result = simulatePbOdds(run, 11, {
      method: "RealTime",
      recentWindow: 10,
      simulations: 40000,
      lookaheadAttempts: 10,
      seed: 3,
    });
    // Every simulated attempt that survives the 40% hazard finishes in exactly 10s < 11s PB,
    // so finishProbability and pbProbabilityPerAttempt should both track 1 - 4/10 = 0.6.
    expect(result.finishProbability).toBeCloseTo(0.6, 1);
    expect(result.pbProbabilityPerAttempt).toBeCloseTo(0.6, 1);
  });
});
