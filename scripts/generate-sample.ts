/**
 * Generates synthetic `.lss` sample files for a fictional game, "Crystal
 * Caverns — Any%". There is no such game; every number in these files is
 * simulated by this script, not recorded from a real run. `GameName` and
 * `CategoryName` are left clean ("Crystal Caverns" / "Any%") on purpose —
 * they're displayed inline in the app's headline sentence, so a synthetic
 * marker stuffed into either would read as part of the category. The app
 * labels sample data as synthetic itself (a badge shown whenever a run was
 * loaded via "Load sample", driven by how the file was loaded, not by
 * parsing anything out of the file), and `docs/format.md` and the README
 * say so too.
 *
 * The simulation is a simple random walk with a learning curve, run once
 * with a fixed seed so the output is reproducible:
 *   - Per-segment mean time decays toward a skill floor as attempts progress
 *     (`mean(t) = floor + (base - floor) * decay^t`), and its standard
 *     deviation shrinks the same way (a runner gets both faster and more
 *     consistent with practice).
 *   - A per-segment, decaying reset hazard: early attempts die a lot;
 *     later attempts rarely do, but never at literally zero — three
 *     "run-killer" segments (spread across the early, middle, and late
 *     game, not just stacked at the end, the way a real category usually
 *     has more than one trouble spot) keep a meaningfully nonzero hazard
 *     even at the skill floor, the way an execution-heavy trick stays
 *     risky no matter how practiced a runner is.
 *   - GameTime is RealTime minus a random load-time deduction, and is left
 *     unset for the first stretch of attempts, to model a runner who turned
 *     on load-time removal partway through — a realistic instance of the
 *     "missing GameTime" edge case the parser has to handle.
 *
 * Run with `npm run sample:generate`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mulberry32 } from "../src/core/rng.js";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "examples");

interface SegmentSpec {
  readonly name: string;
  readonly baseMean: number;
  readonly floorMean: number;
  readonly baseSd: number;
  readonly floorSd: number;
  readonly baseHazard: number;
  readonly floorHazard: number;
}

// 14 segments: a realistic split count for a full-category any% run. Three are
// designated "run-killers" (Mossy Tunnels, Shadow Gate, Boss Room) — spread across
// the early, late-middle, and end game rather than all clustered at the finish —
// with a floor hazard well above the others, so even a near-optimal recent stretch
// still has real risk in it, not a flat 100% finish rate.
const SEGMENTS: readonly SegmentSpec[] = [
  {
    name: "Cave Entrance",
    baseMean: 40,
    floorMean: 32,
    baseSd: 5.0,
    floorSd: 1.3,
    baseHazard: 0.02,
    floorHazard: 0.006,
  },
  {
    name: "Glowing Passage",
    baseMean: 55,
    floorMean: 43,
    baseSd: 6.0,
    floorSd: 1.6,
    baseHazard: 0.03,
    floorHazard: 0.01,
  },
  {
    name: "Crystal Lake",
    baseMean: 75,
    floorMean: 58,
    baseSd: 8.0,
    floorSd: 2.2,
    baseHazard: 0.06,
    floorHazard: 0.015,
  },
  {
    name: "Sunken Ruins",
    baseMean: 70,
    floorMean: 55,
    baseSd: 8.0,
    floorSd: 2.0,
    baseHazard: 0.08,
    floorHazard: 0.02,
  },
  {
    name: "Underground Falls",
    baseMean: 62,
    floorMean: 48,
    baseSd: 7.0,
    floorSd: 1.8,
    baseHazard: 0.07,
    floorHazard: 0.018,
  },
  {
    name: "Mossy Tunnels",
    baseMean: 85,
    floorMean: 66,
    baseSd: 12.0,
    floorSd: 3.5,
    baseHazard: 0.4,
    floorHazard: 0.07,
  }, // run-killer
  {
    name: "Echo Chamber",
    baseMean: 50,
    floorMean: 39,
    baseSd: 6.0,
    floorSd: 1.5,
    baseHazard: 0.05,
    floorHazard: 0.012,
  },
  {
    name: "Frozen Grotto",
    baseMean: 68,
    floorMean: 53,
    baseSd: 8.0,
    floorSd: 2.1,
    baseHazard: 0.09,
    floorHazard: 0.02,
  },
  {
    name: "Obsidian Spire",
    baseMean: 90,
    floorMean: 70,
    baseSd: 11.0,
    floorSd: 3.0,
    baseHazard: 0.15,
    floorHazard: 0.03,
  },
  {
    name: "Collapsing Path",
    baseMean: 58,
    floorMean: 45,
    baseSd: 7.0,
    floorSd: 1.9,
    baseHazard: 0.1,
    floorHazard: 0.025,
  },
  {
    name: "Lantern Bridge",
    baseMean: 48,
    floorMean: 37,
    baseSd: 6.0,
    floorSd: 1.4,
    baseHazard: 0.06,
    floorHazard: 0.015,
  },
  {
    name: "Ember Hollow",
    baseMean: 72,
    floorMean: 56,
    baseSd: 8.0,
    floorSd: 2.2,
    baseHazard: 0.11,
    floorHazard: 0.025,
  },
  {
    name: "Shadow Gate",
    baseMean: 65,
    floorMean: 50,
    baseSd: 10.0,
    floorSd: 3.0,
    baseHazard: 0.35,
    floorHazard: 0.06,
  }, // run-killer
  {
    name: "Boss Room",
    baseMean: 110,
    floorMean: 82,
    baseSd: 14.0,
    floorSd: 4.0,
    baseHazard: 0.3,
    floorHazard: 0.05,
  }, // run-killer
];

function decay(base: number, floor: number, t: number, rate: number): number {
  return floor + (base - floor) * rate ** t;
}

function boxMuller(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

interface SimAttempt {
  readonly id: number;
  readonly started: Date;
  readonly ended: Date;
  readonly finished: boolean;
  /** Duration of each segment this attempt actually completed, in order. */
  readonly segmentDurations: number[];
  readonly hasGameTime: boolean;
  readonly loadTimeTotal: number;
}

