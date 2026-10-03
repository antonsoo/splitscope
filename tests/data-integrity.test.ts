import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { simulatePbOdds } from "../src/core/montecarlo.js";
import { parseRun } from "../src/core/parser.js";
import {
  hasCompletionTime,
  playtimeSummary,
  recentSegmentSeconds,
  resetAnalysis,
  segmentConsistency,
} from "../src/core/stats.js";
import { formatSeconds, parseTimeSpan } from "../src/core/timespan.js";

const modern = readFileSync(new URL("./fixtures/modern-full.lss", import.meta.url), "utf8");
const legacy = readFileSync(new URL("./fixtures/legacy-1.0.lss", import.meta.url), "utf8");
const run = parseRun(modern);
const options = {
  method: "RealTime" as const,
  recentWindow: 3,
  simulations: 1000,
  lookaheadAttempts: 5,
};

describe("numeric and identity integrity", () => {
  it("decodes numeric XML references once, including supplementary characters", () => {
    expect(parseRun(modern.replace("Crystal Caverns", "A&#10;&#x1F31F; &amp;#65;")).gameName).toBe(
      "A\n🌟 &#65;",
    );
  });
  it.each(["2junk", "1.5", "1e3", "", "9007199254740993", "2147483648"])(
    "rejects malformed attempt ID %s without aliasing it",
    (id) => {
      expect(() => parseRun(modern.replace('id="1"', `id="${id}"`))).toThrow(/attempt id/);
    },
  );
  it("rejects duplicate attempts in either format and duplicate segment records", () => {
    expect(() => parseRun(modern.replace('id="1"', 'id="2"'))).toThrow(/Duplicate attempt id/);
    expect(() => parseRun(legacy.replace('id="1"', 'id="2"'))).toThrow(/Duplicate run history id/);
    expect(() => parseRun(modern.replace('<Time id="1">', '<Time id="2">'))).toThrow(
      /Duplicate history id/,
    );
  });
  it("retains legitimate nonpositive imported segment history IDs", () => {
    expect(
      parseRun(modern.replace('<Time id="1">', '<Time id="-5">')).segments[0]?.history[0]
        ?.attemptId,
    ).toBe(-5);
    expect(
      parseRun(modern.replace('<Time id="1">', '<Time id="0">')).segments[0]?.history[0]?.attemptId,
    ).toBe(0);
  });
  it.each(["-1", "3junk", "1.5", "4294967296"])("rejects invalid attempt count %s", (value) => {
    expect(() => parseRun(modern.replace("<AttemptCount>3", `<AttemptCount>${value}`))).toThrow(
      /AttemptCount/,
    );
  });
  it.each(["x.y", "1.8junk", "1.8.1.0.0"])("rejects invalid format version %s", (version) => {
    expect(() => parseRun(modern.replace('version="1.8.1"', `version="${version}"`))).toThrow(
      /version/,
    );
  });
  it("rejects overflow and durations outside safe millisecond arithmetic", () => {
    expect(() => parseTimeSpan(`${"9".repeat(400)}:00:00`)).toThrow(/too large/);
    expect(() => parseTimeSpan(`${"9".repeat(400)}.01:00:00`)).toThrow(/too large/);
    expect(() => parseTimeSpan("9999999999999:00:00")).toThrow(/too large/);
  });
  it.each([
    [59.999, "1:00.00"],
    [3599.999, "1:00:00.00"],
    [-59.999, "-1:00.00"],
  ] as const)("carries rounding across fields for %s", (n, expected) => {
    expect(formatSeconds(n)).toBe(expected);
  });
  it("formats whole seconds without an extra zero", () =>
    expect(formatSeconds(65.7, 0)).toBe("1:06"));
});

describe("honest history statistics", () => {
  it("uses the same recent attempt window for every segment, excluding old/imported samples", () => {
    const older = { ...run, attempts: [...run.attempts, { ...run.attempts[0]!, id: 4 }] };
    expect(recentSegmentSeconds(older, 0, "RealTime", 1)).toEqual([]);
    expect(recentSegmentSeconds(older, 0, "RealTime", 2)).toEqual([55]);
    expect(recentSegmentSeconds(older, 0, "RealTime", 0)).toEqual([]);
    expect(recentSegmentSeconds({ ...run, attempts: [] }, 0, "RealTime", 10)).toEqual([]);
  });
  it("does not call a single observation zero-variance consistency", () => {
    expect(segmentConsistency(run, 0, "RealTime", 1, 1)).toMatchObject({
      n: 1,
      median: 55,
      stdDev: null,
    });
  });
  it("counts GameTime-only completions and complete attempts with deleted segment histories", () => {
    const completed = { ...run.attempts[1]!, time: { realTime: null, gameTime: 230 } };
    const partial = {
      ...run,
      attempts: [completed],
      segments: run.segments.map((s) => ({ ...s, history: [] })),
    };
    expect(hasCompletionTime(completed)).toBe(true);
    expect(resetAnalysis(partial)).toMatchObject({
      finishedAttempts: 1,
      points: [
        { survivalRate: 1, deaths: 0 },
        { survivalRate: 1, deaths: 0 },
        { survivalRate: 1, deaths: 0 },
      ],
    });
    expect(playtimeSummary(partial).finishedAttempts).toBe(1);
  });
  it("rejects impossible timestamp dates instead of normalizing into another month", () => {
    const invalid = {
      ...run,
      attempts: [
        { ...run.attempts[1]!, started: "2/30/2026 10:00:00", ended: "3/2/2026 11:00:00" },
      ],
    };
    expect(playtimeSummary(invalid)).toMatchObject({
      attemptsMissingTimestamps: 1,
      totalPlaytimeSeconds: 0,
    });
  });
  it("withholds modeled odds for attempts with ambiguous final-segment outcomes", () => {
    const ambiguous = {
      ...run,
      attempts: run.attempts.map((a) =>
        a.id === 3 ? { ...a, time: { realTime: null, gameTime: null } } : a,
      ),
    };
    expect(resetAnalysis(ambiguous).unlocatedOutcomes).toBe(1);
    expect(simulatePbOdds(ambiguous, 240, options)).toMatchObject({
      insufficientData: true,
      simulations: 0,
      pbProbabilityPerAttempt: null,
    });
    expect(simulatePbOdds(ambiguous, 240, options).unavailableReason).toContain(
      "outcome is unknown",
    );
  });
  it("has no measured PB probabilities without a target or without history", () => {
    expect(simulatePbOdds(run, null, options)).toMatchObject({
      pbProbabilityPerAttempt: null,
      pbProbabilityPerAttemptCi: [null, null],
      probabilityAtLeastOnePb: null,
    });
    expect(simulatePbOdds({ ...run, attempts: [] }, 240, options)).toMatchObject({
      insufficientData: true,
      simulations: 0,
      finishProbability: null,
      pbProbabilityPerAttempt: null,
    });
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid simulation settings %s",
    (value) => {
      for (const key of ["simulations", "recentWindow", "lookaheadAttempts"])
        expect(() => simulatePbOdds(run, 240, { ...options, [key]: value })).toThrow(RangeError);
    },
  );
});
