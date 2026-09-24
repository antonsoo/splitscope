/**
 * Parses the .NET `TimeSpan` text format LiveSplit writes for every duration
 * in an `.lss` file, e.g. `"00:01:23.4560000"` or, for multi-day durations,
 * `"1.23:34:56.7890000"`.
 *
 * Ported from `parse_time_span` in LiveSplit's own parser
 * (`livesplit-core`, `src/run/parser/livesplit.rs`) — see `docs/format.md`
 * for the citation. Kept close to that logic on purpose: it is the reference
 * implementation, including which malformed strings it rejects.
 */
import { LssParseError } from "./errors.js";

const STANDARD_RE = /^(-)?(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/;
const INTEGER_RE = /^-?\d+$/;

function parseStandard(text: string): number {
  const m = STANDARD_RE.exec(text);
  if (!m) {
    throw new LssParseError(`Not a valid LiveSplit time span: "${text}"`);
  }
  const [, sign, hours, minutes, seconds, fraction] = m;
  const total =
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    (fraction ? Number(`0.${fraction}`) : 0);
  return sign ? -total : total;
}

/** Parses a required (non-empty) time span. Throws `LssParseError` on malformed input. */
export function parseTimeSpan(text: string): number {
  const dotIndex = text.indexOf(".");
  if (dotIndex !== -1) {
    const before = text.slice(0, dotIndex);
    const after = text.slice(dotIndex + 1);
    // A dot followed by something containing a colon means "days.hours:minutes:seconds[.fraction]".
    if (after.includes(":")) {
      if (!INTEGER_RE.test(before)) {
        throw new LssParseError(`Not a valid LiveSplit time span (bad day count): "${text}"`);
      }
      const days = Number(before);
      const time = parseStandard(after);
      if (time < 0) {
        throw new LssParseError(
          `Not a valid LiveSplit time span (negative time-of-day): "${text}"`,
        );
      }
      const magnitude = Math.abs(days) * 86400 + time;
      return days < 0 ? -magnitude : magnitude;
    }
  }
  return parseStandard(text);
}

/** Parses an optional time span: an empty/whitespace-only string means "not recorded" (`null`). */
export function parseOptionalTimeSpan(text: string | null | undefined): number | null {
  if (text == null) return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return parseTimeSpan(trimmed);
}

/** Formats seconds back into `HH:MM:SS.fff` for display (not round-trippable to LiveSplit's own precision). */
export function formatSeconds(seconds: number | null, fractionDigits = 2): string {
  if (seconds === null) return "—";
  const sign = seconds < 0 ? "-" : "";
  const abs = Math.abs(seconds);
  const hours = Math.floor(abs / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  const secs = abs % 60;
  const secsStr = secs.toFixed(fractionDigits).padStart(fractionDigits + 3, "0");
  if (hours > 0) {
    return `${sign}${hours}:${String(minutes).padStart(2, "0")}:${secsStr}`;
  }
  return `${sign}${minutes}:${secsStr}`;
}