function simulate(
  attemptCount: number,
  seed: number,
  gameTimeAdoptionFraction: number,
): SimAttempt[] {
  const rng = mulberry32(seed);
  const decayRate = 0.985;
  let clock = new Date(Date.UTC(2026, 0, 5, 18, 0, 0));
  const attempts: SimAttempt[] = [];

  for (let t = 0; t < attemptCount; t++) {
    const segmentDurations: number[] = [];
    let finished = true;
    let elapsed = 0;

    for (const spec of SEGMENTS) {
      const hazard = decay(spec.baseHazard, spec.floorHazard, t, decayRate);
      if (rng() < hazard) {
        finished = false;
        break;
      }
      const mean = decay(spec.baseMean, spec.floorMean, t, decayRate);
      const sd = decay(spec.baseSd, spec.floorSd, t, decayRate);
      const duration = Math.max(mean - 3 * sd, mean + sd * boxMuller(rng));
      segmentDurations.push(duration);
      elapsed += duration;
    }

    const started = new Date(clock);
    // A little inter-attempt downtime (menuing, breaks), 5-90s.
    const gapBeforeThis = 5 + rng() * 85;
    started.setUTCSeconds(started.getUTCSeconds() + gapBeforeThis);
    const ended = new Date(started);
    ended.setUTCSeconds(ended.getUTCSeconds() + Math.round(elapsed));
    clock = ended;

    const hasGameTime = t / attemptCount >= 1 - gameTimeAdoptionFraction;
    const loadTimeTotal = hasGameTime ? 2 + rng() * 6 : 0;

    attempts.push({
      id: t + 1,
      started,
      ended,
      finished,
      segmentDurations,
      hasGameTime,
      loadTimeTotal,
    });
  }

  return attempts;
}

function fmtTimestamp(d: Date): string {
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}

