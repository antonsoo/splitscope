/**
 * Core domain types for a parsed LiveSplit run.
 *
 * These mirror the structures documented in `docs/format.md`, translated from
 * .NET `TimeSpan` durations into plain seconds (a `number`) so the rest of the
 * library never has to think about the XML's string encoding again. `null`
 * always means "LiveSplit recorded no value here" (an empty element), which is
 * different from `0` (a genuine zero-second time).
 */

/** Which of LiveSplit's two timing methods to analyze. */
export type TimingMethod = "RealTime" | "GameTime";

/** A time recorded in both timing methods; either may be absent. */
export interface DualTime {
  readonly realTime: number | null;
  readonly gameTime: number | null;
}

/** One completed-or-reset attempt, from `<AttemptHistory>`. */
export interface Attempt {
  readonly id: number;
  readonly started: string | null;
  readonly isStartedSynced: boolean;
  readonly ended: string | null;
  readonly isEndedSynced: boolean;
  readonly pauseTime: number | null;
  readonly time: DualTime;
}

/** One entry in a segment's `<SegmentHistory>`: the segment's own duration on one attempt. */
export interface SegmentHistoryEntry {
  readonly attemptId: number;
  readonly time: DualTime;
}

/** One segment, combining its comparison times, gold, and per-attempt history. */
export interface Segment {
  readonly name: string;
  /** Cumulative (from run start) times for each named comparison, e.g. "Personal Best". */
  readonly splitTimes: ReadonlyMap<string, DualTime>;
  /** The best (gold) duration ever recorded for this segment alone. */
  readonly bestSegmentTime: DualTime;
  /** Per-attempt segment durations, in ascending attempt-id order. */
  readonly history: readonly SegmentHistoryEntry[];
}

/** A fully parsed LiveSplit run. */
export interface Run {
  readonly gameName: string;
  readonly categoryName: string;
  /** Format version declared on the `<Run version="...">` element ("1.0.0.0" if absent). */
  readonly formatVersion: string;
  /** Fixed offset (seconds) applied to the displayed timer, e.g. for negative-time starts. */
  readonly offset: number;
  readonly attemptCount: number;
  readonly attempts: readonly Attempt[];
  readonly segments: readonly Segment[];
}

/** The comparison name LiveSplit uses for the personal best. */
export const PERSONAL_BEST = "Personal Best";

/** Reads a `DualTime` for the configured timing method. */
export function pick(time: DualTime, method: TimingMethod): number | null {
  return method === "RealTime" ? time.realTime : time.gameTime;
}
