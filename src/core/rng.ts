/**
 * A small, seeded pseudo-random number generator (mulberry32).
 *
 * The Monte Carlo simulator is built on this instead of `Math.random()` so
 * the core library stays pure and deterministic — the same run and seed
 * always produce the same simulated odds. That's what makes it testable
 * against a closed-form oracle (see `tests/montecarlo.test.ts`), and it's
 * also why the PB-odds panel doesn't flicker as its sliders move: the seed
 * is derived from the run's own identity (`seedFromString`, below), not
 * from the slider values, so dragging "recent form" or "simulations"
 * changes the estimate without the displayed numbers jittering from a
 * fresh random seed on every render.
 *
 * Reference: mulberry32, a public-domain 32-bit generator by Tommy Ettinger,
 * widely used for exactly this purpose (small, fast, decent statistical
 * quality, no dependency). https://gist.github.com/tommyettinger/46a874533244883189143505d203312
 */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministically derives a 32-bit seed from a string, so a run's identity can seed its own sim. */
export function seedFromString(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
