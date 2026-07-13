/** Deterministic PRNG (mulberry32) so bootstrap resampling is reproducible
 * across runs given the same seed — required for a reproducible, testable
 * scorecard (spec §14). Not cryptographic; a fast, well-distributed
 * generator is all that's needed for resampling. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bootstrap 95% CI over `values` via resampling-with-replacement (spec
 * §14) — 1000 resamples by default, since categories only have 15-25 items
 * and every reported recall/precision needs an honesty check against
 * small-n noise. `seed` makes the output deterministic for the same input,
 * so scorecards are reproducible and this function is unit-testable.
 * Returns [0, 0] for no data, [value, value] for a single point (nothing to
 * resample). */
export function bootstrapCI(values: number[], resamples = 1000, seed = 42): [number, number] {
  if (values.length === 0) return [0, 0];
  if (values.length === 1) return [values[0], values[0]];

  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) {
      const idx = Math.floor(rand() * values.length);
      sum += values[idx];
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);

  const lowIdx = Math.floor(0.025 * resamples);
  const highIdx = Math.min(resamples - 1, Math.floor(0.975 * resamples));
  return [means[lowIdx], means[highIdx]];
}