function fmtTime(seconds: number | null): string {
  if (seconds === null) return "";
  const totalTicks = Math.round(seconds * 1e7);
  const hours = Math.floor(totalTicks / (3600 * 1e7));
  const rem1 = totalTicks - hours * 3600 * 1e7;
  const minutes = Math.floor(rem1 / (60 * 1e7));
  const rem2 = rem1 - minutes * 60 * 1e7;
  const secWhole = Math.floor(rem2 / 1e7);
  const frac = rem2 - secWhole * 1e7;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secWhole).padStart(2, "0")}.${String(frac).padStart(7, "0")}`;
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildLss(gameName: string, categoryName: string, attempts: readonly SimAttempt[]): string {
  const n = SEGMENTS.length;

  // The realTime PB is the finished attempt with the lowest total. Its own per-segment
  // cumulative splits become the "Personal Best" comparison — a PB is a single coherent
  // run, not a stitched-together best-of-each-segment (that's sum of best, a different stat).
  let pbAttempt: SimAttempt | undefined;
  for (const a of attempts) {
    if (!a.finished) continue;
    const total = a.segmentDurations.reduce((s, v) => s + v, 0);
    const pbTotal =
      pbAttempt?.segmentDurations.reduce((s, v) => s + v, 0) ?? Number.POSITIVE_INFINITY;
    if (total < pbTotal) pbAttempt = a;
  }

  const goldPerSegment: (number | null)[] = Array(n).fill(null);
  for (const a of attempts) {
    a.segmentDurations.forEach((d, i) => {
      if (goldPerSegment[i] === null || d < (goldPerSegment[i] as number)) goldPerSegment[i] = d;
    });
  }

  const attemptHistoryXml = attempts
    .map((a) => {
      const total = a.finished ? a.segmentDurations.reduce((s, v) => s + v, 0) : null;
      const gameTotal = a.finished && a.hasGameTime ? (total as number) - a.loadTimeTotal : null;
      return `    <Attempt id="${a.id}" started="${fmtTimestamp(a.started)}" isStartedSynced="True" ended="${fmtTimestamp(a.ended)}" isEndedSynced="True">
      <RealTime>${fmtTime(total)}</RealTime>
      <GameTime>${fmtTime(gameTotal)}</GameTime>
    </Attempt>`;
    })
    .join("\n");

  const segmentsXml = SEGMENTS.map((spec, i) => {
    const pbCumulative = pbAttempt
      ? pbAttempt.segmentDurations.slice(0, i + 1).reduce((s, v) => s + v, 0)
      : null;
    const pbLoadShare = pbAttempt?.hasGameTime ? (pbAttempt.loadTimeTotal * (i + 1)) / n : null;
    const pbCumulativeGame =
      pbCumulative !== null && pbLoadShare !== null ? pbCumulative - pbLoadShare : null;

    const gold = goldPerSegment[i] ?? null;
    const goldLoadFraction = 0.08; // approximate share of a segment's own time that's "load"

    const historyXml = attempts
      .map((a) => {
        if (i >= a.segmentDurations.length) return null; // never reached (reset before this segment)
        const duration = a.segmentDurations[i] as number;
        const gameDuration = a.hasGameTime
          ? duration * (1 - goldLoadFraction * (0.5 + 0.5 * (i / n)))
          : null;
        return `        <Time id="${a.id}">
          <RealTime>${fmtTime(duration)}</RealTime>
          <GameTime>${fmtTime(gameDuration)}</GameTime>
        </Time>`;
      })
      .filter((x): x is string => x !== null)
      .join("\n");

    return `    <Segment>
      <Name>${xmlEscape(spec.name)}</Name>
      <Icon />
      <SplitTimes>
        <SplitTime name="Personal Best">
          <RealTime>${fmtTime(pbCumulative)}</RealTime>
          <GameTime>${fmtTime(pbCumulativeGame)}</GameTime>
        </SplitTime>
      </SplitTimes>
      <BestSegmentTime>
        <RealTime>${fmtTime(gold)}</RealTime>
        <GameTime>${fmtTime(gold === null ? null : gold * (1 - goldLoadFraction))}</GameTime>
      </BestSegmentTime>
      <SegmentHistory>
${historyXml}
      </SegmentHistory>
    </Segment>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Run version="1.8.1">
  <GameIcon />
  <GameName>${xmlEscape(gameName)}</GameName>
  <CategoryName>${xmlEscape(categoryName)}</CategoryName>
  <LayoutPath />
  <Metadata>
    <Run id="" />
    <Platform usesEmulator="False"></Platform>
    <Region></Region>
    <Variables />
  </Metadata>
  <Offset>00:00:00</Offset>
  <AttemptCount>${attempts.length}</AttemptCount>
  <AttemptHistory>
${attemptHistoryXml}
  </AttemptHistory>
  <Segments>
${segmentsXml}
  </Segments>
  <AutoSplitterSettings />
</Run>
`;
}

mkdirSync(outDir, { recursive: true });

const veteran = simulate(450, 1337, 0.65);
writeFileSync(
  join(outDir, "crystal-caverns-any.lss"),
  buildLss("Crystal Caverns", "Any%", veteran),
);

const freshStart = simulate(10, 2026, 0);
writeFileSync(
  join(outDir, "crystal-caverns-fresh-start.lss"),
  buildLss("Crystal Caverns", "Any% — fresh splits", freshStart),
);

const finishedCount = veteran.filter((a) => a.finished).length;
const recentWindow = veteran.slice(-30);
const recentFinished = recentWindow.filter((a) => a.finished).length;
console.log(
  `Wrote examples/crystal-caverns-any.lss: ${veteran.length} attempts, ${finishedCount} finishes ` +
    `(${((finishedCount / veteran.length) * 100).toFixed(0)}% all-time, ` +
    `${((recentFinished / recentWindow.length) * 100).toFixed(0)}% in the last 30).`,
);
console.log(
  `Wrote examples/crystal-caverns-fresh-start.lss: ${freshStart.length} attempts (early-game, sparse data).`,
);
