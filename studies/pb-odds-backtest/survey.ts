import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseRun } from "../../src/core/parser.js";
import { hasCompletionTime } from "../../src/core/stats.js";

function* walk(d: string): Generator<string> {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.toLowerCase().endsWith(".lss")) yield p;
  }
}
const root = process.argv[2] as string;
for (const f of walk(root)) {
  try {
    const run = parseRun(readFileSync(f, "utf8"));
    const fin = run.attempts.filter(hasCompletionTime).length;
    console.log(
      [f.slice(root.length + 1), run.attempts.length, fin, run.segments.length].join("\t"),
    );
  } catch (e) {
    console.log(f.slice(root.length + 1), "ERR", String(e).slice(0, 60));
  }
}
