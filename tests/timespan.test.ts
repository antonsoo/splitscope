import { describe, expect, it } from "vitest";
import { formatSeconds, parseOptionalTimeSpan, parseTimeSpan } from "../src/core/timespan.js";

describe("parseTimeSpan", () => {
  it("parses the brief's canonical format", () => {
    expect(parseTimeSpan("00:01:23.4560000")).toBeCloseTo(83.456, 6);
  });

  it("parses hours, minutes, seconds with no fraction", () => {
    expect(parseTimeSpan("1:02:03")).toBe(3723);
  });

  it("parses a negative standard time span", () => {
    expect(parseTimeSpan("-00:00:05.5000000")).toBeCloseTo(-5.5, 6);
  });

  // These two cases are lifted directly from livesplit-core's own unit test
  // (`time_span_parsing` in livesplit.rs) so the port is checked against the
  // reference implementation's exact expected values, not just plausible-looking ones.
  it("parses the reference extended (multi-day) case", () => {
    // 1 day + 23:34:56.789 = 86400 + 84896.789 = 171296.789
    expect(parseTimeSpan("1.23:34:56.789")).toBeCloseTo(171296.789, 3);
  });

  it("parses the reference negative extended case", () => {
    expect(parseTimeSpan("-1.23:34:56.789")).toBeCloseTo(-171296.789, 3);
  });

  it.each([
    "-1.-23:34:56.789",
    "1.-23:34:56.789",
    "-123.45.23:34:56.789",
    "NaN.23:34:56.789",
    "Inf.23:34:56.789",
    "not a time",
    "12:34", // missing seconds component
  ])("rejects malformed input %s", (text) => {
    expect(() => parseTimeSpan(text)).toThrow();
  });
});

describe("parseOptionalTimeSpan", () => {
  it("treats empty and whitespace-only text as null", () => {
    expect(parseOptionalTimeSpan("")).toBeNull();
    expect(parseOptionalTimeSpan("   ")).toBeNull();
    expect(parseOptionalTimeSpan(undefined)).toBeNull();
    expect(parseOptionalTimeSpan(null)).toBeNull();
  });

  it("parses non-empty text", () => {
    expect(parseOptionalTimeSpan("00:00:01.0000000")).toBeCloseTo(1, 6);
  });
});

describe("formatSeconds", () => {
  it("formats sub-hour durations without a leading hour component", () => {
    expect(formatSeconds(83.456)).toBe("1:23.46");
  });

  it("formats hour-scale durations", () => {
    expect(formatSeconds(3723.1)).toBe("1:02:03.10");
  });

  it("renders a null time as an em dash", () => {
    expect(formatSeconds(null)).toBe("—");
  });

  it("formats negative durations with a leading sign", () => {
    expect(formatSeconds(-5.5)).toBe("-0:05.50");
  });
});
