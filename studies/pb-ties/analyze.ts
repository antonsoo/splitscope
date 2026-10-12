/** Real import, forecast and Markdown export; reads one XML case per JSON line. */
import { createInterface } from "node:readline";
import { simulatePbOdds } from "../../src/core/montecarlo.js";
import { parseRun } from "../../src/core/parser.js";
import { pbTotal } from "../../src/core/stats.js";
import { buildMarkdownSummary } from "../../src/ui/export.js";

for await (const line of createInterface({ input: process.stdin })) {
  const {
    id,
    xml,
    simulations = 8000,
  } = JSON.parse(line) as {
    id: string;
    xml: string;
    simulations?: number;
  };
  try {
    const run = parseRun(xml);
    const results = (["RealTime", "GameTime"] as const).map((method) => {
      const params = { method, recentWindow: 30, simulations, lookaheadAttempts: 50 };
      return {
        method,
        result: simulatePbOdds(run, pbTotal(run, method), params),
        markdown: buildMarkdownSummary(run, params),
      };
    });
    console.log(JSON.stringify({ id, results }));
  } catch (cause) {
    console.log(JSON.stringify({ id, error: String(cause) }));
  }
}
