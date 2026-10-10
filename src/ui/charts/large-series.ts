/** Extrema without spreading a file-sized array into function arguments. */
export function extent(values: readonly number[]): [number, number] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  return [lo, hi];
}

/**
 * Retain first, last, minimum and maximum in each horizontal display column.
 * The caller keeps full data for domains and statistics and labels this reduction.
 * Input must be ordered by x; returned points retain that order, including spikes.
 */
export function displayPoints<T>(
  points: readonly T[],
  x: (point: T) => number,
  y: (point: T) => number,
  columns: number,
): readonly T[] {
  if (!Number.isSafeInteger(columns) || columns < 1)
    throw new RangeError("Display columns must be a positive safe integer.");
  if (points.length <= columns * 4) return points;
  const first = x(points[0] as T);
  const span = x(points[points.length - 1] as T) - first;
  const selected: T[] = [];
  let column = -1;
  let start = 0;
  let min = 0;
  let max = 0;
  const flush = (end: number): void => {
    const indices = [...new Set([start, min, max, end])].sort((a, b) => a - b);
    for (const i of indices) selected.push(points[i] as T);
  };
  for (let i = 0; i < points.length; i++) {
    const next =
      span > 0
        ? Math.min(columns - 1, Math.floor(((x(points[i] as T) - first) / span) * columns))
        : 0;
    if (next !== column) {
      if (column !== -1) flush(i - 1);
      column = next;
      start = min = max = i;
    } else {
      if (y(points[i] as T) < y(points[min] as T)) min = i;
      if (y(points[i] as T) > y(points[max] as T)) max = i;
    }
  }
  flush(points.length - 1);
  return selected;
}

/** All observations contribute to exactly one equal-width bin, including the upper endpoint. */
export function histogram(
  values: readonly number[],
  lo: number,
  hi: number,
  bins: number,
): number[] {
  if (
    !Number.isSafeInteger(bins) ||
    bins < 1 ||
    !Number.isFinite(lo) ||
    !Number.isFinite(hi) ||
    hi <= lo
  )
    throw new RangeError("Histogram requires finite increasing bounds and a positive bin count.");
  const counts = Array<number>(bins).fill(0);
  for (const value of values) {
    const bin = Math.max(0, Math.min(bins - 1, Math.floor(((value - lo) / (hi - lo)) * bins)));
    counts[bin] = (counts[bin] ?? 0) + 1;
  }
  return counts;
}
