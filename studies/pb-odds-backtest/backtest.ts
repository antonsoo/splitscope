/**
 * Walk-forward backtest of splitscope's PB odds on real .lss histories.
 *
 * For each eligible file and each stopping point k, the run is truncated to its first k
 * attempts (attempt list AND every segment's history), the PB is recomputed from those
 * attempts alone, simulatePbOdds is called, and the forecast is paired with what the
 * next attempts did. Nothing from attempt k or later reaches the model.
 *
 *   tsx backtest.ts --src ../../src --shard 0/4 --out cache/rows-checkout.0.json
 *     [--opts '{"recentWindow":30}'] [--sims 5000] [--mc montecarlo-variants.ts] [--cdf 1]
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Attempt, Run, TimingMethod } from "../../src/core/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] as string) : dflt;
};
const srcDir = resolve(here, arg("src", "../../src"));
const [shardI, shardN] = arg("shard", "0/1").split("/").map(Number) as [number, number];
const out = resolve(here, arg("out", "cache/rows.json"));
const extra = JSON.parse(arg("opts", "{}")) as Record<string, unknown>;
const sims = Number(arg("sims", "5000"));
const windowSize = Number(extra.recentWindow ?? 30);

const load = (p: string) => import(pathToFileURL(join(srcDir, p)).href);
const { parseRun } = await load("core/parser.js");
const mcPath = arg("mc", "");
const { simulatePbOdds } = mcPath
  ? await import(pathToFileURL(resolve(here, mcPath)).href)
  : await load("core/montecarlo.js");
const { seedFromString } = await load("core/rng.js");

const wantCdf = arg("cdf", "0") === "1";
const RATIOS = [0.9, 0.95, 1, 1.02, 1.05, 1.1, 1.2, 1.35, 1.6, 2.2];
const MIN_ATTEMPTS = 100;
const MIN_FINISHES = 10;
const MAX_POINTS = 200;
const FIRST_K = 30;

interface Row {
  file: number;
  runner: number;
  k: number;
  n: number;
  pOne: number;
  finishProb: number;
  pbOverAll: number;
  bOne: number;
  bW: number;
  bAll: number;
  y1: number;
  y10: number | null;
  y50: number | null;
  nextFinishRate50: number | null;
  windowFinishRate: number;
  pbEvents: number;
  beatCount50: number | null;
  finCount50: number | null;
  pb: number;
  cdf: [number | null, number | null][] | null;
  nFin: number;
  lastFin: [number, number][];
  finRate30: number;
  finRate100: number;
  winFinMedian: number | null;
  futFinMedian: number | null;
}

function median(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = v.length >> 1;
  return v.length % 2 ? (v[m] as number) : ((v[m - 1] as number) + (v[m] as number)) / 2;
}

/** [attempts before k, total] for the most recent completed attempts, newest first. */
function lastFinishes(times: (number | null)[], k: number, count: number): [number, number][] {
  const out: [number, number][] = [];
  for (let j = k - 1; j >= 0 && out.length < count; j--) {
    const t = times[j] as number | null;
    if (t !== null) out.push([k - j, t]);
  }
  return out;
}

const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8")) as {
  repos: { repo: string; files: { path: string }[] }[];
};

interface Candidate {
  runner: number;
  repo: string;
  path: string;
  run: Run;
  method: TimingMethod;
  times: (number | null)[];
  key: string;
}

const candidates: Candidate[] = [];
manifest.repos.forEach((r, runner) => {
  for (const f of r.files) {
    const text = readFileSync(join(here, "cache", r.repo.replace("/", "_"), f.path), "utf8");
    let run: Run;
    try {
      run = parseRun(text);
    } catch {
      continue;
    }
    const att = run.attempts;
    const nReal = att.filter((a) => a.time.realTime !== null).length;
    const nGame = att.filter((a) => a.time.gameTime !== null).length;
    const method = nGame > nReal ? "GameTime" : "RealTime";
    const times = att.map((a) => (method === "RealTime" ? a.time.realTime : a.time.gameTime));
    const finishes = times.filter((t) => t !== null).length;
    if (att.length < MIN_ATTEMPTS || finishes < MIN_FINISHES) continue;
    const key = createHash("sha1")
      .update(JSON.stringify(run.attempts.slice(0, 5)))
      .digest("hex");
    candidates.push({ runner, repo: r.repo, path: f.path, run, method, times, key });
  }
});

// Drop exact re-exports and shorter copies of the same history: same first five attempts.
const best = new Map<string, Candidate>();
for (const c of candidates) {
  const cur = best.get(c.key);
  if (!cur || c.times.length > cur.times.length) best.set(c.key, c);
}
const files = [...best.values()].sort((a, b) =>
  `${a.repo}/${a.path}`.localeCompare(`${b.repo}/${b.path}`),
);

