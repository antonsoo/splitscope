import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { simulatePbOdds } from "../src/core/montecarlo.js";
import { parseRun } from "../src/core/parser.js";
import { pbTotal } from "../src/core/stats.js";
import { buildMarkdownSummary } from "../src/ui/export.js";

function fixture(name: string) {
  return parseRun(
    readFileSync(new URL(`../studies/pb-ties/fixtures/${name}.lss`, import.meta.url), "utf8"),
  );
}

for (const method of ["RealTime", "GameTime"] as const) {
  describe(`PB comparisons in ${method}`, () => {
    const options = { method, recentWindow: 30, simulations: 1000, lookaheadAttempts: 50 };
    for (const [name, probability] of [
      ["exact-tie", 0],
      ["negative-offset-tie", 0],
      ["one-tick-faster", 1],
      ["one-tick-slower", 0],
      ["one-nanosecond-faster", 1],
      ["one-nanosecond-slower", 0],
      ["many-segments", 0],
      ["day-crossing", 0],
      ["precision-boundary-tie", 0],
      ["precision-boundary-faster", 1],
      ["precision-boundary-slower", 0],
      ["cancellation-tie", 0],
    ] as const) {
      it(`${name}: classifies stored durations, without an arbitrary time tolerance`, () => {
        const run = fixture(name);
        const result = simulatePbOdds(run, pbTotal(run, method), options);
        expect(result.insufficientData).toBe(false);
        expect(result.finishProbability).toBe(1);
        expect(result.pbProbabilityPerAttempt).toBe(probability);
      });
    }

    it("exports a tied history as zero observed simulated PBs", () => {
      const markdown = buildMarkdownSummary(fixture("exact-tie"), options);
      expect(markdown).toContain("P(next attempt beats PB):** 0.00%");
      expect(markdown).toContain("P(≥ 1 PB in next 50 attempts):** 0.0%");
    });

    for (const name of ["precision-unavailable", "sum-unavailable"]) {
      it(`${name}: keeps unsupported precision unavailable`, () => {
        const run = fixture(name);
        const result = simulatePbOdds(run, pbTotal(run, method), options);
        expect(result.insufficientData).toBe(true);
        expect(result.simulations).toBe(0);
        expect(result.pbProbabilityPerAttempt).toBeNull();
        expect(result.unavailableReason).toContain("numeric precision");
        expect(buildMarkdownSummary(run, options)).toContain("numeric precision");
      });
    }

    it("keeps true faster outcomes in a distribution with ties and resets", () => {
      const run = fixture("mixed-with-resets");
      const result = simulatePbOdds(run, pbTotal(run, method), {
        ...options,
        simulations: 100_000,
      });
      // Half the attempts reset. A third of surviving samples are faster,
      // a third tie and a third are slower: P(PB) = 1/2 * 1/3, not 1/3.
      expect(result.finishProbability).toBeCloseTo(1 / 2, 2);
      expect(result.pbProbabilityPerAttempt).toBeCloseTo(1 / 6, 2);
    });
  });
}
