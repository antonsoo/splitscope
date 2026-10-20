/** Implementation output only; verify.py derives its own expectations from original XML. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { attemptClocks } from "../../src/core/attempt-clock.js";
import { decodeText } from "../../src/core/decode.js";
import { parseRun } from "../../src/core/parser.js";
import { comparePracticeTime } from "../../src/core/practice-time.js";
import { comparePractice } from "../../src/core/review.js";

process.stdin.setEncoding("utf8");
let input = "";
for await (const chunk of process.stdin) input += chunk;
for (const entry of JSON.parse(input) as { id: string; path: string }[]) {
  const raw = readFileSync(entry.path);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  try {
    const run = parseRun(decodeText(raw));
    const configurations = [
      { window: 30, end: run.attempts.length },
      { window: 17, end: Math.floor(run.attempts.length / 2) },
      { window: Math.max(1, run.attempts.length), end: run.attempts.length },
    ];
    const groups = configurations.map(({ window, end }) => {
      const comparison = comparePractice(run, "RealTime", window, end);
      const result = comparePracticeTime(run, comparison);
      const other = comparePracticeTime(run, comparePractice(run, "GameTime", window, end));
      if (JSON.stringify(result) !== JSON.stringify(other))
        throw Error("Elapsed time changed with timing method");
      return { window, end, ...result };
    });
    console.log(
      JSON.stringify({ id: entry.id, sha256, clocks: [...attemptClocks(run).values()], groups }),
    );
  } catch (cause) {
    console.log(JSON.stringify({ id: entry.id, sha256, error: String(cause) }));
  }
}
