import { describe, expect, it } from 'vitest';

import { fbm, hash2, makeRandom, valueNoise } from './noise';

describe('makeRandom', () => {
  it('is deterministic for a seed', () => {
    const a = makeRandom(7);
    const b = makeRandom(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('stays inside 0..1', () => {
    const rand = makeRandom(99);
    for (let i = 0; i < 2000; i++) {
      const value = rand();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('does not collapse to a fixed point', () => {
    const rand = makeRandom(1);
    const seen = new Set(Array.from({ length: 200 }, () => rand()));
    expect(seen.size).toBeGreaterThan(100);
  });

  it('draws from the whole 32-bit state, not a truncation of it', () => {
    // It used to reduce modulo 100,000, which left 2,000 draws colliding a couple
    // of dozen times by the birthday bound. Scaled by 2^32 they are all distinct.
    const rand = makeRandom(4242);
    const seen = new Set(Array.from({ length: 2000 }, () => rand()));
    expect(seen.size).toBe(2000);
  });

  it('is not biased towards the low end', () => {
    // The old modulo made the low buckets slightly likelier, because 2^32 is not
    // a multiple of 100,000. Halves either side of 0.5 should be even.
    const rand = makeRandom(31337);
    let low = 0;
    const draws = 20_000;
    for (let i = 0; i < draws; i++) if (rand() < 0.5) low++;
    expect(low / draws).toBeCloseTo(0.5, 1);
  });
});

describe('hash2', () => {
  it('is deterministic', () => {
    expect(hash2(3, 7, 11)).toBe(hash2(3, 7, 11));
  });

  it('stays inside 0..1', () => {
    for (let x = -50; x < 50; x++) {
      for (let y = -50; y < 50; y += 7) {
        const h = hash2(x, y, 1234);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(1);
      }
    }
  });

  it('separates x from y, and both from the seed', () => {
    expect(hash2(1, 2, 3)).not.toBe(hash2(2, 1, 3));
    expect(hash2(1, 2, 3)).not.toBe(hash2(1, 2, 4));
  });

  it('decorrelates neighbours - a lattice hash that does not is a visible grid', () => {
    const a: number[] = [];
    const b: number[] = [];
    for (let x = 0; x < 400; x++) {
      a.push(hash2(x, 0, 99));
      b.push(hash2(x + 1, 0, 99));
    }

    const mean = (v: number[]) => v.reduce((s, n) => s + n, 0) / v.length;
    const ma = mean(a);
    const mb = mean(b);
    let cov = 0;
    let va = 0;
    let vb = 0;
    for (let i = 0; i < a.length; i++) {
      cov += (a[i] - ma) * (b[i] - mb);
      va += (a[i] - ma) ** 2;
      vb += (b[i] - mb) ** 2;
    }

    expect(Math.abs(cov / Math.sqrt(va * vb))).toBeLessThan(0.15);
  });

  it('spreads roughly evenly across the range', () => {
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 20000; i++) buckets[Math.floor(hash2(i, i * 3, 7) * 10)]++;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(1000);
      expect(count).toBeLessThan(4000);
    }
  });
});

describe('valueNoise', () => {
  it('stays inside 0..1', () => {
    for (let x = -10; x < 10; x += 0.37) {
      for (let y = -10; y < 10; y += 0.53) {
        const n = valueNoise(x, y, 42);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThan(1);
      }
    }
  });

  it('hits the lattice values exactly at integer coordinates', () => {
    expect(valueNoise(4, 9, 5)).toBeCloseTo(hash2(4, 9, 5), 12);
  });

  it('is continuous - no seams where cells meet', () => {
    // A step across a lattice boundary must be no bigger than one just inside
    // a cell. A missing smoothstep, or a bad floor, shows up here.
    const at = (x: number) => valueNoise(x, 0.5, 3);
    const across = Math.abs(at(2.001) - at(1.999));
    const inside = Math.abs(at(1.5) - at(1.498));
    expect(across).toBeLessThan(inside + 0.02);
  });

  it('is smooth rather than piecewise-linear at the lattice', () => {
    // Smoothstep flattens the gradient at cell edges; plain linear
    // interpolation would leave it at its steepest exactly there.
    const at = (x: number) => valueNoise(x, 0.25, 8);
    const edge = Math.abs(at(3.02) - at(2.98));
    const middle = Math.abs(at(3.52) - at(3.48));
    expect(edge).toBeLessThan(middle);
  });
});

describe('fbm', () => {
  it('stays inside 0..1 at every octave count', () => {
    for (const octaves of [1, 2, 3, 5]) {
      for (let x = -8; x < 8; x += 0.61) {
        const v = fbm(x, x * 0.3, 17, octaves);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it('is one octave of noise when asked for one', () => {
    expect(fbm(1.3, 2.7, 5, 1)).toBeCloseTo(valueNoise(1.3, 2.7, 5), 12);
  });

  it('adds fine detail with each octave', () => {
    // Curvature, not total variation. Octaves are independent fields summed and
    // normalised by their amplitudes, so adding one *lowers* total variation -
    // the extra octaves partly cancel while the base is scaled down. Measured
    // that way, three octaves look smoother than one, which is misleading.
    // Curvature weights by frequency squared, so it reports what an octave
    // actually contributes: detail at a finer scale.
    const H = 0.004;
    const curvature = (octaves: number) => {
      let total = 0;
      let samples = 0;
      for (let x = 0; x < 6; x += H) {
        total += Math.abs(fbm(x - H, 1, 3, octaves) - 2 * fbm(x, 1, 3, octaves) + fbm(x + H, 1, 3, octaves));
        samples++;
      }
      return total / samples / (H * H);
    };

    expect(curvature(3)).toBeGreaterThan(curvature(1) * 2);
    expect(curvature(4)).toBeGreaterThan(curvature(3));
  });

  it('gives each octave its own seed, so they are not scaled copies', () => {
    // Sharing a seed would land the doubled frequency back on the same lattice
    // values, and the sum would show the repetition.
    expect(fbm(0, 0, 1, 2)).not.toBeCloseTo(fbm(0, 0, 1, 1), 6);
  });

  it('handles a zero octave count without dividing by zero', () => {
    expect(fbm(1, 1, 1, 0)).toBe(0);
  });
});
