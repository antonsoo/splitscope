import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bestRoute } from "../src/core/best-route.js";
import { LssParseError } from "../src/core/errors.js";
import { parseRun } from "../src/core/parser.js";

const original = readFileSync(new URL("./fixtures/modern-full.lss", import.meta.url), "utf8");
const reference = parseRun(original);

describe.each(["Icon", "GameIcon", "AutoSplitterSettings"])("opaque XML boundary: %s", (tag) => {
  it("preserves timing records between comments mentioning the tag", () => {
    const xml = original.replace(
      /(<Time id="2">[\s\S]*?<\/Time>)/,
      `<!-- <${tag}> -->$1<!-- </${tag}> -->`,
    );
    expect(parseRun(xml)).toEqual(reference);
  });

  it("preserves timing records between processing instructions", () => {
    const xml = original.replace(
      /(<Time id="2">[\s\S]*?<\/Time>)/,
      `<?note <${tag}> ?>$1<?note </${tag}> ?>`,
    );
    expect(parseRun(xml)).toEqual(reference);
  });

  it("preserves a literal tag in a CDATA name", () => {
    const name = `Cave <${tag}>literal</${tag}> Entrance`;
    const run = parseRun(
      original.replace("<Name>Cave Entrance</Name>", `<Name><![CDATA[${name}]]></Name>`),
    );
    expect(run.segments[0]?.name).toBe(name);
    expect(run.segments[0]?.history).toEqual(reference.segments[0]?.history);
  });

  it("ignores apparent closing tags inside an actual opaque node's CDATA and comments", () => {
    const payload = `<${tag}><![CDATA[</${tag}>]]><!-- </${tag}> --><Setting>A</Setting></${tag}>`;
    const xml =
      tag === "AutoSplitterSettings"
        ? original.replace("</Run>", `${payload}</Run>`)
        : original.replace(tag === "Icon" ? "<Icon />" : "<GameIcon />", payload);
    expect(parseRun(xml)).toEqual(reference);
  });

  it("rejects mismatched structure inside actual opaque payloads", () => {
    const payload = `<${tag}><Unclosed></${tag}>`;
    const xml =
      tag === "AutoSplitterSettings"
        ? original.replace("</Run>", `${payload}</Run>`)
        : original.replace(tag === "Icon" ? "<Icon />" : "<GameIcon />", payload);
    expect(() => parseRun(xml)).toThrow(LssParseError);
  });
});

it("does not ignore real nested Icon elements inside a required scalar", () => {
  const xml = original.replace(
    "<Name>Cave Entrance</Name>",
    "<Name>Cave <Icon>nested</Icon> Entrance</Name>",
  );
  expect(() => parseRun(xml)).toThrow("expected text, not nested elements");
});

it("keeps Destrega's recorded best span when comments surround its source record", () => {
  const xml = readFileSync(new URL("../examples/recorded/destrega.lss", import.meta.url), "utf8");
  const parts = xml.split("<Segment>");
  const segment = parts[16] ?? "";
  expect(segment).toContain('<Time id="58">');
  parts[16] = segment.replace(
    /(<Time id="58">[\s\S]*?<\/Time>)/,
    "<!-- <Icon> -->$1<!-- </Icon> -->",
  );
  const before = parseRun(xml);
  const annotated = parseRun(parts.join("<Segment>"));
  expect(annotated).toEqual(before);
  expect(bestRoute(annotated, "RealTime")).toEqual(bestRoute(before, "RealTime"));
  expect(bestRoute(annotated, "RealTime").totalSeconds).toBeCloseTo(1511.017, 9);
});
