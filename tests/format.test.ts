import { describe, expect, it } from "vitest";
import { formatCount, formatDelta, formatHours, formatPercent } from "../src/ui/format.js";

describe("formatDelta", () => {
  it("prefixes a positive delta with +", () => {
    expect(formatDelta(5.5)).toBe("+0:05.50");
  });

  it("prefixes a negative delta with a minus sign, not a double sign", () => {
    expect(formatDelta(-5.5)).toBe("−0:05.50");
  });

  it("renders exactly zero with no sign", () => {
    expect(formatDelta(0)).toBe("0:00.00");
  });

  it("renders null as an em dash", () => {
    expect(formatDelta(null)).toBe("—");
  });
});

describe("formatPercent", () => {
  it("formats a fraction as a percentage at the given precision", () => {
    expect(formatPercent(0.2222, 1)).toBe("22.2%");
    expect(formatPercent(1, 0)).toBe("100%");
    expect(formatPercent(0, 2)).toBe("0.00%");
  });

  it("treats null and NaN as unknown, not zero", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(Number.NaN)).toBe("—");
  });
});

describe("formatCount", () => {
  it("adds thousands separators", () => {
    expect(formatCount(8000)).toBe("8,000");
    expect(formatCount(220)).toBe("220");
  });
});

describe("formatHours", () => {
  it("converts seconds to hours at one decimal place", () => {
    expect(formatHours(3600)).toBe("1.0h");
    expect(formatHours(45240)).toBe("12.6h");
  });
});
