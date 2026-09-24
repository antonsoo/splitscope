import { describe, expect, it } from "vitest";
import { resolveTolerance } from "../src/ui/sections/segmentTable.js";

describe("resolveTolerance", () => {
  it("defaults to 8% of gold when no override is set", () => {
    expect(resolveTolerance(null, 50)).toBeCloseTo(4, 6);
    expect(resolveTolerance(null, 100)).toBeCloseTo(8, 6);
  });

  it("floors the relative default at 1 second for short segments", () => {
    // 8% of a 5s segment is 0.4s, which would make "near gold" tighter than any
    // realistic run-to-run wobble — floored at 1s instead.
    expect(resolveTolerance(null, 5)).toBe(1);
  });

  it("falls back to the 1s floor when gold is unknown", () => {
    expect(resolveTolerance(null, null)).toBe(1);
  });

  it("an explicit override always wins, regardless of gold", () => {
    expect(resolveTolerance(2.5, 100)).toBe(2.5);
    expect(resolveTolerance(0, 100)).toBe(0);
    expect(resolveTolerance(2.5, null)).toBe(2.5);
  });
});
