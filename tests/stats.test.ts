import { describe, expect, it } from "vitest";
import {
  attemptFinished,
  furthestSegmentIndex,
  goldHistory,
  improvementTrend,
  normalCdf,
  pbSegmentDuration,
  pbTotal,
  playtimeSummary,
  possibleTimeSave,
  resetAnalysis,
  segmentConsistency,
  segmentTimes,
  sumOfBest,
} from "../src/core/stats.js";
import type { Attempt, DualTime, Run, Segment } from "../src/core/types.js";

const dt = (realTime: number | null, gameTime: number | null = null): DualTime => ({
  realTime,
  gameTime,
});

function segment(
  name: string,
  pbCumulative: number,
  gold: number,
  historyDurations: readonly (number | null)[],
): Segment {
  return {
    name,
    label: name,
    group: null,
    isSubsplit: false,
    splitTimes: new Map([["Personal Best", dt(pbCumulative)]]),
    bestSegmentTime: dt(gold),
    history: historyDurations.map((v, i) => ({ attemptId: i + 1, time: dt(v) })),
  };
}

function attempt(id: number, total: number | null, started?: string, ended?: string): Attempt {
  return {
    id,
    started: started ?? null,
    isStartedSynced: true,
    ended: ended ?? null,
    isEndedSynced: true,
    pauseTime: null,
    time: dt(total),
  };
}

describe("PB, gold, and time-save math", () => {
  // PB cumulative: A=10, B=25 (segment=15), C=40 (segment=15). Gold: A=8, B=13, C=12.
  const run: Run = {
    gameName: "Test Game",
    categoryName: "Test%",
    formatVersion: "1.8.1.0",
    offset: 0,
    attemptCount: 0,
    attempts: [],
    segments: [segment("A", 10, 8, []), segment("B", 25, 13, []), segment("C", 40, 12, [])],
  };

  it("computes each segment's own PB duration from cumulative splits", () => {
    expect(pbSegmentDuration(run, 0, "RealTime")).toBe(10);
    expect(pbSegmentDuration(run, 1, "RealTime")).toBe(15);
    expect(pbSegmentDuration(run, 2, "RealTime")).toBe(15);
  });

  it("computes total PB as the final cumulative split", () => {
    expect(pbTotal(run, "RealTime")).toBe(40);
  });

  it("sums golds for the sum-of-best", () => {
    expect(sumOfBest(run, "RealTime")).toEqual({ value: 33, complete: true });
  });

  it("computes possible time save per segment as PB-duration minus gold", () => {
    expect(possibleTimeSave(run, "RealTime")).toEqual([2, 2, 3]);
  });

  it("flags sum-of-best as incomplete when a gold is missing", () => {
    const withMissingGold: Run = {
      ...run,
      segments: [
        segment("A", 10, 8, []),
        { ...(run.segments[1] as Segment), bestSegmentTime: dt(null) },
      ],
    };
    expect(sumOfBest(withMissingGold, "RealTime")).toEqual({ value: 8, complete: false });
  });

  it("propagates a missing middle PB split forward, rather than diffing across the gap", () => {
    // Segment B's "Personal Best" comparison is missing (e.g. an older/partial comparison
    // file). B's own duration is unknowable, and so is C's — C's cumulative (40) minus B's
    // *unknown* cumulative is not a valid duration, even though C's own value is present.
    const withGap: Run = {
      ...run,
      segments: [
        segment("A", 10, 8, []),
        { ...(run.segments[1] as Segment), splitTimes: new Map([["Personal Best", dt(null)]]) },
        segment("C", 40, 12, []),
      ],
    };
    expect(pbSegmentDuration(withGap, 0, "RealTime")).toBe(10);
    expect(pbSegmentDuration(withGap, 1, "RealTime")).toBeNull();
    expect(pbSegmentDuration(withGap, 2, "RealTime")).toBeNull();
    expect(possibleTimeSave(withGap, "RealTime")).toEqual([2, null, null]);
  });

  it("returns null/empty for a run with no segments at all", () => {
    const noSegments: Run = { ...run, segments: [] };
    expect(pbTotal(noSegments, "RealTime")).toBeNull();
    expect(sumOfBest(noSegments, "RealTime")).toEqual({ value: 0, complete: true });
    expect(possibleTimeSave(noSegments, "RealTime")).toEqual([]);
  });
});

