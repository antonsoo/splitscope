/** Measure fresh calculations, not the WeakMap cache; retain input sizes. */
import { readFileSync } from "node:fs";
import { bestRoute, buildBestExport } from "../../src/core/best-route.js";
import { decodeText } from "../../src/core/decode.js";
import { parseRun } from "../../src/core/parser.js";
import type { Run } from "../../src/core/types.js";

const manifest = JSON.parse(readFileSync("studies/pb-odds-backtest/manifest.json", "utf8")) as {
  repos: { repo: string; files: { path: string }[] }[];
};
const runs: { id: string; run: Run; entries: number }[] = [];
for (const repo of manifest.repos)
  for (const file of repo.files) {
    const id = `${repo.repo}/${file.path}`;
    const raw = readFileSync(
      `studies/pb-odds-backtest/cache/${repo.repo.replace("/", "_")}/${file.path}`,
    );
    let run: Run;
    try {
      run = parseRun(decodeText(raw));
    } catch {
      continue;
    }
    runs.push({
      id,
      run,
      entries: run.segments.reduce((n, segment) => n + segment.history.length, 0),
    });
  }
const largest = [...runs].sort((a, b) => b.entries - a.entries)[0];
if (!largest) throw Error("No inputs");
const corpusTimes: number[] = [];
for (let repeat = 0; repeat < 7; repeat++) {
  const start = performance.now();
  for (const { run } of runs) {
    const fresh = { ...run };
    bestRoute(fresh, "RealTime");
    bestRoute(fresh, "GameTime");
  }
  corpusTimes.push(performance.now() - start);
}
const largeTimes: number[] = [];
for (let repeat = 0; repeat < 21; repeat++) {
  const start = performance.now();
  bestRoute({ ...largest.run }, "RealTime");
  largeTimes.push(performance.now() - start);
}
const middle = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const start = performance.now();
const exported = JSON.stringify(
  buildBestExport(largest.run, "RealTime", {
    name: largest.id,
    sha256: "benchmark",
    bytes: 0,
    synthetic: false,
  }),
);
console.log(
  JSON.stringify(
    {
      files: runs.length,
      corpusBothMethodsMedianMs: middle(corpusTimes),
      largest: {
        id: largest.id,
        segments: largest.run.segments.length,
        historyEntries: largest.entries,
        calculationMedianMs: middle(largeTimes),
        exportMs: performance.now() - start,
        exportBytes: Buffer.byteLength(exported),
      },
      corpusTimesMs: corpusTimes,
      largestTimesMs: largeTimes,
    },
    null,
    2,
  ),
);
