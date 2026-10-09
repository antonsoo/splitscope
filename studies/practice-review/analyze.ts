/** Emit actual implementation results; verify.py checks them with an independent XML reader. */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { decodeText } from "../../src/core/decode.js";
import { parseRun } from "../../src/core/parser.js";
import { comparePractice, inspectAttempt } from "../../src/core/review.js";
import type { Run, TimingMethod } from "../../src/core/types.js";

const manifestPath = resolve(process.argv[2] ?? "studies/pb-odds-backtest/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  repos: { repo: string; files: { path: string }[] }[];
};
for (const repo of manifest.repos) {
  for (const file of repo.files) {
    const id = `${repo.repo}/${file.path}`;
    const bytes = readFileSync(
      join(dirname(manifestPath), "cache", repo.repo.replace("/", "_"), file.path),
    );
    let run: Run;
    try {
      run = parseRun(decodeText(bytes));
    } catch (cause) {
      console.log(JSON.stringify({ id, error: String(cause) }));
      continue;
    }
    const configurations = [
      { window: 30, end: run.attempts.length },
      { window: 17, end: Math.floor(run.attempts.length / 2) },
    ];
    const comparisons = configurations.flatMap(({ window, end }) =>
      (["RealTime", "GameTime"] as const).map((method) =>
        comparePractice(run, method, window, end),
      ),
    );
    const inspections = run.attempts.slice(-60).flatMap((attempt) =>
      (["RealTime", "GameTime"] as TimingMethod[]).map((method) => ({
        id: attempt.id,
        method,
        records: inspectAttempt(run, attempt.id, method),
      })),
    );
    console.log(JSON.stringify({ id, comparisons, inspections }));
  }
}
