/** Reproducible core timings on the bundled run and two large pinned histories. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import { parseRun } from "../../src/core/parser.js";
import { comparePractice, inspectAttempt } from "../../src/core/review.js";

const files = [
  "examples/recorded/zero-divide-2.lss",
  "studies/pb-odds-backtest/cache/zhrakula_nes/Tengen Tetris (NES)/Tengen Tetris (NES) - 100 Lines.lss",
  "studies/pb-odds-backtest/cache/narfman0_livesplit-data/splits/Super Mario Bros. 3 - Any% Warpless.lss",
];
const median = (values: number[]) => {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2;
};
const results = files.map((file) => {
  const raw = readFileSync(file);
  const text = raw.toString("utf8");
  const parseMs: number[] = [];
  const coldReviewMs: number[] = [];
  const warmReviewMs: number[] = [];
  const inspectionMs: number[] = [];
  const run = parseRun(text);
  for (let i = 0; i < 12; i++) {
    let start = performance.now();
    const fresh = parseRun(text);
    parseMs.push(performance.now() - start);
    start = performance.now();
    comparePractice(fresh, "RealTime", 30);
    coldReviewMs.push(performance.now() - start);
    start = performance.now();
    comparePractice(fresh, "RealTime", fresh.attempts.length);
    warmReviewMs.push(performance.now() - start);
    start = performance.now();
    const last = fresh.attempts.at(-1);
    if (last) inspectAttempt(fresh, last.id, "RealTime");
    inspectionMs.push(performance.now() - start);
  }
  return {
    file,
    sha256: createHash("sha256").update(raw).digest("hex"),
    bytes: raw.length,
    attempts: run.attempts.length,
    segments: run.segments.length,
    medianParseMs: median(parseMs),
    medianColdReviewMs: median(coldReviewMs),
    medianWholeHistoryReviewMs: median(warmReviewMs),
    medianInspectLastAttemptMs: median(inspectionMs),
  };
});
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: `${process.platform} ${release()}`,
      logicalCpus: cpus().length,
      memoryGiB: Math.round(totalmem() / 1024 ** 3),
      iterations: 12,
      results,
    },
    null,
    2,
  ),
);