describe("segmentConsistency", () => {
  const run: Run = {
    gameName: "Test Game",
    categoryName: "Test%",
    formatVersion: "1.8.1.0",
    offset: 0,
    attemptCount: 0,
    attempts: [],
    segments: [segment("A", 10, 8, [8, 9, 10, 11, 12])],
  };

  it("computes median/quartiles/IQR/stdDev/within-gold over the full window (hand-computed)", () => {
    const stats = segmentConsistency(run, 0, "RealTime", 5, 2);
    expect(stats.n).toBe(5);
    expect(stats.median).toBe(10);
    expect(stats.q1).toBe(9);
    expect(stats.q3).toBe(11);
    expect(stats.iqr).toBe(2);
    expect(stats.stdDev).toBeCloseTo(1.5811388, 6);
    // gold=8, tolerance=2 -> within 10: {8,9,10} = 3/5
    expect(stats.percentWithinGold).toBeCloseTo(0.6, 10);
  });

  it("restricts to the last N attempts when the window is smaller than history", () => {
    const stats = segmentConsistency(run, 0, "RealTime", 3, 2);
    // last 3 = [10, 11, 12]
    expect(stats.n).toBe(3);
    expect(stats.median).toBe(11);
    expect(stats.q1).toBe(10.5);
    expect(stats.q3).toBe(11.5);
    expect(stats.stdDev).toBeCloseTo(1, 10);
  });

  it("excludes skipped splits (null time) from the sample rather than treating them as zero", () => {
    const withSkip: Run = { ...run, segments: [segment("A", 10, 8, [8, null, 10, 11, 12])] };
    const stats = segmentConsistency(withSkip, 0, "RealTime", 5, 2);
    expect(stats.n).toBe(4);
  });

  it("also excludes the combined time LiveSplit records for the segment after a skipped split", () => {
    // Attempt 2 skipped A's split, so its B entry (19) is A and B together.
    const skipped: Run = {
      ...run,
      segments: [segment("A", 10, 8, [8, null, 10]), segment("B", 20, 9, [9, 19, 10])],
    };
    const stats = segmentConsistency(skipped, 1, "RealTime", 3, 1);
    expect(stats.n).toBe(2);
    expect(stats.median).toBe(9.5);
  });

  it("returns an all-null result for a segment with no history", () => {
    const empty: Run = { ...run, segments: [segment("A", 10, 8, [])] };
    const stats = segmentConsistency(empty, 0, "RealTime", 10, 1);
    expect(stats).toEqual({
      n: 0,
      median: null,
      q1: null,
      q3: null,
      iqr: null,
      stdDev: null,
      percentWithinGold: null,
    });
  });
});

describe("improvementTrend", () => {
  it("fits a negative slope to a steadily improving set of attempts", () => {
    const run: Run = {
      gameName: "G",
      categoryName: "C",
      formatVersion: "1.8.1.0",
      offset: 0,
      attemptCount: 0,
      attempts: [attempt(1, 100), attempt(2, 90), attempt(3, 80), attempt(4, 70)],
      segments: [],
    };
    const trend = improvementTrend(run, "RealTime");
    expect(trend.points).toHaveLength(4);
    expect(trend.slopePerAttempt).toBeCloseTo(-10, 6);
  });

  it("ignores non-finished attempts (null time)", () => {
    const run: Run = {
      gameName: "G",
      categoryName: "C",
      formatVersion: "1.8.1.0",
      offset: 0,
      attemptCount: 0,
      attempts: [attempt(1, 100), attempt(2, null), attempt(3, 80)],
      segments: [],
    };
    expect(improvementTrend(run, "RealTime").points).toHaveLength(2);
  });
});

