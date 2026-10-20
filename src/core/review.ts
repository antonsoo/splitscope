/** Observed practice cohorts and their original attempt/segment evidence. No forecasting. */
import { comparePracticeTime } from "./practice-time.js";
import { furthestSegmentIndex, hasCompletionTime, pbSegmentDuration } from "./stats.js";
import { type Attempt, type DualTime, pick, type Run, type TimingMethod } from "./types.js";

export type AttemptOutcome = "completed" | "inferred-reset" | "unknown";
export type CohortSide = "recent" | "previous";

export interface AttemptReview {
  readonly attempt: Attempt;
  /** One-based position in the recorded history, not the attempt's possibly sparse ID. */
  readonly ordinal: number;
  readonly outcome: AttemptOutcome;
  readonly lastRecordedSegment: number | null;
  readonly inferredResetSegment: number | null;
}

const reviews = new WeakMap<Run, readonly AttemptReview[]>();

export function reviewAttempts(run: Run): readonly AttemptReview[] {
  let cached = reviews.get(run);
  if (!cached) {
    cached = run.attempts.map((attempt, index) => {
      const last = furthestSegmentIndex(run, attempt.id);
      const completed = hasCompletionTime(attempt);
      const canLocateReset = !completed && last < run.segments.length - 1;
      return {
        attempt,
        ordinal: index + 1,
        outcome: completed ? "completed" : canLocateReset ? "inferred-reset" : "unknown",
        lastRecordedSegment: last < 0 ? null : last,
        inferredResetSegment: canLocateReset ? last + 1 : null,
      };
    });
    reviews.set(run, cached);
  }
  return cached;
}

export interface CohortSegment {
  readonly started: number;
  readonly resets: number;
  /** Resets / attempts inferred to have started this segment, not / all attempts. */
  readonly resetRate: number | null;
}

export interface PracticeCohort {
  readonly attempts: readonly AttemptReview[];
  readonly completed: number;
  readonly inferredResets: number;
  readonly unknown: number;
  readonly timedCompletions: number;
  readonly bestCompletion: number | null;
  readonly medianCompletion: number | null;
  readonly segments: readonly CohortSegment[];
}

export interface PracticeComparison {
  readonly method: TimingMethod;
  readonly window: number;
  readonly endOrdinal: number;
  readonly recent: PracticeCohort;
  readonly previous: PracticeCohort;
}

function cohort(
  attempts: readonly AttemptReview[],
  segmentCount: number,
  method: TimingMethod,
): PracticeCohort {
  // Each attempt contributes to a prefix of reached segments. A histogram plus
  // a reverse sum avoids rescanning all attempts once per segment.
  const ends = Array<number>(segmentCount).fill(0);
  const resets = Array<number>(segmentCount).fill(0);
  const times: number[] = [];
  let completed = 0;
  let inferredResets = 0;
  let unknown = 0;
  for (const row of attempts) {
    const furthestStarted = row.inferredResetSegment ?? segmentCount - 1;
    if (furthestStarted >= 0) ends[furthestStarted] = (ends[furthestStarted] ?? 0) + 1;
    if (row.outcome === "completed") {
      completed++;
      const time = pick(row.attempt.time, method);
      if (time !== null) times.push(time);
    } else if (row.inferredResetSegment !== null) {
      inferredResets++;
      resets[row.inferredResetSegment] = (resets[row.inferredResetSegment] ?? 0) + 1;
    } else unknown++;
  }
  times.sort((a, b) => a - b);
  let started = 0;
  const segments: CohortSegment[] = Array(segmentCount);
  for (let i = segmentCount - 1; i >= 0; i--) {
    started += ends[i] ?? 0;
    const deaths = resets[i] ?? 0;
    segments[i] = { started, resets: deaths, resetRate: started ? deaths / started : null };
  }
  const middle = Math.floor(times.length / 2);
  return {
    attempts,
    completed,
    inferredResets,
    unknown,
    timedCompletions: times.length,
    bestCompletion: times[0] ?? null,
    medianCompletion: times.length
      ? times.length % 2
        ? (times[middle] as number)
        : (times[middle - 1] as number) / 2 + (times[middle] as number) / 2
      : null,
    segments,
  };
}

/** Two disjoint groups in recorded ID order; a short preceding group stays short. */
export function comparePractice(
  run: Run,
  method: TimingMethod,
  window: number,
  endOrdinal = run.attempts.length,
): PracticeComparison {
  if (!Number.isSafeInteger(window) || window < 1)
    throw new RangeError("Practice window must be a positive whole number.");
  if (!Number.isSafeInteger(endOrdinal) || endOrdinal < 0 || endOrdinal > run.attempts.length)
    throw new RangeError("Practice endpoint must be a position in the recorded attempt history.");
  const all = reviewAttempts(run);
  const start = Math.max(0, endOrdinal - window);
  return {
    method,
    window,
    endOrdinal,
    recent: cohort(all.slice(start, endOrdinal), run.segments.length, method),
    previous: cohort(all.slice(Math.max(0, start - window), start), run.segments.length, method),
  };
}

export interface AttemptFilter {
  readonly outcome: AttemptOutcome | "all";
  /** When set, only attempts whose inferred reset is at this segment are returned. */
  readonly resetSegment: number | null;
}