const rows: Row[] = [];
const skipped = { noPb: 0, insufficient: 0, unknownOutcome: 0, emptyPool: 0 };
files.forEach((c, fileIdx) => {
  if (fileIdx % shardN !== shardI) return;
  const { run, method, times } = c;
  const attempts: readonly Attempt[] = run.attempts;
  const n = attempts.length;
  // PB-event flags: attempt i is a PB if it finishes below every earlier finish.
  const isPb: number[] = [];
  let runMin = Number.POSITIVE_INFINITY;
  const prefixMin: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = times[i] as number | null;
    prefixMin.push(runMin); // PB as of before attempt i
    if (t !== null && t < runMin) {
      isPb.push(1);
      runMin = t;
    } else isPb.push(0);
  }
  const cum = [0];
  for (const v of isPb) cum.push((cum[cum.length - 1] as number) + v);
  const fin = [0];
  for (const t of times) fin.push((fin[fin.length - 1] as number) + (t !== null ? 1 : 0));

  const ks: number[] = [];
  const stride = Math.max(5, Math.ceil((n - 1 - FIRST_K) / MAX_POINTS));
  for (let k = FIRST_K; k < n; k += stride) ks.push(k);

  for (const k of ks) {
    const pb = prefixMin[k] as number;
    if (!Number.isFinite(pb)) {
      skipped.noPb++;
      continue;
    }
    const ids = new Set(attempts.slice(0, k).map((a) => a.id));
    const truncated = {
      ...run,
      attemptCount: k,
      attempts: run.attempts.slice(0, k),
      segments: run.segments.map((s) => ({
        ...s,
        history: s.history.filter((h) => ids.has(h.attemptId)),
      })),
    };
    const res = simulatePbOdds(truncated, pb, {
      method,
      recentWindow: windowSize,
      simulations: sims,
      lookaheadAttempts: 50,
      seed: seedFromString(`${c.repo}/${c.path}|${k}`),
      ...extra,
    });
    if (res.insufficientData || res.pbProbabilityPerAttempt === null) {
      skipped.insufficient++;
      if (String(res.unavailableReason).startsWith("A recent")) skipped.unknownOutcome++;
      else skipped.emptyPool++;
      continue;
    }
    const beats = (j: number) => {
      const t = times[j] as number | null;
      return t !== null && t < pb;
    };
    const anyIn = (len: number): number | null => {
      if (k + len > n) return null;
      for (let j = k; j < k + len; j++) if (beats(j)) return 1;
      return 0;
    };
    const w = Math.min(100, k);
    const f = (events: number, span: number) => events / span;
    rows.push({
      file: fileIdx,
      runner: c.runner,
      k,
      n,
      pOne: res.pbProbabilityPerAttempt,
      finishProb: res.finishProbability as number,
      pbOverAll: f(cum[k] as number, k),
      bOne: f(cum[k] as number, k),
      bW: f((cum[k] as number) - (cum[k - w] as number), w),
      bAll: f(cum[k] as number, k),
      y1: beats(k) ? 1 : 0,
      y10: anyIn(10),
      y50: anyIn(50),
      nextFinishRate50: n - k >= 50 ? ((fin[k + 50] as number) - (fin[k] as number)) / 50 : null,
      windowFinishRate:
        ((fin[k] as number) - (fin[k - Math.min(windowSize, k)] as number)) /
        Math.min(windowSize, k),
      pbEvents: cum[k] as number,
      beatCount50:
        n - k >= 50
          ? Array.from({ length: 50 }, (_, j) => (beats(k + j) ? 1 : 0)).reduce<number>(
              (a, b) => a + b,
              0,
            )
          : null,
      finCount50: n - k >= 50 ? (fin[k + 50] as number) - (fin[k] as number) : null,
      pb,
      cdf:
        wantCdf && n - k >= 50
          ? RATIOS.map((q) => {
              const g = simulatePbOdds(truncated, pb * q, {
                method,
                recentWindow: windowSize,
                simulations: sims,
                lookaheadAttempts: 50,
                seed: seedFromString(`${c.repo}/${c.path}|${k}`),
                ...extra,
              });
              const fut = times.slice(k, k + 50).filter((t): t is number => t !== null);
              return [
                g.pbProbabilityGivenFinish,
                fut.length ? fut.filter((t) => t < pb * q).length / fut.length : null,
              ];
            })
          : null,
      nFin: fin[k] as number,
      lastFin: lastFinishes(times, k, 40),
      finRate30: ((fin[k] as number) - (fin[Math.max(0, k - 30)] as number)) / Math.min(30, k),
      finRate100: ((fin[k] as number) - (fin[Math.max(0, k - 100)] as number)) / Math.min(100, k),
      winFinMedian: median(times.slice(Math.max(0, k - windowSize), k)),
      futFinMedian: n - k >= 50 ? median(times.slice(k, k + 50)) : null,
    });
  }
});
writeFileSync(
  out,
  JSON.stringify({
    rows,
    skipped,
    eligibleBeforeDedupe: candidates.length,
    files: files.map((c, i) => ({
      i,
      runner: c.runner,
      repo: c.repo,
      path: c.path,
      attempts: c.times.length,
      finishes: c.times.filter((t) => t !== null).length,
      segments: c.run.segments.length,
      method: c.method,
    })),
  }),
);
console.error(
  `shard ${shardI}: ${rows.length} rows, skipped`,
  JSON.stringify(skipped),
  `files ${files.length}`,
);
