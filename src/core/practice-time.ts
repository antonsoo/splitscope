import { type AttemptClock, attemptClocks, type ClockStatus } from "./attempt-clock.js";
import type { AttemptReview, PracticeCohort, PracticeComparison } from "./review.js";
import type { Run } from "./types.js";

export interface TimeBudget {
  readonly attempts: number;
  readonly timedAttempts: number;
  /** Null when no timestamps can establish an elapsed duration, including empty groups. */
  readonly elapsedSeconds: number | null;
  readonly sumStatus: "available" | "unavailable" | "out-of-range";
  readonly unavailable: Readonly<Record<Exclude<ClockStatus, "recorded">, number>>;
  readonly unsynchronizedAttempts: number;
  readonly overlappingAttempts: number;
}

export interface PracticeTimeGroup {
  readonly total: TimeBudget;
  readonly completed: TimeBudget;
  readonly inferredResets: TimeBudget;
  readonly unknown: TimeBudget;
  readonly byResetSegment: readonly TimeBudget[];
  readonly clocks: readonly AttemptClock[];
}

function budget(
  rows: readonly AttemptReview[],
  clocks: ReadonlyMap<number, AttemptClock>,
): TimeBudget {
  let timedAttempts = 0;
  let seconds = 0n;
  let unsynchronizedAttempts = 0;
  let overlappingAttempts = 0;
  const unavailable = { missing: 0, invalid: 0, reversed: 0 };
  for (const row of rows) {
    const value = clocks.get(row.attempt.id);
    if (!value) throw new RangeError("Practice attempts must belong to this run.");
    if (value.status !== "recorded") unavailable[value.status]++;
    else {
      timedAttempts++;
      seconds += BigInt(value.elapsedSeconds as number);
      if (!value.synchronized) unsynchronizedAttempts++;
      if (value.overlap !== null) overlappingAttempts++;
    }
  }
  return {
    attempts: rows.length,
    timedAttempts,
    elapsedSeconds:
      timedAttempts && seconds <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(seconds) : null,
    sumStatus: !timedAttempts
      ? "unavailable"
      : seconds > BigInt(Number.MAX_SAFE_INTEGER)
        ? "out-of-range"
        : "available",
    unavailable,
    unsynchronizedAttempts,
    overlappingAttempts,
  };
}

function group(run: Run, cohort: PracticeCohort): PracticeTimeGroup {
  const clocks = attemptClocks(run);
  const completed: AttemptReview[] = [];
  const resets: AttemptReview[] = [];
  const unknown: AttemptReview[] = [];
  const segments: AttemptReview[][] = run.segments.map(() => []);
  for (const row of cohort.attempts) {
    if (row.outcome === "completed") completed.push(row);
    else if (row.inferredResetSegment !== null) {
      resets.push(row);
      segments[row.inferredResetSegment]?.push(row);
    } else unknown.push(row);
  }
  return {
    total: budget(cohort.attempts, clocks),
    completed: budget(completed, clocks),
    inferredResets: budget(resets, clocks),
    unknown: budget(unknown, clocks),
    byResetSegment: segments.map((rows) => budget(rows, clocks)),
    clocks: cohort.attempts.map((row) => clocks.get(row.attempt.id) as AttemptClock),
  };
}

/** Whole-attempt timestamp durations partitioned by observed/inferred outcome. */
export function comparePracticeTime(run: Run, comparison: PracticeComparison) {
  return { previous: group(run, comparison.previous), recent: group(run, comparison.recent) };
}