export function filterAttempts(cohort: PracticeCohort, filter: AttemptFilter): AttemptReview[] {
  return cohort.attempts.filter(
    (row) =>
      (filter.outcome === "all" || row.outcome === filter.outcome) &&
      (filter.resetSegment === null || row.inferredResetSegment === filter.resetSegment),
  );
}

export type SegmentRecordKind = "timed" | "combined" | "untimed" | "missing";

export interface SegmentReview {
  readonly segmentIndex: number;
  /** Null means no Time entry; an object with null fields means an entry with no time. */
  readonly recordedTime: DualTime | null;
  readonly kind: SegmentRecordKind;
  readonly seconds: number | null;
  /** First segment covered by a combined duration, inferred from consecutive empty entries. */
  readonly combinedFrom: number | null;
  /** Never compare a combined duration to one segment's PB duration. */
  readonly deltaToCurrentPb: number | null;
}

function historyTime(run: Run, segmentIndex: number, attemptId: number): DualTime | null {
  const history = run.segments[segmentIndex]?.history ?? [];
  let lo = 0;
  let hi = history.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const entry = history[mid];
    if (entry && entry.attemptId < attemptId) lo = mid + 1;
    else hi = mid;
  }
  const entry = history[lo];
  return entry?.attemptId === attemptId ? entry.time : null;
}

/** Inspect one attempt without materializing a dense attempts-by-segments matrix. */
export function inspectAttempt(run: Run, attemptId: number, method: TimingMethod): SegmentReview[] {
  if (!run.attempts.some((a) => a.id === attemptId))
    throw new RangeError("That ID is not in the recorded attempt history.");
  let emptyFrom: number | null = null;
  return run.segments.map((_segment, segmentIndex) => {
    const recordedTime = historyTime(run, segmentIndex, attemptId);
    const seconds = recordedTime === null ? null : pick(recordedTime, method);
    const combinedFrom = seconds !== null ? emptyFrom : null;
    const kind: SegmentRecordKind =
      recordedTime === null
        ? "missing"
        : seconds === null
          ? "untimed"
          : combinedFrom === null
            ? "timed"
            : "combined";
    if (recordedTime === null || seconds !== null) emptyFrom = null;
    else if (emptyFrom === null) emptyFrom = segmentIndex;
    const pb = pbSegmentDuration(run, segmentIndex, method);
    return {
      segmentIndex,
      recordedTime,
      kind,
      seconds,
      combinedFrom,
      deltaToCurrentPb: kind === "timed" && pb !== null && seconds !== null ? seconds - pb : null,
    };
  });
}

export interface ReviewSource {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
  /** Known for bundled examples; null for uploads whose origin has not been established. */
  readonly synthetic: boolean | null;
}

export const REVIEW_ASSUMPTIONS = [
  "Cohorts use recorded attempt ID order, not elapsed calendar time. Missing IDs and the file's AttemptCount are not additional observations.",
  "An overall time in either timing method establishes completion. Completion statistics use only totals present in the selected timing method.",
  "Without an overall time, a reset is inferred after the last segment-history entry. Deleted histories or changes to the split layout can invalidate that location.",
  "Final-segment history without an overall time has an unknown outcome. Unknown outcomes remain in reached counts but are never assigned a reset.",
  "An empty entry is not zero. A time following consecutive empty entries covers those segments together. Missing entries do not establish a skipped split.",
  "Elapsed time is the sum of saved end-minus-start timestamps for those attempts, including pauses and earlier segments. It is not time spent only at the reset segment. Gaps between attempts are excluded.",
  "Timestamp precision is one second. Missing, invalid and reversed timestamps remain unavailable; timer totals and segment sums do not fill them. An absent PauseTime does not establish zero pause time.",
  "Unsynchronized clocks and overlapping recorded intervals are flagged. Elapsed totals sum attempt durations; they are not a union of occupied calendar time or a measure of active play.",
  "These are observed counts, not a skill estimate or a test of improvement. Reset choices, routes and recording practices can differ between groups.",
] as const;

export function buildPracticeExport(
  run: Run,
  comparison: PracticeComparison,
  source: ReviewSource,
) {
  const ids = new Set(
    [...comparison.previous.attempts, ...comparison.recent.attempts].map((row) => row.attempt.id),
  );
  return {
    schemaVersion: 2,
    source,
    run: {
      gameName: run.gameName,
      categoryName: run.categoryName,
      formatVersion: run.formatVersion,
      offset: run.offset,
      attemptCount: run.attemptCount,
      recordedAttempts: run.attempts.length,
    },
    assumptions: REVIEW_ASSUMPTIONS,
    comparison,
    timeBudget: comparePracticeTime(run, comparison),
    // Sparse original records: absent entries stay absent and imported history
    // outside these attempt cohorts is not presented as observed practice.
    segments: run.segments.map((segment, segmentIndex) => ({
      segmentIndex,
      name: segment.name,
      label: segment.label,
      personalBest: segment.splitTimes.get("Personal Best") ?? null,
      bestSegmentTime: segment.bestSegmentTime,
      history: segment.history.filter((entry) => ids.has(entry.attemptId)),
    })),
  };
}
