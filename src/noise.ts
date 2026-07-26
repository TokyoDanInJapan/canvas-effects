// Noise, shared by the backgrounds.
//
// An integer hash, value noise built on that hash, and fractal Brownian motion
// built on that noise. All three are standard constructions.
//
// It lives on its own because two unrelated things need it: the plasma warp
// folds fbm into itself, and the smoke uses it both for the field it feeds from
// and for the stirring that keeps the fluid from settling. It used to sit in
// `plasma-warp.ts` and be imported out of there, which was fine while the
// plasma was the only background and misleading the moment it was not.

/**
 * Integer hash to a number in `[0, 1)`.
 *
 * The usual `sin(dot(p, k)) * 43758.5453` trick is avoided deliberately: it is
 * a transcendental call per lattice corner, and it repeats visibly at some
 * coordinates. Integer mixing is both faster and better behaved. `Math.imul`
 * keeps the multiplies in 32-bit, which is what makes the avalanche work.
 *
 * The two finalising multipliers are MurmurHash3's, which Austin Appleby placed
 * in the public domain; `0x9e3779b1` is the 32-bit golden-ratio constant used
 * as a mixer all over the place.
 */
export function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Value noise: hash the lattice corners and interpolate with a smoothstep.
 *
 * Value rather than gradient noise because the output is quantised to five
 * greys and drawn in 6px cells - gradient noise costs more and nothing
 * downstream could show the difference.
 */
export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;

  // Smoothstep, so the lattice does not show up as a grid of creases.
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);

  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);

  const top = a + (b - a) * u;
  const bottom = c + (d - c) * u;
  return top + (bottom - top) * v;
}

/**
 * Fractal Brownian motion: octaves of value noise at doubling frequency and
 * halving amplitude, normalised back to `[0, 1)`.
 */
export function fbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let total = 0;

  for (let i = 0; i < octaves; i++) {
    // Each octave gets its own seed, or they would be scaled copies of one
    // another and the sum would show the repetition.
    sum += amplitude * valueNoise(x * frequency, y * frequency, seed + i * 8191);
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }

  return total > 0 ? sum / total : 0;
}

/**
 * A small, fast, seeded generator - so a background can be reproducible.
 *
 * Scaled by 2^32 rather than reduced modulo 100,000, which is what this used to
 * do. The modulo threw away all but five digits of the state, so it drew from
 * 100,000 values rather than four billion, and unevenly at that: 2^32 is not a
 * multiple of 100,000, so the low buckets came up slightly more often than the
 * high ones. Nothing here was visibly wrong because of it - a background rolls a
 * few dozen numbers - but a generator whose whole point is reproducible
 * randomness should not quietly be biased.
 */
export function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}
