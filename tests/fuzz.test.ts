// A splits file is whatever someone was sent or half-downloaded. Mutated copies of the fixtures
// and examples (times and ids replaced with junk, elements dropped or repeated, the file cut
// short) must either be rejected with an LssParseError or give statistics free of NaN.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LssParseError } from "../src/core/errors.js";
import { simulatePbOdds } from "../src/core/montecarlo.js";
import { parseRun, stripOpaqueBlobs } from "../src/core/parser.js";
import * as stats from "../src/core/stats.js";

const here = dirname(fileURLToPath(import.meta.url));
const sources = [
  join(here, "fixtures", "modern-full.lss"),
  join(here, "fixtures", "legacy-1.0.lss"),
  join(here, "fixtures", "empty-history.lss"),
  join(here, "..", "examples", "crystal-caverns-any.lss"),
  join(here, "..", "examples", "crystal-caverns-fresh-start.lss"),
].map((path) => readFileSync(path, "utf-8"));

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), s | 1) + 0x6d2b79f5) >>> 0;
    return s / 4294967296;
  };
}

const TIMES = [
  "", " ", "abc", "-00:00:01", "99:99:99", "1.25:00:00.5", "00:00:00", "NaN", "00:60:60",
  "-1.00:00:01", "9999999:00:00", "00:00:01.", "0:0:1", "00:00:1e3", "-0:00:00",
  "00:00:00.00000000000000000000001", "123456789012345678901234567890:00:00",
]; // biome-ignore format: a list of cases
const IDS = ["", "-1", "x", "999999999999999999999", "1.5", "0", "007", " 3 ", "1e3", "2147483648"];
const VERSIONS = ["", "1.0", "1.4.0", "1.4.1", "1.5", "9.9.9.9", "x.y", "1.7.0.0.0", "-1"];
const DATES = ["", "not a date", "13/45/2026 25:61:61", "0001-01-01", "2026-09-24T10:00:00Z"];

function mutate(xml: string, r: () => number): string {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(r() * list.length)] as T;
  const element = (text: string): { start: number; end: number } | undefined => {
    const tags = [...text.matchAll(/<(\w+)[^>]*>/g)];
    if (tags.length === 0) return undefined;
    const tag = pick(tags);
    const close = text.indexOf(`</${tag[1]}>`, tag.index);
    return close < 0 ? undefined : { start: tag.index, end: close + `</${tag[1]}>`.length };
  };
  let out = xml;
  for (let step = 1 + Math.floor(r() * 5); step > 0; step--) {
    const op = Math.floor(r() * 8);
    if (op === 0) {
      out = out.replace(/\d+:\d\d:\d\d(?:\.\d+)?/g, (m) => (r() < 0.15 ? pick(TIMES) : m));
    } else if (op === 1) {
      out = out.replace(/id="[^"]*"/g, (m) => (r() < 0.2 ? `id="${pick(IDS)}"` : m));
    } else if (op === 2) {
      const at = element(out);
      if (at) out = out.slice(0, at.start) + out.slice(at.end);
    } else if (op === 3) {
      const at = element(out);
      if (at)
        out = out.slice(0, at.end) + out.slice(at.start, at.end).repeat(2) + out.slice(at.end);
    } else if (op === 4) {
      out = out.replace(/version="[^"]*"/, `version="${pick(VERSIONS)}"`);
    } else if (op === 5) {
      out = out.slice(0, Math.floor(r() * out.length));
    } else if (op === 6) {
      out = out.replace(/<Name>[^<]*<\/Name>/g, (m) =>
        r() < 0.2 ? pick(["<Name></Name>", "<Name/>", "", "<Name>&lt;b&gt;</Name>"]) : m,
      );
    } else {
      out = out.replace(/(started|ended)="[^"]*"/g, (m, name: string) =>
        r() < 0.2 ? `${name}="${pick(DATES)}"` : m,
      );
    }
  }
  return out;
}

function hasNaN(value: unknown, depth = 0): boolean {
  if (typeof value === "number") return Number.isNaN(value);
  if (depth > 6 || value === null || typeof value !== "object") return false;
  const children = value instanceof Map ? [...value.values()] : Object.values(value);
  return children.some((child) => hasNaN(child, depth + 1));
}

describe("fuzz", () => {
  it("a mutated splits file is rejected cleanly or analyzed without NaN", {
    timeout: 120_000,
  }, () => {
    let analyzed = 0;
    for (let seed = 0; seed < 1500; seed++) {
      const xml = mutate(sources[seed % sources.length] as string, rng(seed));
      let run: ReturnType<typeof parseRun>;
      try {
        run = parseRun(xml);
      } catch (error) {
        if (error instanceof LssParseError) continue;
        throw new Error(`seed ${seed}: parseRun threw ${String(error)}`);
      }
      analyzed++;
      expect(hasNaN(run), `seed ${seed}: NaN in the parsed run`).toBe(false);
      for (const method of ["RealTime", "GameTime"] as const) {
        const results: unknown[] = [
          stats.pbTotal(run, method),
          stats.sumOfBest(run, method),
          stats.possibleTimeSave(run, method),
          stats.improvementTrend(run, method),
          stats.resetAnalysis(run),
          stats.playtimeSummary(run),
          simulatePbOdds(run, stats.pbTotal(run, method), {
            method,
            recentWindow: 20,
            simulations: 100,
            lookaheadAttempts: 10,
            seed: 1,
          }),
        ];
        run.segments.slice(0, 4).forEach((_, i) => {
          results.push(
            stats.pbCumulative(run, i, method),
            stats.pbSegmentDuration(run, i, method),
            stats.segmentTimes(run, i, method),
            stats.segmentConsistency(run, i, method, 20, 1),
            stats.goldHistory(run, i, method),
          );
        });
        expect(hasNaN(results), `seed ${seed} (${method}): NaN in the statistics`).toBe(false);
      }
    }
    expect(analyzed).toBeGreaterThan(300);
  });

  it("empties icon and auto-splitter elements exactly as a lazy pattern would", () => {
    const pieces = ["<Icon>", "</Icon>", "<GameIcon>", "</GameIcon>", "<AutoSplitterSettings>",
      "</AutoSplitterSettings>", "AAAA", "<Name>x</Name>", "\n", "<Icon/>", "<Icons>", " "]; // biome-ignore format: a list of cases
    const reference = (xml: string): string =>
      xml
        .replace(/<GameIcon>[\s\S]*?<\/GameIcon>/g, "<GameIcon/>")
        .replace(/<Icon>[\s\S]*?<\/Icon>/g, "<Icon/>")
        .replace(
          /<AutoSplitterSettings>[\s\S]*?<\/AutoSplitterSettings>/g,
          "<AutoSplitterSettings/>",
        );
    for (let seed = 0; seed < 3000; seed++) {
      const r = rng(seed);
      let xml = "";
      for (let n = Math.floor(r() * 14); n > 0; n--) xml += pieces[Math.floor(r() * pieces.length)];
      expect(stripOpaqueBlobs(xml), JSON.stringify(xml)).toBe(reference(xml));
    }
  });

  it("thousands of unclosed icon elements do not stall the parser", () => {
    // The lazy pattern took 2.8 s on this input, and four times as long for each doubling.
    const xml = `<Run version="1.7.0">${"<AutoSplitterSettings>".repeat(32_000)}</Run>`;
    const started = performance.now();
    expect(() => parseRun(xml)).toThrow(LssParseError);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
