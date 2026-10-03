import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRun } from "../src/core/parser.js";
import { buildMarkdownSummary, markdownText } from "../src/ui/export.js";

const xml = readFileSync(new URL("./fixtures/modern-full.lss", import.meta.url), "utf8");
const params = {
  method: "RealTime" as const,
  recentWindow: 30,
  simulations: 1000,
  lookaheadAttempts: 5,
};

describe("share evidence", () => {
  it("does not turn absent PBs into zero probabilities", () => {
    const report = buildMarkdownSummary(
      parseRun(xml.replaceAll('name="Personal Best"', 'name="Other"')),
      params,
    );
    expect(report).toContain("No PB recorded");
    expect(report).not.toContain("95% CI");
    expect(report).not.toContain("0.00%");
  });
  it("labels incomplete sums and withholds total time save", () => {
    const report = buildMarkdownSummary(
      parseRun(xml.replace("<RealTime>00:00:55.0000000</RealTime>", "<RealTime/>")),
      params,
    );
    expect(report).toContain("incomplete — missing a gold");
    expect(report).toContain("Total possible time save:** — (requires");
  });
  it("labels synthetic exports, actual window coverage and missing timestamps", () => {
    const run = parseRun(xml);
    const report = buildMarkdownSummary(
      { ...run, attempts: run.attempts.map((a) => ({ ...a, started: null })) },
      { ...params, isSample: true },
    );
    expect(report).toContain("Synthetic sample");
    expect(report).toContain("resampled from the last 3 attempts");
    expect(report).toContain("0 / 3 attempts have valid timestamps");
    expect(buildMarkdownSummary(run, params)).not.toContain("Synthetic sample");
  });
  it("keeps markup in game and segment names literal", () => {
    const report = buildMarkdownSummary(
      parseRun(
        xml
          .replace("Crystal Caverns", "&lt;img src=x&gt; [link](https://example.com)")
          .replace("Cave Entrance", "A|B&#10;# Header"),
      ),
      params,
    );
    expect(report).toContain("&lt;img src=x&gt; \\[link\\]\\(https://example\\.com\\)");
    expect(report).toContain("A\\|B \\# Header");
    expect(markdownText("a\\b *x* & <b>")).toBe("a\\\\b \\*x\\* &amp; &lt;b&gt;");
  });
});