describe("reset/survival analysis", () => {
  // 3 segments; attempt 1 resets at segment 0 (no history at all), attempt 2 resets
  // after segment 0 (only segment A history), attempt 3 finishes all three.
  const run: Run = {
    gameName: "G",
    categoryName: "C",
    formatVersion: "1.8.1.0",
    offset: 0,
    attemptCount: 3,
    attempts: [attempt(1, null), attempt(2, null), attempt(3, 30)],
    segments: [
      {
        name: "A",
        label: "A",
        group: null,
        isSubsplit: false,
        splitTimes: new Map(),
        bestSegmentTime: dt(null),
        history: [
          { attemptId: 2, time: dt(5) },
          { attemptId: 3, time: dt(10) },
        ],
      },
      {
        name: "B",
        label: "B",
        group: null,
        isSubsplit: false,
        splitTimes: new Map(),
        bestSegmentTime: dt(null),
        history: [{ attemptId: 3, time: dt(10) }],
      },
      {
        name: "C",
        label: "C",
        group: null,
        isSubsplit: false,
        splitTimes: new Map(),
        bestSegmentTime: dt(null),
        history: [{ attemptId: 3, time: dt(10) }],
      },
    ],
  };

  it("reports furthest segment reached per attempt", () => {
    expect(furthestSegmentIndex(run, 1)).toBe(-1);
    expect(furthestSegmentIndex(run, 2)).toBe(0);
    expect(furthestSegmentIndex(run, 3)).toBe(2);
  });

  it("classifies finish by presence of an overall RealTime", () => {
    expect(attemptFinished(run, 1)).toBe(false);
    expect(attemptFinished(run, 3)).toBe(true);
  });

  it("computes a monotonically non-increasing survival curve and the death histogram", () => {
    const analysis = resetAnalysis(run);
    expect(analysis.totalAttempts).toBe(3);
    expect(analysis.finishedAttempts).toBe(1);
    // Everyone attempts segment A: 3/3.
    expect(analysis.points[0]).toMatchObject({ survivalRate: 1, deaths: 1 }); // attempt 1 dies at A
    // Attempts 2 and 3 attempt segment B: 2/3.
    expect(analysis.points[1]).toMatchObject({ survivalRate: 2 / 3, deaths: 1 }); // attempt 2 dies at B
    // Only attempt 3 attempts segment C: 1/3, nobody dies there (it finishes).
    expect(analysis.points[2]).toMatchObject({ survivalRate: 1 / 3, deaths: 0 });
  });

  it("handles a run with zero attempts without dividing by zero", () => {
    const fresh: Run = { ...run, attempts: [] };
    const analysis = resetAnalysis(fresh);
    expect(analysis.totalAttempts).toBe(0);
    expect(analysis.finishedAttempts).toBe(0);
    expect(analysis.points.every((p) => p.survivalRate === 0 && p.deaths === 0)).toBe(true);
  });
});

describe("playtimeSummary", () => {
  it("sums ended-minus-started across attempts with timestamps", () => {
    const run: Run = {
      gameName: "G",
      categoryName: "C",
      formatVersion: "1.8.1.0",
      offset: 0,
      attemptCount: 2,
      attempts: [
        attempt(1, 100, "1/2/2026 10:00:00", "1/2/2026 10:01:40"), // 100s
        attempt(2, null, "1/2/2026 11:00:00", "1/2/2026 11:00:30"), // 30s
      ],
      segments: [],
    };
    const summary = playtimeSummary(run);
    expect(summary.totalPlaytimeSeconds).toBe(130);
    expect(summary.attemptsMissingTimestamps).toBe(0);
    expect(summary.finishedAttempts).toBe(1);
  });

  it("excludes attempts missing a timestamp pair rather than guessing", () => {
    const run: Run = {
      gameName: "G",
      categoryName: "C",
      formatVersion: "1.8.1.0",
      offset: 0,
      attemptCount: 1,
      attempts: [attempt(1, 100)],
      segments: [],
    };
    const summary = playtimeSummary(run);
    expect(summary.totalPlaytimeSeconds).toBe(0);
    expect(summary.attemptsMissingTimestamps).toBe(1);
  });
});

