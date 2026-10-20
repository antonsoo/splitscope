import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { attemptClocks, parseLiveSplitTimestamp } from "../src/core/attempt-clock.js";
import { parseRun } from "../src/core/parser.js";
import { comparePracticeTime } from "../src/core/practice-time.js";
import { buildPracticeExport, comparePractice } from "../src/core/review.js";
import type { Attempt, Run } from "../src/core/types.js";

const fixture = parseRun(
  readFileSync(new URL("fixtures/practice-evidence.lss", import.meta.url), "utf8"),
);
const stamp = (seconds: number) =>
  `1/1/2026 00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

function dated(attempt: Attempt, start: number, end: number): Attempt {
  return {
    ...attempt,
    started: stamp(start),
    ended: stamp(end),
    isStartedSynced: true,
    isEndedSynced: true,
  };
}

describe("recorded attempt time", () => {
  it("partitions whole-attempt elapsed time without substituting timer totals or absent pauses", () => {
    const run: Run = {
      ...fixture,
      attempts: fixture.attempts.map((a, i) => {
        const value = dated(a, i * 60, i * 60 + ([60, 10, 20, 0, 120, 50][i] as number));
        if (i === 2) return { ...value, ended: null };
        if (i === 4) return { ...value, pauseTime: 30, isEndedSynced: false };
        if (i === 5) return { ...value, ended: "2/30/2026 00:05:50" };
        return value;
      }),
    };
    const comparison = comparePractice(run, "RealTime", 3);
    const result = comparePracticeTime(run, comparison);
    expect(result.previous.total).toMatchObject({
      attempts: 3,
      timedAttempts: 2,
      elapsedSeconds: 70,
      unavailable: { missing: 1, invalid: 0, reversed: 0 },
    });
    expect(result.previous.completed).toMatchObject({
      attempts: 2,
      timedAttempts: 1,
      elapsedSeconds: 10,
    });
    expect(result.recent.total).toMatchObject({
      attempts: 3,
      timedAttempts: 2,
      elapsedSeconds: 120,
      unsynchronizedAttempts: 1,
      unavailable: { missing: 0, invalid: 1, reversed: 0 },
    });
    expect(result.recent.unknown).toMatchObject({
      attempts: 1,
      timedAttempts: 1,
      elapsedSeconds: 0,
    });
    expect(result.recent.inferredResets.elapsedSeconds).toBe(120);
    expect(result.recent.completed.elapsedSeconds).toBeNull();
    expect(result.recent.byResetSegment[3]?.elapsedSeconds).toBe(120);
    expect(comparePracticeTime(run, comparePractice(run, "GameTime", 3))).toEqual(result);
    const exported = buildPracticeExport(run, comparison, {
      name: "authored.lss",
      bytes: 1,
      sha256: "authored",
      synthetic: true,
    });
    expect(exported.schemaVersion).toBe(2);
    expect(exported.timeBudget).toEqual(result);
    expect(exported.comparison.recent.attempts[1]?.attempt.pauseTime).toBe(30);
  });

  it("flags overlapping intervals with original witnesses across the cohort boundary", () => {
    const run = {
      ...fixture,
      attempts: fixture.attempts.map((a, i) => {
        const [start, end] = [
          [0, 60],
          [20, 40],
          [30, 80],
          [80, 90],
          [35, 35],
          [100, 99],
        ][i] as [number, number];
        return dated(a, start, end);
      }),
    };
    const clocks = attemptClocks(run);
    for (const id of [2, 5, 9]) expect(clocks.get(id)?.overlap).not.toBeNull();
    for (const id of [12, 20, 23]) expect(clocks.get(id)?.overlap).toBeNull();
    const result = comparePracticeTime(run, comparePractice(run, "RealTime", 1, 2));
    expect(result.recent.total.overlappingAttempts).toBe(1);
    expect(result.recent.clocks[0]?.overlap).toEqual({
      attemptId: 2,
      started: stamp(0),
      ended: stamp(60),
    });
    expect(clocks.get(23)).toMatchObject({ status: "reversed", elapsedSeconds: null });
  });

  it("does not normalize invalid calendar dates or local timezone conventions", () => {
    for (const text of [
      "2/29/1900 00:00:00",
      "2/29/2100 00:00:00",
      "1/1/2026 24:00:00",
      "1/1/0000 00:00:00",
      "2026-01-01T00:00:00Z",
    ])
      expect(parseLiveSplitTimestamp(text)).toBeNull();
    expect(parseLiveSplitTimestamp("2/29/2000 00:00:00")).toBe(Date.UTC(2000, 1, 29));
    expect(new Date(parseLiveSplitTimestamp("1/1/0099 00:00:00") as number).toISOString()).toBe(
      "0099-01-01T00:00:00.000Z",
    );
  });

  it("retains unavailable time in old histories and empty groups", () => {
    const run = {
      ...fixture,
      attempts: fixture.attempts.map((a) => ({ ...a, started: null, ended: null })),
    };
    const result = comparePracticeTime(run, comparePractice(run, "RealTime", 30));
    expect(result.previous.total).toMatchObject({ attempts: 0, elapsedSeconds: null });
    expect(result.recent.total).toMatchObject({
      attempts: 6,
      timedAttempts: 0,
      elapsedSeconds: null,
      unavailable: { missing: 6 },
    });
  });

  it("retains counts when a duration sum exceeds the exact JSON integer range", () => {
    const original = fixture.attempts[0] as Attempt;
    const run = {
      ...fixture,
      segments: fixture.segments.map((s) => ({ ...s, history: [] })),
      attempts: Array.from({ length: 30000 }, (_, i) => ({
        ...original,
        id: i + 1,
        started: "1/1/0001 00:00:00",
        ended: "12/31/9999 23:59:59",
      })),
    };
    const result = comparePracticeTime(run, comparePractice(run, "RealTime", 30000));
    expect(result.recent.total).toMatchObject({
      attempts: 30000,
      timedAttempts: 30000,
      elapsedSeconds: null,
      sumStatus: "out-of-range",
    });
    expect(result.recent.clocks[0]?.elapsedSeconds).toBe(315537897599);
  });

  it("opens the unchanged public Re-Loaded history's count-versus-time contrast", () => {
    const run = parseRun(
      readFileSync(new URL("../examples/recorded/re-loaded.lss", import.meta.url), "utf8"),
    );
    const comparison = comparePractice(run, "RealTime", 30);
    const result = comparePracticeTime(run, comparison);
    const desert = run.segments.findIndex((s) => s.name === "Desert");
    const monestary = run.segments.findIndex((s) => s.name === "Monestary");
    expect(comparison.recent.segments[desert]?.resets).toBe(10);
    expect(result.recent.byResetSegment[desert]).toMatchObject({
      timedAttempts: 10,
      elapsedSeconds: 236,
    });
    expect(comparison.recent.segments[monestary]?.resets).toBe(4);
    expect(result.recent.byResetSegment[monestary]).toMatchObject({
      timedAttempts: 4,
      elapsedSeconds: 2898,
    });
    expect(result.recent.total.timedAttempts).toBe(30);
    expect(result.recent.clocks.find((c) => c.attemptId === 139)?.elapsedSeconds).toBe(0);
  });
});
