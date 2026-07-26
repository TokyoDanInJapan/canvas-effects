import { describe, expect, it } from 'vitest';

import { BAYER_4X4, darken, orderedDither, quantise } from './dither';

describe('darken', () => {
  it('leaves the field alone at gamma 1', () => {
    for (let v = 0; v <= 1; v += 0.05) expect(darken(v, 1)).toBeCloseTo(v, 12);
  });

  it('pins both ends, so the palette is unchanged', () => {
    for (const g of [1, 1.19, 2, 3]) {
      expect(darken(0, g)).toBe(0);
      expect(darken(1, g)).toBe(1);
    }
  });

  it('moves everything in between downwards', () => {
    for (let v = 0.05; v < 1; v += 0.05) {
      expect(darken(v, 1.19)).toBeLessThan(v);
      expect(darken(v, 2)).toBeLessThan(darken(v, 1.19));
    }
  });

  it('stays monotonic - darker regions must not reorder', () => {
    let previous = -1;
    for (let v = 0; v <= 1; v += 0.01) {
      const out = darken(v, 1.19);
      expect(out).toBeGreaterThanOrEqual(previous);
      previous = out;
    }
  });

  it('clamps out-of-range input rather than returning NaN', () => {
    // Math.pow of a negative base and a fractional exponent is NaN, which would
    // reach the palette and blank a frame.
    expect(darken(-0.5, 1.19)).toBe(0);
    expect(darken(4, 1.19)).toBe(1);
    expect(Number.isNaN(darken(-0.5, 1.19))).toBe(false);
  });
});

describe('quantise', () => {
  it('snaps to evenly spaced levels, endpoints included', () => {
    expect(quantise(0, 6)).toBe(0);
    expect(quantise(1, 6)).toBe(1);
    expect(quantise(0.5, 6)).toBeCloseTo(0.6, 6);
    expect(new Set(Array.from({ length: 200 }, (_, i) => quantise(i / 199, 6))).size).toBe(6);
  });

  it('clamps out-of-range input', () => {
    expect(quantise(-3, 6)).toBe(0);
    expect(quantise(4, 6)).toBe(1);
  });

  it('survives a degenerate level count', () => {
    expect(quantise(0.5, 1)).toBe(0);
    expect(quantise(0.5, 0)).toBe(0);
  });
});

describe('BAYER_4X4', () => {
  it('is sixteen distinct thresholds inside (0, 1)', () => {
    expect(BAYER_4X4).toHaveLength(16);
    expect(new Set(BAYER_4X4).size).toBe(16);
    for (const t of BAYER_4X4) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(1);
    }
  });

  it('averages to exactly a half, which is what keeps brightness unchanged', () => {
    expect(BAYER_4X4.reduce((s, t) => s + t, 0) / BAYER_4X4.length).toBeCloseTo(0.5, 12);
  });

  it('is evenly spread rather than clustered', () => {
    const sorted = [...BAYER_4X4].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeCloseTo(1 / 16, 12);
    }
  });
});

describe('orderedDither', () => {
  const LEVELS = 5;
  const step = 1 / (LEVELS - 1);

  it('only ever emits values from the palette', () => {
    const palette = new Set(Array.from({ length: LEVELS }, (_, i) => i / (LEVELS - 1)));
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        for (let v = 0; v <= 1; v += 0.013) {
          expect(palette.has(orderedDither(v, x, y, LEVELS))).toBe(true);
        }
      }
    }
  });

  it('splits a between-levels value across the cell instead of flattening it', () => {
    // Half way between two levels: some pixels round down, some up. This is the
    // difference between a dither and a posterise, and why it looks smooth.
    const results = new Set<number>();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) results.add(orderedDither(step / 2, x, y, LEVELS));
    expect(results.size).toBe(2);
  });

  it('preserves the average over a cell - dithering must not shift brightness', () => {
    for (let v = 0; v <= 1; v += 0.017) {
      let total = 0;
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) total += orderedDither(v, x, y, LEVELS);
      expect(Math.abs(total / 16 - v)).toBeLessThan(step / 8);
    }
  });

  it('leaves values already on a level alone', () => {
    for (let i = 0; i < LEVELS; i++) {
      const exact = i / (LEVELS - 1);
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) expect(orderedDither(exact, x, y, LEVELS)).toBeCloseTo(exact, 12);
      }
    }
  });

  it('repeats every four pixels on both axes', () => {
    const v = 0.37;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(orderedDither(v, x + 4, y, LEVELS)).toBe(orderedDither(v, x, y, LEVELS));
        expect(orderedDither(v, x, y + 8, LEVELS)).toBe(orderedDither(v, x, y, LEVELS));
      }
    }
  });

  it('clamps out-of-range input and survives a degenerate palette', () => {
    expect(orderedDither(-4, 1, 2, LEVELS)).toBe(0);
    expect(orderedDither(9, 1, 2, LEVELS)).toBe(1);
    expect(orderedDither(0.5, 1, 2, 1)).toBe(0);
    expect(orderedDither(0.5, 1, 2, 0)).toBe(0);
  });
});
