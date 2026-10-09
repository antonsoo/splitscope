/** Emit implementation output for the independent Rust/XML verification. */
import { createInterface } from "node:readline";
import { bestLegEvidence, bestRoute } from "../../src/core/best-route.js";
import { parseRun } from "../../src/core/parser.js";

for await (const line of createInterface({ input: process.stdin })) {
  const { id, xml } = JSON.parse(line) as { id: string; xml: string };
  try {
    const run = parseRun(xml);
    const results = (["RealTime", "GameTime"] as const).map((method) => {
      const route = bestRoute(run, method);
      return { ...route, evidence: route.legs.map((leg) => bestLegEvidence(run, leg)) };
    });
    console.log(JSON.stringify({ id, results }));
  } catch (cause) {
    console.log(JSON.stringify({ id, error: String(cause) }));
  }
}
