import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bestLegEvidence, bestRoute, buildBestExport } from "../src/core/best-route.js";
import { parseRun } from "../src/core/parser.js";
import type { Run, Segment } from "../src/core/types.js";

const xml = readFileSync(new URL("./fixtures/combined-best.lss", import.meta.url), "utf8");
const base = parseRun(xml);
const blank = { realTime: null, gameTime: null };

describe("recorded paths through split boundaries", () => {
  it("chooses nonoverlapping combined spans rather than adding overlapping savings", () => {
    const route = bestRoute(base, "RealTime");
    expect(route.totalSeconds).toBe(70);
    expect(route.goldSumSeconds).toBe(100);
    expect(route.legs).toEqual([
      { from: 0, to: 1, seconds: 10, source: { kind: "gold" } },
      { from: 1, to: 4, seconds: 60, source: { kind: "history", attemptId: 2 } },
    ]);
    expect(route.boundaries).toEqual([0, 10, 25, 55, 70]);
    // Interior best-boundary times belong to other paths, not this route.
    expect(route.legs.reduce((sum, leg) => sum + leg.seconds, 0)).toBe(70);
  });

  it("keeps game time independent of real-time skips", () => {
    const route = bestRoute(base, "GameTime");
    expect(route.totalSeconds).toBe(92);
    expect(route.legs.every((leg) => leg.source.kind === "gold")).toBe(true);
  });

  it("breaks a combined history span at an absent entry", () => {
    const run: Run = {
      ...base,
      segments: base.segments.map((segment, i) => ({
        ...segment,
        history: segment.history.filter((h) => i !== 2 || h.attemptId !== 2),
      })),
    };
    expect(bestRoute(run, "RealTime").totalSeconds).toBe(95);
    expect(bestRoute(run, "RealTime").legs[0]?.source).toEqual({ kind: "history", attemptId: 1 });
  });

  it("can bridge missing golds using a complete PB span without inventing its pieces", () => {
    const run: Run = {
      ...base,
      segments: base.segments.map((segment, i) => ({
        ...segment,
        history: [],
        bestSegmentTime: blank,
        splitTimes: i === 3 ? segment.splitTimes : new Map(),
      })),
    };
    const route = bestRoute(run, "RealTime");
    expect(route.goldSumSeconds).toBeNull();
    expect(route.totalSeconds).toBe(115);
    expect(route.legs).toEqual([
      {
        from: 0,
        to: 4,
        seconds: 115,
        source: { kind: "personal-best", startSeconds: 0, endSeconds: 115 },
      },
    ]);
    expect(route.boundaries).toEqual([0, null, null, null, 115]);
  });

  it("withholds an incomplete route instead of returning a subtotal", () => {
    const run: Run = {
      ...base,
      segments: base.segments.map((segment, i) => ({
        ...segment,
        history: [],
        splitTimes: new Map(),
        bestSegmentTime: i === 1 ? blank : segment.bestSegmentTime,
      })),
    };
    expect(bestRoute(run, "RealTime")).toMatchObject({
      totalSeconds: null,
      goldSumSeconds: null,
      legs: [],
      boundaries: [0, 10, null, null, null],
    });
    expect(bestRoute({ ...base, segments: [] }, "RealTime").totalSeconds).toBeNull();
  });

  it("retains imported IDs without manufacturing attempts", () => {
    const run = parseRun(xml.replaceAll('id="2"', 'id="-5"'));
    const withoutAttempts = { ...run, attempts: [] };
    const route = bestRoute(withoutAttempts, "RealTime");
    expect(route.totalSeconds).toBe(70);
    expect(route.legs[1]?.source).toEqual({ kind: "history", attemptId: -5 });
    const leg = route.legs[1];
    if (!leg) throw new Error("Missing history leg");
    expect(bestLegEvidence(withoutAttempts, leg).map((row) => row.time?.realTime)).toEqual([
      null,
      null,
      60,
    ]);
  });

  it("keeps a zero duration and does not add a timer offset twice", () => {
    const run = parseRun(
      xml
        .replace("<Offset>00:00:00</Offset>", "<Offset>-00:00:10</Offset>")
        .replace("<RealTime>00:00:10.0000000</RealTime>", "<RealTime>00:00:00.0000000</RealTime>"),
    );
    expect(bestRoute(run, "RealTime").totalSeconds).toBe(60);
  });

  it("keeps gold provenance on floating point ties, but resolves a 100 ns improvement", () => {
    const run: Run = {
      ...base,
      segments: [
        {
          ...(base.segments[0] as Segment),
          bestSegmentTime: { realTime: 0.1 + 0.2, gameTime: null },
          splitTimes: new Map([["Personal Best", { realTime: 0.3, gameTime: null }]]),
          history: [],
        },
      ],
    };
    expect(bestRoute(run, "RealTime").legs[0]?.source.kind).toBe("gold");
    const faster = {
      ...run,
      segments: [
        {
          ...(run.segments[0] as Segment),
          bestSegmentTime: { realTime: 0.3000001, gameTime: null },
        },
      ],
    };
    expect(bestRoute(faster, "RealTime").legs[0]?.source.kind).toBe("personal-best");
  });

  it("exports the full sparse calculation input as well as selected source records", () => {
    const source = { name: "control.lss", sha256: "abc", bytes: xml.length, synthetic: true };
    const out = buildBestExport(base, "RealTime", source);
    expect(out.source).toEqual(source);
    expect(
      out.evidence[1]?.records.map((row) => [row.segmentIndex, row.attemptId, row.time]),
    ).toEqual([
      [1, 2, { realTime: null, gameTime: 18 }],
      [2, 2, { realTime: null, gameTime: 28 }],
      [3, 2, { realTime: 60, gameTime: 38 }],
    ]);
    expect(out.segments[0]?.history).toEqual(base.segments[0]?.history);
  });
});
