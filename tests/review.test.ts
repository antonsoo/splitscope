import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRun } from "../src/core/parser.js";
import {
  buildPracticeExport,
  comparePractice,
  filterAttempts,
  inspectAttempt,
  reviewAttempts,
} from "../src/core/review.js";
import { resetAnalysis } from "../src/core/stats.js";

const run = parseRun(
  readFileSync(new URL("fixtures/practice-evidence.lss", import.meta.url), "utf8"),
);

describe("observed practice groups", () => {
  it("uses disjoint recorded attempts, not the attempt counter, ID distance or imported records", () => {
    const result = comparePractice(run, "RealTime", 3);
    expect(result.previous.attempts.map((row) => row.attempt.id)).toEqual([2, 5, 9]);
    expect(result.recent.attempts.map((row) => row.attempt.id)).toEqual([12, 20, 23]);
    expect(result.previous.attempts.map((row) => row.ordinal)).toEqual([1, 2, 3]);
    expect(result.previous).toMatchObject({
      completed: 2,
      inferredResets: 1,
      unknown: 0,
      timedCompletions: 1,
      medianCompletion: 50,
    });
    expect(result.recent).toMatchObject({
      completed: 1,
      inferredResets: 1,
      unknown: 1,
      timedCompletions: 1,
      medianCompletion: 55,
    });
    expect(result.previous.segments).toEqual([
      { started: 3, resets: 1, resetRate: 1 / 3 },
      { started: 2, resets: 0, resetRate: 0 },
      { started: 2, resets: 0, resetRate: 0 },
      { started: 2, resets: 0, resetRate: 0 },
    ]);
    expect(result.recent.segments.at(-1)).toEqual({ started: 3, resets: 1, resetRate: 1 / 3 });
  });

  it("a completion in the other method does not turn into a reset or a zero-second finish", () => {
    const result = comparePractice(run, "GameTime", 3);
    expect(result.previous).toMatchObject({
      completed: 2,
      timedCompletions: 1,
      bestCompletion: 42,
      medianCompletion: 42,
    });
    expect(result.recent).toMatchObject({
      completed: 1,
      timedCompletions: 0,
      bestCompletion: null,
      medianCompletion: null,
    });
    expect(result.recent.segments).toEqual(comparePractice(run, "RealTime", 3).recent.segments);
  });

  it("an earlier endpoint excludes later attempts and preserves a short previous group", () => {
    const result = comparePractice(run, "RealTime", 3, 4);
    expect(result.previous.attempts.map((row) => row.attempt.id)).toEqual([2]);
    expect(result.recent.attempts.map((row) => row.attempt.id)).toEqual([5, 9, 12]);
    expect(result.previous.segments.at(-1)).toEqual({ started: 0, resets: 0, resetRate: null });
  });

  it("unknown final-segment outcomes are included in reached counts and never assigned resets", () => {
    const result = comparePractice(run, "RealTime", 3);
    expect(
      filterAttempts(result.recent, { outcome: "unknown", resetSegment: null }).map(
        (row) => row.attempt.id,
      ),
    ).toEqual([12]);
    expect(
      filterAttempts(result.recent, { outcome: "inferred-reset", resetSegment: 3 }).map(
        (row) => row.attempt.id,
      ),
    ).toEqual([20]);
    expect(reviewAttempts(run).find((row) => row.attempt.id === 9)).toMatchObject({
      outcome: "completed",
      lastRecordedSegment: null,
      inferredResetSegment: null,
    });
  });

  it("empty histories return unavailable medians and rates, without fake observations", () => {
    const empty = { ...run, attempts: [] };
    const result = comparePractice(empty, "RealTime", 30);
    expect(result.recent.attempts).toEqual([]);
    expect(result.previous.medianCompletion).toBeNull();
    expect(result.recent.segments.every((row) => row.resetRate === null)).toBe(true);
  });

  it("rejects invalid range coordinates", () => {
    for (const window of [0, -1, 1.2, NaN, Infinity])
      expect(() => comparePractice(run, "RealTime", window)).toThrow(RangeError);
    for (const end of [-1, 7, 1.5, Infinity])
      expect(() => comparePractice(run, "RealTime", 3, end)).toThrow(RangeError);
  });

  it("agrees with the existing lifetime histogram when the group is the whole history", () => {
    const result = comparePractice(run, "RealTime", run.attempts.length);
    const lifetime = resetAnalysis(run);
    expect(result.recent.segments.map((row) => row.resets)).toEqual(
      lifetime.points.map((row) => row.deaths),
    );
    expect(result.recent.segments.map((row) => row.started / 6)).toEqual(
      lifetime.points.map((row) => row.survivalRate),
    );
    expect(result.recent.unknown).toBe(lifetime.unlocatedOutcomes);
  });
});

describe("original split evidence", () => {
  it("retains an empty entry and the combined duration that follows it", () => {
    const records = inspectAttempt(run, 5, "RealTime");
    expect(records.map((row) => row.kind)).toEqual(["timed", "untimed", "combined", "timed"]);
    expect(records[1]).toMatchObject({
      seconds: null,
      recordedTime: { realTime: null, gameTime: null },
    });
    expect(records[2]).toMatchObject({ seconds: 25, combinedFrom: 1, deltaToCurrentPb: null });
    expect(records[3]).toMatchObject({ seconds: 15, combinedFrom: null, deltaToCurrentPb: 0 });
  });

  it("does not invent empty entries or combined spans across absent history", () => {
    expect(inspectAttempt(run, 9, "RealTime").every((row) => row.kind === "missing")).toBe(true);
    expect(inspectAttempt(run, 23, "RealTime")[1]).toMatchObject({
      kind: "missing",
      recordedTime: null,
    });
    expect(inspectAttempt(run, 23, "RealTime")[2]).toMatchObject({
      kind: "timed",
      combinedFrom: null,
    });
    expect(() => inspectAttempt(run, -7, "RealTime")).toThrow(RangeError);
  });

  it("keeps both timing methods and never substitutes RealTime for missing GameTime", () => {
    const records = inspectAttempt(run, 5, "GameTime");
    expect(records[0]).toMatchObject({ seconds: 8, recordedTime: { realTime: 10, gameTime: 8 } });
    expect(records.slice(1).every((row) => row.kind === "untimed" && row.seconds === null)).toBe(
      true,
    );
  });

  it("exports both complete groups and their sparse original records", () => {
    const source = {
      name: "practice-evidence.lss",
      bytes: 123,
      sha256: "example-digest",
      synthetic: true,
    };
    const report = buildPracticeExport(run, comparePractice(run, "RealTime", 3), source);
    expect(report.source).toEqual(source);
    expect(report.run).toMatchObject({ attemptCount: 1234, recordedAttempts: 6 });
    expect(report.segments[0]?.history.map((entry) => entry.attemptId)).toEqual([5, 20, 23]);
    expect(report.segments[1]?.history).toEqual([
      { attemptId: 5, time: { realTime: null, gameTime: null } },
      { attemptId: 20, time: { realTime: null, gameTime: null } },
    ]);
    const older = buildPracticeExport(run, comparePractice(run, "RealTime", 2, 2), source);
    expect(
      older.segments.flatMap((segment) => segment.history).every((entry) => entry.attemptId === 5),
    ).toBe(true);
  });
});
