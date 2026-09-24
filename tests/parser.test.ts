import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LssParseError } from "../src/core/errors.js";
import { parseRun } from "../src/core/parser.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => readFileSync(join(fixturesDir, name), "utf-8");

describe("parseRun — modern format (1.8.1)", () => {
  const run = parseRun(fixture("modern-full.lss"));

  it("reads game metadata, offset, and attempt count", () => {
    expect(run.gameName).toBe("Crystal Caverns");
    expect(run.categoryName).toBe("Any%");
    expect(run.attemptCount).toBe(3);
    expect(run.offset).toBe(0);
    expect(run.formatVersion).toBe("1.8.1.0");
  });

  it("reads all segments in order with their PB and gold times", () => {
    expect(run.segments.map((s) => s.name)).toEqual(["Cave Entrance", "Crystal Lake", "Boss Room"]);
    const caveEntrance = run.segments[0]!;
    expect(caveEntrance.splitTimes.get("Personal Best")).toEqual({ realTime: 60, gameTime: 58 });
    expect(caveEntrance.bestSegmentTime).toEqual({ realTime: 55, gameTime: 53 });
  });

  it("reads attempts, distinguishing a reset (no RealTime) from a finish", () => {
    expect(run.attempts).toHaveLength(3);
    const [reset, finished] = run.attempts;
    expect(reset!.id).toBe(1);
    expect(reset!.time).toEqual({ realTime: null, gameTime: null });
    expect(finished!.id).toBe(2);
    expect(finished!.time).toEqual({ realTime: 240, gameTime: 230 });
  });

  it("handles an attempt with no GameTime recorded at all (edge case)", () => {
    const attempt3 = run.attempts.find((a) => a.id === 3);
    expect(attempt3?.time).toEqual({ realTime: 250, gameTime: null });
  });

  it("only records segment history for segments an attempt actually reached", () => {
    // Attempt 1 reset after the first segment: only Cave Entrance has a history entry for it.
    const caveEntrance = run.segments[0]!;
    const crystalLake = run.segments[1]!;
    expect(caveEntrance.history.some((h) => h.attemptId === 1)).toBe(true);
    expect(crystalLake.history.some((h) => h.attemptId === 1)).toBe(false);
  });

  it("represents a skipped split as a history entry with null times (edge case)", () => {
    const crystalLake = run.segments[1]!;
    const skipped = crystalLake.history.find((h) => h.attemptId === 3);
    expect(skipped).toBeDefined();
    expect(skipped?.time).toEqual({ realTime: null, gameTime: null });
  });

  it("sorts segment history by attempt id", () => {
    const caveEntrance = run.segments[0]!;
    expect(caveEntrance.history.map((h) => h.attemptId)).toEqual([1, 2, 3]);
  });
});

describe("parseRun — empty history (edge case)", () => {
  const run = parseRun(fixture("empty-history.lss"));

  it("parses a splits file with zero attempts", () => {
    expect(run.attempts).toEqual([]);
    expect(run.attemptCount).toBe(0);
  });

  it("gives every segment an empty history and null gold/PB", () => {
    for (const segment of run.segments) {
      expect(segment.history).toEqual([]);
      expect(segment.bestSegmentTime).toEqual({ realTime: null, gameTime: null });
      expect(segment.splitTimes.get("Personal Best")).toEqual({ realTime: null, gameTime: null });
    }
  });
});

describe("parseRun — legacy format (1.0.0.0)", () => {
  const run = parseRun(fixture("legacy-1.0.lss"));

  it("falls back to RunHistory for attempts (no AttemptHistory before 1.5.0)", () => {
    expect(run.attempts).toHaveLength(2);
    expect(run.attempts.map((a) => a.time.realTime)).toEqual([260, 245]);
    // The old format has no concept of GameTime at all.
    expect(run.attempts.every((a) => a.time.gameTime === null)).toBe(true);
  });

  it("falls back to <PersonalBestSplitTime> for the PB comparison (no SplitTimes before 1.3.0)", () => {
    const cave = run.segments[0]!;
    expect(cave.splitTimes.get("Personal Best")).toEqual({ realTime: 65, gameTime: null });
  });

  it("reads BestSegmentTime and SegmentHistory as direct values (no RealTime/GameTime wrapper before 1.4.1)", () => {
    const cave = run.segments[0]!;
    expect(cave.bestSegmentTime).toEqual({ realTime: 60, gameTime: null });
    expect(cave.history).toEqual([
      { attemptId: 1, time: { realTime: 70, gameTime: null } },
      { attemptId: 2, time: { realTime: 65, gameTime: null } },
    ]);
  });
});

describe("parseRun — error handling", () => {
  it("fails gracefully on an empty file", () => {
    expect(() => parseRun("")).toThrow(LssParseError);
    expect(() => parseRun("   \n  ")).toThrow(LssParseError);
  });

  it("fails gracefully on non-XML input", () => {
    expect(() => parseRun("this is not xml at all }{")).toThrow(LssParseError);
  });

  it("fails gracefully on XML that isn't a LiveSplit run", () => {
    expect(() => parseRun("<NotARun><Foo>bar</Foo></NotARun>")).toThrow(LssParseError);
  });

  it("fails gracefully when required elements are missing", () => {
    expect(() =>
      parseRun('<Run version="1.8.1"><GameName>X</GameName><CategoryName>Y</CategoryName></Run>'),
    ).toThrow(/Offset|AttemptCount|Segments/);
  });
});

describe("parseRun — odd but valid encodings (real files vary by editor/OS)", () => {
  const base = fixture("modern-full.lss");

  it("handles a leading UTF-8 byte-order mark", () => {
    const run = parseRun(`﻿${base}`);
    expect(run.gameName).toBe("Crystal Caverns");
    expect(run.attempts).toHaveLength(3);
  });

  it("handles Windows CRLF line endings (LiveSplit itself runs on Windows)", () => {
    const run = parseRun(base.replace(/\n/g, "\r\n"));
    expect(run.gameName).toBe("Crystal Caverns");
    expect(run.attempts).toHaveLength(3);
  });
});
