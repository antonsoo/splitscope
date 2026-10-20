import type { Attempt, Run } from "./types.js";

/** Saved LiveSplit timestamps have whole-second precision and use UTC. */
export function parseLiveSplitTimestamp(text: string): number | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [, month, day, year, hour, minute, second] = m;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  date.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  if (
    Number(year) < 1 ||
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Number(second)
  )
    return null;
  return date.getTime();
}

export type ClockStatus = "recorded" | "missing" | "invalid" | "reversed";

export interface AttemptClock {
  readonly attemptId: number;
  readonly status: ClockStatus;
  /** End minus start as saved, including pauses. Never substituted with a timer total. */
  readonly elapsedSeconds: number | null;
  readonly synchronized: boolean;
  /** One original interval witnessing overlap; it may be outside the selected groups. */
  readonly overlap: {
    readonly attemptId: number;
    readonly started: string;
    readonly ended: string;
  } | null;
}

function clock(attempt: Attempt): AttemptClock {
  const started = attempt.started === null ? null : parseLiveSplitTimestamp(attempt.started);
  const ended = attempt.ended === null ? null : parseLiveSplitTimestamp(attempt.ended);
  const status: ClockStatus =
    attempt.started === null || attempt.ended === null
      ? "missing"
      : started === null || ended === null
        ? "invalid"
        : ended < started
          ? "reversed"
          : "recorded";
  return {
    attemptId: attempt.id,
    status,
    elapsedSeconds:
      status === "recorded" && started !== null && ended !== null ? (ended - started) / 1000 : null,
    synchronized: attempt.isStartedSynced && attempt.isEndedSynced,
    overlap: null,
  };
}

const cache = new WeakMap<Run, ReadonlyMap<number, AttemptClock>>();

/** Index once per run. Overlap witnesses use the entire recorded history. */
export function attemptClocks(run: Run): ReadonlyMap<number, AttemptClock> {
  const cached = cache.get(run);
  if (cached) return cached;
  const clocks = new Map(run.attempts.map((attempt) => [attempt.id, clock(attempt)]));
  const intervals = run.attempts
    .flatMap((attempt) => {
      const value = clocks.get(attempt.id);
      if (!value || value.elapsedSeconds === null || value.elapsedSeconds === 0) return [];
      return [
        {
          attempt,
          start: parseLiveSplitTimestamp(attempt.started as string) as number,
          end: parseLiveSplitTimestamp(attempt.ended as string) as number,
        },
      ];
    })
    .sort((a, b) => a.start - b.start || a.attempt.id - b.attempt.id);
  let longest: (typeof intervals)[number] | null = null;
  function mark(a: (typeof intervals)[number], b: (typeof intervals)[number]): void {
    const value = clocks.get(a.attempt.id);
    if (value && value.overlap === null)
      clocks.set(a.attempt.id, {
        ...value,
        overlap: {
          attemptId: b.attempt.id,
          started: b.attempt.started as string,
          ended: b.attempt.ended as string,
        },
      });
  }
  for (const interval of intervals) {
    if (longest && interval.start < longest.end) {
      mark(interval, longest);
      mark(longest, interval);
    }
    if (!longest || interval.end > longest.end) longest = interval;
  }
  cache.set(run, clocks);
  return clocks;
}
