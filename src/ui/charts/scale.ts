/** A minimal linear scale, in the spirit of d3-scale but with no dependency. */
export function scaleLinear(domain: readonly [number, number], range: readonly [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  return (value: number): number => {
    if (span === 0) return r0;
    return r0 + ((value - d0) / span) * (r1 - r0);
  };
}

/** Expands a domain by a small margin so extreme points aren't drawn exactly on the chart edge. */
export function niceDomain(min: number, max: number, marginFraction = 0.08): [number, number] {
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    return [min - pad, max + pad];
  }
  const span = max - min;
  return [min - span * marginFraction, max + span * marginFraction];
}
