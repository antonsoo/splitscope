// LiveSplit's subsplit naming convention: "-Step" for a step inside a section, and the section's
// last split written either as "{Section}Split" or plainly, in which case the section takes its name.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { segmentLabels } from "../src/core/names.js";
import { parseRun } from "../src/core/parser.js";
import { buildMarkdownSummary } from "../src/ui/export.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const shape = (names: string[]) =>
  segmentLabels(names).map((s) => [s.label, s.group, s.isSubsplit]);

describe("segmentLabels", () => {
  it("leaves plain names alone", () => {
    expect(shape(["Tutorial", "Boss 1", "Credits"])).toEqual([
      ["Tutorial", null, false],
      ["Boss 1", null, false],
      ["Credits", null, false],
    ]);
  });

  it("reads a section that names itself in braces", () => {
    expect(
      shape([
        "-Vengeful Spirit",
        "-False Knight",
        "{Forgotten Crossroads}Mothwing Cloak",
        "Hornet",
      ]),
    ).toEqual([
      ["Vengeful Spirit", "Forgotten Crossroads", true],
      ["False Knight", "Forgotten Crossroads", true],
      ["Mothwing Cloak", "Forgotten Crossroads", false],
      ["Hornet", null, false],
    ]);
  });

  it("names a section after its last split when that split has no braces", () => {
    expect(shape(["-Enter", "-Miniboss", "Fire Temple", "-Enter", "Water Temple"])).toEqual([
      ["Enter", "Fire Temple", true],
      ["Miniboss", "Fire Temple", true],
      ["Fire Temple", "Fire Temple", false],
      ["Enter", "Water Temple", true],
      ["Water Temple", "Water Temple", false],
    ]);
  });

  it("allows a space after the braces, and a one-split section", () => {
    expect(shape(["{Act 1} Opening", "{Act 2}Finale"])).toEqual([
      ["Opening", "Act 1", false],
      ["Finale", "Act 2", false],
    ]);
  });

  it("keeps a name that is nothing but a prefix, and subsplits no split closes", () => {
    expect(shape(["-", "{}", "{Only}", "-Loose end"])).toEqual([
      ["-", "{}", true],
      ["{}", "{}", false],
      ["{Only}", null, false],
      ["Loose end", null, true],
    ]);
  });
});

describe("a run laid out with subsplits", () => {
  const plain = readFileSync(join(fixturesDir, "modern-full.lss"), "utf-8");
  const names = [...plain.matchAll(/<Name>([^<]*)<\/Name>/g)].map((m) => m[1]!);
  // The same run with its first segments written as steps of a section.
  const renamed: Record<string, string> = {
    [names[0]!]: `-${names[0]}`,
    [names[1]!]: `{Opening}${names[1]}`,
  };
  const subsplit = plain.replace(
    /<Name>([^<]*)<\/Name>/g,
    (_whole, name: string) => `<Name>${renamed[name] ?? name}</Name>`,
  );
  const before = parseRun(plain);
  const after = parseRun(subsplit);

  it("has at least the two segments this test renames", () => {
    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(before.segments.map((s) => s.label)).toEqual(names);
    expect(before.segments.every((s) => s.group === null && !s.isSubsplit)).toBe(true);
  });

  it("shows the names without their prefixes and keeps the raw ones", () => {
    expect(after.segments.map((s) => s.name).slice(0, 2)).toEqual([
      `-${names[0]}`,
      `{Opening}${names[1]}`,
    ]);
    expect(after.segments.map((s) => s.label)).toEqual(names);
    expect(after.segments.slice(0, 2).map((s) => [s.group, s.isSubsplit])).toEqual([
      ["Opening", true],
      ["Opening", false],
    ]);
  });

  it("changes nothing about the numbers, and writes the clean names in the summary", () => {
    const times = (run: typeof before) =>
      run.segments.map((s) => [s.bestSegmentTime, s.history, [...s.splitTimes]]);
    expect(times(after)).toEqual(times(before));
    const summary = (run: typeof before) =>
      buildMarkdownSummary(run, {
        method: "RealTime",
        recentWindow: 50,
        simulations: 2000,
        lookaheadAttempts: 20,
      });
    expect(summary(after)).toBe(summary(before));
    expect(summary(after)).not.toContain("{Opening}");
  });
});
