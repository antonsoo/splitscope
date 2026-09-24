/**
 * Generates synthetic `.lss` sample files for a fictional game, "Crystal
 * Caverns — Any%". There is no such game; every number in these files is
 * simulated by this script, not recorded from a real run. `docs/format.md`
 * and the README say so, and the in-app "Load sample" button labels it
 * "synthetic" too — this is sample data for trying the tool, never a claim
 * about a real speedrun.
 *
 * The simulation is a simple random walk with a learning curve, run once
 * with a fixed seed so the output is reproducible:
 *   - Per-segment mean time decays toward a skill floor as attempts progress
 *     (`mean(t) = floor + (base - floor) * decay^t`), and its standard
 *     deviation shrinks the same way (a runner gets both faster and more
 *     consistent with practice).
 *   - A per-segment, decaying reset hazard: early attempts die on hard
 *     segments a lot; later attempts rarely do.
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

const SEGMENTS: readonly SegmentSpec[] = [
  {
    name: "Cave Entrance",
    baseMean: 42,
    floorMean: 33,
    baseSd: 5,
    floorSd: 1.2,
    baseHazard: 0.03,
    floorHazard: 0.005,
  },
  {
    name: "Crystal Lake",
    baseMean: 78,
    floorMean: 61,
    baseSd: 9,
    floorSd: 2.5,
    baseHazard: 0.12,
    floorHazard: 0.02,
  },
  {
    name: "Underground Falls",
    baseMean: 65,
    floorMean: 50,
    baseSd: 8,
    floorSd: 2.0,
    baseHazard: 0.18,
    floorHazard: 0.03,
  },
  {
    name: "Boss Room",
    baseMean: 95,
    floorMean: 70,
    baseSd: 12,
    floorSd: 3.5,
    baseHazard: 0.28,
    floorHazard: 0.06,
  },
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

const veteran = simulate(220, 1337, 0.65);
writeFileSync(
  join(outDir, "crystal-caverns-any.lss"),
  buildLss("Crystal Caverns", "Any% (synthetic sample data)", veteran),
);

const freshStart = simulate(9, 2026, 0);
writeFileSync(
  join(outDir, "crystal-caverns-fresh-start.lss"),
  buildLss("Crystal Caverns", "Any% — fresh splits (synthetic sample data)", freshStart),
);

const finishedCount = veteran.filter((a) => a.finished).length;
console.log(
  `Wrote examples/crystal-caverns-any.lss: ${veteran.length} attempts, ${finishedCount} finishes.`,
);
console.log(
  `Wrote examples/crystal-caverns-fresh-start.lss: ${freshStart.length} attempts (early-game, sparse data).`,
);
