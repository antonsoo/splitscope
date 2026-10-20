/** Measures only clock indexing and time partitioning; parsing/review already completed. */
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { decodeText } from "../../src/core/decode.js";
import { parseRun } from "../../src/core/parser.js";
import { comparePracticeTime } from "../../src/core/practice-time.js";
import { comparePractice } from "../../src/core/review.js";
import type { Run } from "../../src/core/types.js";

const corpus = "studies/pb-odds-backtest";
const manifest = JSON.parse(readFileSync(`${corpus}/manifest.json`, "utf8")) as {
  repos: { repo: string; files: { path: string; sha256: string }[] }[];
};
let largest: { run: Run; id: string; sha256: string } | null = null;
for (const repo of manifest.repos)
  for (const file of repo.files) {
    try {
      const run = parseRun(
        decodeText(readFileSync(`${corpus}/cache/${repo.repo.replace("/", "_")}/${file.path}`)),
      );
      if (!largest || run.attempts.length > largest.run.attempts.length)
        largest = { run, id: `${repo.repo}/${file.path}`, sha256: file.sha256 };
    } catch {
      /* The verifier separately requires the three exact exclusions. */
    }
  }
if (!largest) throw Error("No parsed corpus inputs");
const comparison = comparePractice(largest.run, "RealTime", 30);
const cold = [];
for (let pass = 0; pass < 23; pass++) {
  const uncached = { ...largest.run };
  const start = performance.now();
  const result = comparePracticeTime(uncached, comparison);
  const elapsed = performance.now() - start;
  if (pass >= 2) cold.push(elapsed);
  if (result.recent.total.attempts !== comparison.recent.attempts.length)
    throw Error("Missing group");
}
comparePracticeTime(largest.run, comparison);
const cached = [];
for (let pass = 0; pass < 101; pass++) {
  const start = performance.now();
  comparePracticeTime(largest.run, comparison);
  if (pass > 0) cached.push(performance.now() - start);
}
function distribution(values: number[]) {
  values.sort((a, b) => a - b);
  return {
    n: values.length,
    medianMilliseconds: values[Math.floor(values.length / 2)],
    minMilliseconds: values[0],
    maxMilliseconds: values.at(-1),
  };
}
const result = {
  node: process.version,
  vcpus: cpus().length,
  memoryGiB: totalmem() / 2 ** 30,
  platform: process.platform,
  input: {
    id: largest.id,
    sha256: largest.sha256,
    attempts: largest.run.attempts.length,
    segments: largest.run.segments.length,
  },
  scope:
    "30-attempt groups; cold rebuilds the entire clock index with a fresh wrapper around unchanged parsed records; cached retains that index. Parsing and prior review-count computation excluded. Shared WSL2 host; not a general performance guarantee.",
  cold: distribution(cold),
  cached: distribution(cached),
};
console.log(JSON.stringify(result, null, 2));
if (process.argv[2]) writeFileSync(process.argv[2], `${JSON.stringify(result, null, 2)}\n`);
