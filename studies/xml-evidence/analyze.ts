/** Read JSONL inputs; an alternate source root allows an unchanged baseline replay. */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const root = process.argv[2] ?? ".";
const { parseRun } = (await import(
  pathToFileURL(resolve(root, "src/core/parser.ts")).href
)) as typeof import("../../src/core/parser.js");
const { bestRoute } = (await import(
  pathToFileURL(resolve(root, "src/core/best-route.ts")).href
)) as typeof import("../../src/core/best-route.js");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
for await (const line of createInterface({ input: process.stdin })) {
  const { id, xml } = JSON.parse(line) as { id: string; xml: string };
  try {
    const run = parseRun(xml);
    const complete = JSON.stringify(run, (_, value) => (value instanceof Map ? [...value] : value));
    const evidence = {
      gameName: run.gameName,
      categoryName: run.categoryName,
      offset: run.offset,
      attemptCount: run.attemptCount,
      attempts: run.attempts.map(({ id, time, pauseTime }) => ({ id, time, pauseTime })),
      segments: run.segments.map(({ name, splitTimes, bestSegmentTime, history }) => ({
        name,
        personalBest: splitTimes.get("Personal Best") ?? { realTime: null, gameTime: null },
        bestSegmentTime,
        history,
      })),
    };
    const routes = [bestRoute(run, "RealTime"), bestRoute(run, "GameTime")];
    console.log(
      JSON.stringify({
        id,
        status: "parsed",
        runHash: hash(complete),
        routeHash: hash(JSON.stringify(routes)),
        ...(process.argv.includes("--hash-only")
          ? {}
          : { run: evidence, totals: routes.map((route) => route.totalSeconds) }),
      }),
    );
  } catch (cause) {
    console.log(JSON.stringify({ id, status: "rejected", error: String(cause) }));
  }
}
