/** Sum of best as a shortest path through recorded split boundaries.
 * A combined time is one edge: it cannot be divided into invented segment golds.
 * See docs/sum-of-best.md for the upstream contract and independent replay.
 */
import type { ReviewSource } from "./review.js";
import { PERSONAL_BEST, pick, type Run, type TimingMethod } from "./types.js";

export type BestSource =
  | { readonly kind: "gold" }
  | { readonly kind: "personal-best"; readonly startSeconds: number; readonly endSeconds: number }
  | { readonly kind: "history"; readonly attemptId: number };

export interface BestLeg {
  /** Zero-based split boundaries: covers segments [from, to). */
  readonly from: number;
  readonly to: number;
  readonly seconds: number;
  readonly source: BestSource;
}

export interface BestRoute {
  readonly method: TimingMethod;
  /** Null when the recorded evidence cannot span the whole run. */
  readonly totalSeconds: number | null;
  /** The old arithmetic sum, only available when every segment has a gold. */
  readonly goldSumSeconds: number | null;
  readonly legs: readonly BestLeg[];
  /** Best cumulative time at each boundary; null means unreachable. */
  readonly boundaries: readonly (number | null)[];
}

const cache = new WeakMap<Run, Map<TimingMethod, BestRoute>>();

function faster(candidate: number, current: number): boolean {
  // Serialized .lss times have 100 ns precision. Subtracting cumulative PB
  // seconds can leave a tiny binary rounding residue against an equal gold.
  const rounding = 1e-8 + 4 * Number.EPSILON * Math.max(Math.abs(candidate), Math.abs(current));
  return candidate < current - rounding;
}

export function bestRoute(run: Run, method: TimingMethod): BestRoute {
  const cached = cache.get(run)?.get(method);
  if (cached) return cached;
  const n = run.segments.length;
  const outgoing: Map<number, BestLeg>[] = Array.from({ length: n }, () => new Map());
  const keep = (leg: BestLeg): void => {
    const edges = outgoing[leg.from];
    const old = edges?.get(leg.to);
    // Equal candidates keep the earlier source: gold, then lowest history ID,
    // then PB. One edge per boundary pair bounds retained duplicate evidence.
    if (!old || faster(leg.seconds, old.seconds)) edges?.set(leg.to, leg);
  };
  let goldSum: number | null = 0;
  run.segments.forEach((segment, i) => {
    const seconds = pick(segment.bestSegmentTime, method);
    if (seconds === null) goldSum = null;
    else {
      if (goldSum !== null) goldSum += seconds;
      keep({ from: i, to: i + 1, seconds, source: { kind: "gold" } });
    }
  });

  // A missing entry breaks a branch, while a present empty entry extends it.
  // Track only the latest empty chain per ID: O(history entries), with no
  // attempts-by-segments matrix or repeated searches down a skipped chain.
  const empty = new Map<number, { from: number; last: number }>();
  run.segments.forEach((segment, i) => {
    for (const entry of segment.history) {
      const chain = empty.get(entry.attemptId);
      const adjacent = chain?.last === i - 1;
      const seconds = pick(entry.time, method);
      if (seconds === null) {
        empty.set(entry.attemptId, { from: adjacent ? chain.from : i, last: i });
      } else {
        if (adjacent) {
          keep({
            from: chain.from,
            to: i + 1,
            seconds,
            source: { kind: "history", attemptId: entry.attemptId },
          });
        }
        empty.delete(entry.attemptId);
      }
    }
  });

  // Consecutive recorded PB splits define an indivisible duration, including
  // any empty comparison splits in between. Boundary zero starts at zero:
  // LiveSplit's stored first segment already includes the timer offset.
  let from = 0;
  let startSeconds = 0;
  run.segments.forEach((segment, i) => {
    const comparison = segment.splitTimes.get(PERSONAL_BEST);
    const endSeconds = comparison ? pick(comparison, method) : null;
    if (endSeconds !== null) {
      keep({
        from,
        to: i + 1,
        seconds: endSeconds - startSeconds,
        source: { kind: "personal-best", startSeconds, endSeconds },
      });
      from = i + 1;
      startSeconds = endSeconds;
    }
  });

  const boundaries: (number | null)[] = Array(n + 1).fill(null);
  const predecessors: (BestLeg | null)[] = Array(n + 1).fill(null);
  boundaries[0] = 0;
  for (let i = 0; i < n; i++) {
    const start = boundaries[i];
    if (start === null || start === undefined) continue;
    for (const leg of outgoing[i]?.values() ?? []) {
      const candidate = start + leg.seconds;
      const current = boundaries[leg.to];
      if (current === null || current === undefined || faster(candidate, current)) {
        boundaries[leg.to] = candidate;
        predecessors[leg.to] = leg;
      }
    }
  }
  const totalSeconds = n ? (boundaries[n] ?? null) : null;
  const legs: BestLeg[] = [];
  if (totalSeconds !== null) {
    let boundary = n;
    while (boundary > 0) {
      const leg = predecessors[boundary];
      if (!leg) throw new Error("Missing predecessor on a reachable best route.");
      legs.push(leg);
      boundary = leg.from;
    }
    legs.reverse();
  }
  const result: BestRoute = {
    method,
    totalSeconds,
    goldSumSeconds: n ? goldSum : null,
    legs,
    boundaries,
  };
  let methods = cache.get(run);
  if (!methods) {
    methods = new Map();
    cache.set(run, methods);
  }
  methods.set(method, result);
  return result;
}