describe("goldHistory", () => {
  it("tracks only strict improvements over time, in attempt order", () => {
    const run: Run = {
      gameName: "G",
      categoryName: "C",
      formatVersion: "1.8.1.0",
      offset: 0,
      attemptCount: 0,
      attempts: [],
      segments: [segment("A", 10, 8, [12, 10, 11, 9, 9, 8])],
    };
    const history = goldHistory(run, 0, "RealTime");
    expect(history).toEqual([
      { attemptId: 1, seconds: 12 },
      { attemptId: 2, seconds: 10 },
      { attemptId: 4, seconds: 9 },
      { attemptId: 6, seconds: 8 },
    ]);
  });
});

describe("normalCdf", () => {
  it("matches well-known standard normal values", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 4);
  });
});

describe("segmentTimes", () => {
  const withIds = (name: string, entries: ReadonlyArray<readonly [number, DualTime]>): Segment => ({
    name,
    label: name,
    group: null,
    isSubsplit: false,
    splitTimes: new Map(),
    bestSegmentTime: dt(null),
    history: entries.map(([attemptId, time]) => ({ attemptId, time })),
  });
  const base = { gameName: "G", categoryName: "C", formatVersion: "1.8.1", offset: 0 };

  it("drops a skipped split and the combined entry after it, matching livesplit-core's rule", () => {
    const run: Run = {
      ...base,
      attemptCount: 3,
      attempts: [attempt(1, 30), attempt(2, 31), attempt(3, 29)],
      segments: [
        withIds("A", [
          [1, dt(10)],
          [2, dt(null)],
          [3, dt(9)],
        ]),
        withIds("B", [
          [1, dt(10)],
          [2, dt(21)],
          [3, dt(10)],
        ]),
        withIds("C", [
          [1, dt(10)],
          [2, dt(10)],
          [3, dt(10)],
        ]),
      ],
    };
    expect(segmentTimes(run, 0, "RealTime").map((t) => t.seconds)).toEqual([10, null, 9]);
    expect(segmentTimes(run, 1, "RealTime").map((t) => t.seconds)).toEqual([10, null, 10]);
    expect(segmentTimes(run, 2, "RealTime").map((t) => t.seconds)).toEqual([10, 10, 10]);
    expect(segmentTimes(run, 3, "RealTime")).toEqual([]);
  });

  it("keeps an entry whose previous-segment entry is missing, and judges each timing method on its own", () => {
    const run: Run = {
      ...base,
      attemptCount: 2,
      attempts: [attempt(1, 30), attempt(2, 30)],
      segments: [
        // Attempt 1 has GameTime missing on A (load removal off), attempt 2 has no A entry at all.
        withIds("A", [[1, dt(10, null)]]),
        withIds("B", [
          [1, dt(20, 18)],
          [2, dt(20, 18)],
        ]),
      ],
    };
    expect(segmentTimes(run, 1, "RealTime").map((t) => t.seconds)).toEqual([20, 20]);
    expect(segmentTimes(run, 1, "GameTime").map((t) => t.seconds)).toEqual([null, 18]);
  });

  it("feeds gold history, so a combined time can't pose as a segment record", () => {
    const run: Run = {
      ...base,
      attemptCount: 2,
      attempts: [attempt(1, null), attempt(2, 20)],
      segments: [
        withIds("A", [
          [1, dt(null)],
          [2, dt(10)],
        ]),
        withIds("B", [
          [1, dt(12)],
          [2, dt(10)],
        ]),
      ],
    };
    expect(goldHistory(run, 1, "RealTime")).toEqual([{ attemptId: 2, seconds: 10 }]);
  });
});
