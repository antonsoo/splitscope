import { describe, expect, it } from "vitest";
import { displayPoints, extent, histogram } from "../src/ui/charts/large-series.js";

describe("large-history displays", () => {
  it("finds extrema beyond the engine's function-argument limit", () => {
    const values = Array<number>(200_000).fill(10);
    values[100_001] = -50;
    values[199_998] = 300;
    expect(extent(values)).toEqual([-50, 300]);
  });

  it("retains an isolated fast run and slow stall, in their original order", () => {
    const points = Array.from({ length: 140_000 }, (_, x) => ({ x, y: 10 }));
    points[10_000] = { x: 10_000, y: -100 };
    points[139_998] = { x: 139_998, y: 1000 };
    const selected = displayPoints(
      points,
      (p) => p.x,
      (p) => p.y,
      1,
    );
    expect(selected.map((p) => p.x)).toEqual([0, 10_000, 139_998, 139_999]);
    expect(selected.every((p) => p === points[p.x])).toBe(true);
    expect(points).toHaveLength(140_000);
  });

  it("preserves gaps in attempt positions instead of spreading them evenly", () => {
    const points = Array.from({ length: 100 }, (_, i) => ({ x: i < 50 ? i : i + 950, y: i }));
    expect(
      displayPoints(
        points,
        (p) => p.x,
        (p) => p.y,
        2,
      ).map((p) => p.x),
    ).toEqual([0, 49, 1000, 1049]);
    expect(
      displayPoints(
        points.slice(0, 4),
        (p) => p.x,
        (p) => p.y,
        2,
      ),
    ).toEqual(points.slice(0, 4));
  });

  it("counts every timing once, including both endpoints and exact bin boundaries", () => {
    expect(histogram([0, 1, 2, 3, 4], 0, 4, 4)).toEqual([1, 1, 1, 2]);
    const values = Array.from({ length: 140_000 }, (_, i) => i % 10);
    expect(histogram(values, 0, 10, 10)).toEqual(Array(10).fill(14_000));
    expect(histogram(values, -1, 11, 64).reduce((sum, n) => sum + n, 0)).toBe(140_000);
  });
});
