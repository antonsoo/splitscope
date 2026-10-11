import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LssParseError } from "../src/core/errors.js";
import { parseRun } from "../src/core/parser.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const modern = fixture("modern-full.lss");

describe("XML evidence cannot turn into missing times", () => {
  for (const name of ["modern-full.lss", "legacy-1.0.lss", "empty-history.lss"]) {
    it(`preserves attributed leaf text and empty values in ${name}`, () => {
      const xml = fixture(name);
      const attributed = xml.replace(/<(\w+)>([^<]*)<\/\1>/g, '<$1 xml:space="preserve">$2</$1>');
      expect(parseRun(attributed)).toEqual(parseRun(xml));
    });
  }

  it("keeps attributed zero times distinct from attributed empty times", () => {
    const run = parseRun(
      modern.replace(
        /<RealTime>[^<]*<\/RealTime>/g,
        '<RealTime xml:space="preserve">00:00:00</RealTime>',
      ),
    );
    expect(run.attempts[1]?.time.realTime).toBe(0);
    const empty = parseRun(
      modern.replace(/<RealTime>[^<]*<\/RealTime>/g, '<RealTime xml:space="preserve"/>'),
    );
    expect(empty.attempts[1]?.time.realTime).toBeNull();
    expect(empty.attempts[1]?.time.gameTime).toBe(230);
  });

  for (const tag of [
    "RealTime",
    "GameTime",
    "GameName",
    "CategoryName",
    "Offset",
    "AttemptCount",
    "Name",
    "SplitTimes",
    "BestSegmentTime",
    "SegmentHistory",
    "Segments",
  ] as const) {
    it(`rejects repeated <${tag}> instead of reading it as missing`, () => {
      const duplicate = modern.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`), "$&$&");
      expect(duplicate).not.toBe(modern);
      expect(() => parseRun(duplicate)).toThrow(`Duplicate <${tag}>`);
    });
  }

  it.each(["00:04:00", "00:09:59", ""])("rejects a second time value %j", (time) => {
    const xml = modern.replace("</RealTime>", `</RealTime><RealTime>${time}</RealTime>`);
    expect(() => parseRun(xml)).toThrow("Duplicate <RealTime>");
  });

  for (const [name, tag] of [
    ["modern-full.lss", "AttemptHistory"],
    ["legacy-1.0.lss", "RunHistory"],
  ] as const) {
    it(`rejects a second ${tag} container even when it is empty`, () => {
      expect(() => parseRun(fixture(name).replace(`</${tag}>`, `</${tag}><${tag}/>`))).toThrow(
        `Duplicate <${tag}>`,
      );
    });
  }

  it("rejects a nested timing element instead of inventing an unrecorded time", () => {
    const xml = modern.replace(
      /<RealTime>[^<]*<\/RealTime>/,
      "<RealTime><Value>00:04:00</Value></RealTime>",
    );
    expect(() => parseRun(xml)).toThrow("expected text, not nested elements");
  });

  it("rejects nested content in legacy direct timing records", () => {
    const xml = fixture("legacy-1.0.lss").replace(/(<Time id="1">)([^<]*)/, "$1<Value>$2</Value>");
    expect(() => parseRun(xml)).toThrow("expected text, not nested elements");
  });

  it.each([
    ["AttemptHistory", "Attempt"],
    ["SegmentHistory", "Time"],
    ["SplitTimes", "SplitTime"],
  ])("rejects empty %s/%s records instead of filtering them out", (parent, tag) => {
    const xml = modern.replace(`</${parent}>`, `<${tag}/></${parent}>`);
    expect(() => parseRun(xml)).toThrow(LssParseError);
    expect(() => parseRun(xml)).toThrow(`Invalid <${tag}> record`);
  });

  it("rejects comparisons with no identity instead of silently dropping their times", () => {
    expect(() => parseRun(modern.replace('name="Personal Best"', ""))).toThrow(
      "missing its name attribute",
    );
  });
});