export const BEST_ASSUMPTIONS = [
  "This is a hypothetical combination of recorded spans, not one completed attempt or a prediction of achievable pace.",
  "Golds, personal-best split differences and consecutive skipped-split history spans can contribute. Combined times stay together; their saving cannot be assigned to one segment.",
  "All saved segment history is eligible, including imported IDs absent from AttemptHistory. An ID alone does not establish a date or a completed attempt.",
  "Missing history entries break a combined span. Empty entries extend it. Real time and game time are calculated separately.",
  "The original stored times are used without repairing edited histories or removing suspicious records. A mistaken split can lower the result. The timer offset is already included in the stored first-segment time.",
  "One minimum route is shown. Equally fast routes may use different records. No active, unfinished timer attempt is included.",
] as const;

/** Exact values and positions for one leg, retaining both timing methods.
 * Positions are zero-based in data and shown one-based in the interface.
 */
export function bestLegEvidence(run: Run, leg: BestLeg) {
  if (leg.source.kind === "gold") {
    return [
      {
        segmentIndex: leg.from,
        field: "BestSegmentTime",
        attemptId: null,
        time: run.segments[leg.from]?.bestSegmentTime ?? null,
      },
    ];
  }
  if (leg.source.kind === "personal-best") {
    const first = Math.max(0, leg.from - 1);
    return run.segments.slice(first, leg.to).map((segment, index) => ({
      segmentIndex: first + index,
      field: "SplitTimes/Personal Best",
      attemptId: null,
      time: segment.splitTimes.get(PERSONAL_BEST) ?? null,
    }));
  }
  const id = leg.source.attemptId;
  return run.segments.slice(leg.from, leg.to).map((segment, index) => ({
    segmentIndex: leg.from + index,
    field: "SegmentHistory",
    attemptId: id,
    time: segment.history.find((entry) => entry.attemptId === id)?.time ?? null,
  }));
}

export function buildBestExport(run: Run, method: TimingMethod, source: ReviewSource) {
  const route = bestRoute(run, method);
  return {
    schemaVersion: 1,
    source,
    run: {
      gameName: run.gameName,
      categoryName: run.categoryName,
      formatVersion: run.formatVersion,
      offset: run.offset,
    },
    assumptions: BEST_ASSUMPTIONS,
    route,
    evidence: route.legs.map((leg) => ({ leg, records: bestLegEvidence(run, leg) })),
    // Complete sparse input to the calculation lets another implementation replay
    // the optimum, rather than merely check arithmetic along the selected route.
    segments: run.segments.map((segment, segmentIndex) => ({
      segmentIndex,
      name: segment.name,
      label: segment.label,
      bestSegmentTime: segment.bestSegmentTime,
      personalBest: segment.splitTimes.get(PERSONAL_BEST) ?? null,
      history: segment.history,
    })),
  };
}
