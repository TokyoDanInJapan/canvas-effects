import { describe, expect, it } from 'vitest';

import { makeRandom } from './noise';
import { orderedDither } from './dither';
import {
  RIDGE_DEFAULTS,
  createRidges,
  randomizeRidges,
  renderRidges,
  ridgeHeight,
  rowAmplitude,
  rowBrightness,
  rowY,
  stepRidges,
  type Ridges,
} from './ridges';

const W = 60;
const H = 80;

const seeded = (seed = 21) => createRidges(W, H, makeRandom(seed));
const lit = (r: Ridges) => Array.from(r.field).filter((v) => v > 0).length;
const column = (r: Ridges, x: number) => Array.from({ length: r.h }, (_, y) => r.field[y * r.w + x]);

describe('randomizeRidges', () => {
  it('is reproducible when given a seeded generator', () => {
    expect(randomizeRidges(makeRandom(8))).toEqual(randomizeRidges(makeRandom(8)));
  });

  it('gives different runs different landscapes', () => {
    expect(randomizeRidges(makeRandom(1)).seed).not.toBe(randomizeRidges(makeRandom(2)).seed);
  });
});

describe('ridgeHeight', () => {
  const state = randomizeRidges(makeRandom(3));

  it('stays inside 0..1', () => {
    for (let i = 0; i <= 40; i++) {
      for (let z = 0; z < 8; z++) {
        const v = ridgeHeight(i / 40, z, RIDGE_DEFAULTS, state);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('lies flat at the edges and lifts in the middle', () => {
    // The central band is the signature of the look this references.
    const middle = ridgeHeight(0.5, 4, RIDGE_DEFAULTS, state);
    expect(ridgeHeight(0, 4, RIDGE_DEFAULTS, state)).toBeLessThan(0.02);
    expect(ridgeHeight(1, 4, RIDGE_DEFAULTS, state)).toBeLessThan(0.02);
    expect(middle).toBeGreaterThan(0.05);
  });

  it('widens the active band when focus is loosened', () => {
    const tight = ridgeHeight(0.15, 4, { ...RIDGE_DEFAULTS, focus: 0.12 }, state);
    const loose = ridgeHeight(0.15, 4, { ...RIDGE_DEFAULTS, focus: 0.6 }, state);
    expect(loose).toBeGreaterThan(tight);
  });

  it('keeps neighbouring rows correlated, so the stack is one landscape', () => {
    // Rows that share no structure read as noise rather than as slices through
    // something. `zScale` is what controls this and it is deliberately small.
    let neighbour = 0;
    let distant = 0;
    for (let i = 0; i <= 40; i++) {
      const u = i / 40;
      const here = ridgeHeight(u, 10, RIDGE_DEFAULTS, state);
      neighbour += Math.abs(here - ridgeHeight(u, 11, RIDGE_DEFAULTS, state));
      distant += Math.abs(here - ridgeHeight(u, 40, RIDGE_DEFAULTS, state));
    }
    expect(neighbour).toBeLessThan(distant);
  });

  it('sharpens peaks as sharpness rises', () => {
    const area = (sharpness: number) => {
      let total = 0;
      for (let i = 0; i <= 60; i++) total += ridgeHeight(i / 60, 4, { ...RIDGE_DEFAULTS, sharpness }, state);
      return total;
    };
    // A higher exponent pushes everything below 1 down, so less of the profile
    // stands up - narrower crests, flatter ground.
    expect(area(4)).toBeLessThan(area(1.2));
  });

  it('is deterministic', () => {
    expect(ridgeHeight(0.4, 7, RIDGE_DEFAULTS, state)).toBe(ridgeHeight(0.4, 7, RIDGE_DEFAULTS, state));
  });
});

describe('row geometry', () => {
  it('puts the nearest row at the bottom and the farthest at the top', () => {
    expect(rowY(0, H, RIDGE_DEFAULTS)).toBeCloseTo(RIDGE_DEFAULTS.bottomMargin * H, 6);
    expect(rowY(1, H, RIDGE_DEFAULTS)).toBeCloseTo(RIDGE_DEFAULTS.topMargin * H, 6);
  });

  it('moves rows monotonically up the screen as they recede', () => {
    let previous = Infinity;
    for (let d = 0; d <= 1; d += 0.05) {
      const y = rowY(d, H, RIDGE_DEFAULTS);
      expect(y).toBeLessThan(previous);
      previous = y;
    }
  });

  it('crowds the far rows together - that is the perspective', () => {
    const gap = (a: number, b: number, perspective: number) =>
      rowY(a, H, { ...RIDGE_DEFAULTS, perspective }) - rowY(b, H, { ...RIDGE_DEFAULTS, perspective });

    const near = gap(0, 0.1, RIDGE_DEFAULTS.perspective);
    const far = gap(0.9, 1, RIDGE_DEFAULTS.perspective);
    expect(near).toBeGreaterThan(far);

    // At 1 the stack is even, which is the flat plot rather than a flight.
    expect(gap(0, 0.1, 1)).toBeCloseTo(gap(0.9, 1, 1), 6);
  });

  it('shrinks and dims rows with distance', () => {
    expect(rowAmplitude(0, H, RIDGE_DEFAULTS)).toBeGreaterThan(rowAmplitude(1, H, RIDGE_DEFAULTS));
    expect(rowAmplitude(1, H, RIDGE_DEFAULTS)).toBeCloseTo(0, 6);
    expect(rowBrightness(0, RIDGE_DEFAULTS)).toBe(1);
    expect(rowBrightness(1, RIDGE_DEFAULTS)).toBeCloseTo(RIDGE_DEFAULTS.depthFade, 6);
  });
});

describe('renderRidges', () => {
  it('draws something, and only inside the field', () => {
    const r = seeded();
    renderRidges(r, RIDGE_DEFAULTS);
    expect(lit(r)).toBeGreaterThan(50);
    for (const v of r.field) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('draws the nearest row at full brightness, so it survives the dither', () => {
    // 0 and 1 are fixed points of the ordered dither; anything between breaks
    // into two levels. A near line has to be exactly 1 or it comes out dashed.
    const r = seeded();
    renderRidges(r, RIDGE_DEFAULTS);
    const brightest = Math.max(...r.field);
    expect(brightest).toBe(1);

    const levels = new Set<number>();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) levels.add(orderedDither(brightest, x, y, 5));
    expect(levels.size).toBe(1);
  });

  it('draws continuous lines - no gaps down a steep flank', () => {
    // Sampling one cell per column and not filling between would leave a
    // dotted line wherever the terrain is steeper than one cell per column.
    const r = createRidges(W, H, makeRandom(5));
    renderRidges(r, { ...RIDGE_DEFAULTS, rows: 1, amplitude: 0.8, sharpness: 1, focus: 4 });

    // Every column the single row passes through must be lit somewhere.
    let empty = 0;
    for (let x = 0; x < W; x++) if (column(r, x).every((v) => v === 0)) empty++;
    expect(empty).toBe(0);
  });

  describe('hidden-line removal', () => {
    it('hides what sits behind a nearer row', () => {
      const withOcclusion = seeded();
      renderRidges(withOcclusion, RIDGE_DEFAULTS);

      // Same scene with the rows drawn flat and low, so nothing occludes:
      // a tangle lights far more cells than the occluded version.
      const flat = seeded();
      renderRidges(flat, { ...RIDGE_DEFAULTS, amplitude: 0 });

      expect(lit(withOcclusion)).toBeLessThan(lit(flat) + RIDGE_DEFAULTS.rows * W);
    });

    it('leaves nothing lit below the nearest silhouette', () => {
      const r = seeded(9);
      renderRidges(r, RIDGE_DEFAULTS);

      // Walk each column from the bottom: the first lit cell is the nearest
      // row, and everything under it must be clear.
      for (let x = 0; x < W; x++) {
        const col = column(r, x);
        const lowest = col.reduce((acc, v, y) => (v > 0 ? y : acc), -1);
        if (lowest < 0) continue;
        for (let y = lowest + 1; y < H; y++) expect(col[y]).toBe(0);
      }
    });

    it('lets a tall near peak bite into the rows behind it', () => {
      // The characteristic notch. Counting lit cells in a band does not show
      // this: a tall near peak *adds* its own ink to the same band it hides
      // things in, and the two roughly cancel. Brightness separates them -
      // distant rows are drawn dimmer, so counting only the dim cells counts
      // how much of the far stack survived.
      const distantInk = (amplitude: number) => {
        const r = seeded(4);
        renderRidges(r, { ...RIDGE_DEFAULTS, amplitude });
        const nearest = rowBrightness(0, RIDGE_DEFAULTS);
        return Array.from(r.field).filter((v) => v > 0 && v < nearest * 0.9).length;
      };

      expect(distantInk(0.55)).toBeLessThan(distantInk(0.05));
    });
  });

  it('fades the far rows off the palette, which is what makes them haze', () => {
    const r = seeded();
    renderRidges(r, RIDGE_DEFAULTS);

    const values = new Set(Array.from(r.field).filter((v) => v > 0));
    // More than one brightness in play, and at least one of them sits between
    // palette levels so the dither textures it.
    expect(values.size).toBeGreaterThan(1);

    const textured = [...values].some((v) => {
      const levels = new Set<number>();
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) levels.add(orderedDither(v, x, y, 5));
      return levels.size > 1;
    });
    expect(textured).toBe(true);
  });
});

describe('rolling off the bottom', () => {
  /** The lowest row with anything drawn in it, or -1. */
  const lowestLit = (r: Ridges) => {
    for (let y = r.h - 1; y >= 0; y--) {
      for (let x = 0; x < r.w; x++) if (r.field[y * r.w + x] > 0) return y;
    }
    return -1;
  };

  it('draws below bottomMargin, where nothing used to be drawn at all', () => {
    // Without overscan the nearest row stops at `bottomMargin` and the strip
    // below it is permanently blank.
    const withOverscan = seeded(3);
    renderRidges(withOverscan, RIDGE_DEFAULTS);
    const without = seeded(3);
    renderRidges(without, { ...RIDGE_DEFAULTS, overscan: 0 });

    const margin = Math.floor(RIDGE_DEFAULTS.bottomMargin * H);
    expect(lowestLit(without)).toBeLessThanOrEqual(margin);
    expect(lowestLit(withOverscan)).toBeGreaterThan(margin);
  });

  it('does not pop a row out of existence as travel crosses a whole number', () => {
    // The bug this fixes: the nearest row crept down to bottomMargin and then
    // vanished, so the lowest drawn row jumped back up the screen once per row
    // of travel. Sampled finely across a crossing, the low-water mark should
    // move smoothly.
    const r = seeded(3);
    const params = { ...RIDGE_DEFAULTS, speed: 1 };
    const samples: number[] = [];

    for (let i = 0; i <= 24; i++) {
      r.travel = 4 + i / 24;
      renderRidges(r, params);
      samples.push(lowestLit(r));
    }

    let worstJump = 0;
    for (let i = 1; i < samples.length; i++) worstJump = Math.max(worstJump, Math.abs(samples[i] - samples[i - 1]));

    // A deleted row showed up as a jump of several cells back up the screen.
    expect(worstJump).toBeLessThanOrEqual(2);
  });

  it('keeps a crest visible after its baseline has left the screen', () => {
    // Which is the whole reason the overscan rows are drawn rather than merely
    // counted. Targeted rather than searched: pick the depth where a row's
    // baseline is off screen but its crest is not, then place a row there.
    const params = RIDGE_DEFAULTS;

    let depth = 0;
    for (let d = -0.005; d > -0.5; d -= 0.005) {
      const base = rowY(d, H, params);
      if (base > H && base - rowAmplitude(d, H, params) < H) {
        depth = d;
        break;
      }
    }
    expect(depth).toBeLessThan(0);

    // depth = (worldZ - travel) / rows, so this puts row 10 at that depth.
    const travel = 10 - depth * params.rows;
    const margin = Math.floor(params.bottomMargin * H);

    const withOverscan = seeded(3);
    withOverscan.travel = travel;
    renderRidges(withOverscan, params);

    const without = seeded(3);
    without.travel = travel;
    renderRidges(without, { ...params, overscan: 0 });

    const belowMargin = (r: Ridges) => {
      let n = 0;
      for (let y = margin + 1; y < H; y++) for (let x = 0; x < W; x++) if (r.field[y * r.w + x] > 0) n++;
      return n;
    };

    expect(belowMargin(withOverscan)).toBeGreaterThan(0);
    expect(belowMargin(without)).toBe(0);
  });

  it('still lets rows leave, rather than looming forever', () => {
    // Amplitude is frozen at the near edge so the baseline outruns it. If it
    // kept growing, a passing row would never be fully below the screen and
    // would occlude the entire field from behind the bottom edge.
    const params = RIDGE_DEFAULTS;
    for (const depth of [-0.05, -0.2, -0.6, -2]) {
      const base = rowY(depth, H, params);
      const amp = rowAmplitude(depth, H, params);
      expect(amp).toBeLessThanOrEqual(rowAmplitude(0, H, params) + 1e-9);
      if (depth <= -0.6) expect(base - amp).toBeGreaterThanOrEqual(H);
    }
  });

  it('costs little: rows fully below the edge are skipped, not drawn', () => {
    // Overscan is a bound rather than a workload. Raising it well past what the
    // geometry needs must not change the picture.
    const modest = seeded(3);
    renderRidges(modest, RIDGE_DEFAULTS);
    const generous = seeded(3);
    renderRidges(generous, { ...RIDGE_DEFAULTS, overscan: 40 });
    expect(Array.from(generous.field)).toEqual(Array.from(modest.field));
  });
});

describe('stepRidges', () => {
  it('flies forward at the speed it is given', () => {
    const r = seeded();
    stepRidges(r, RIDGE_DEFAULTS, 1);
    expect(r.travel).toBeCloseTo(RIDGE_DEFAULTS.speed, 6);
  });

  it('changes the picture as it goes', () => {
    const r = seeded();
    renderRidges(r, RIDGE_DEFAULTS);
    const before = Array.from(r.field);
    for (let i = 0; i < 12; i++) stepRidges(r, RIDGE_DEFAULTS, 1 / 24);
    expect(Array.from(r.field)).not.toEqual(before);
  });

  it('moves terrain toward the viewer rather than morphing it in place', () => {
    // A profile is tied to a whole number of `travel`, so it keeps its shape
    // and slides down. Tying profiles to screen slots instead would make the
    // landscape churn without ever arriving.
    const r = seeded(6);
    const params = { ...RIDGE_DEFAULTS, speed: 1 };

    // The row that is currently one step away will, after one unit of travel,
    // sit exactly where the row in front of it sits now.
    const worldZ = Math.ceil(r.travel) + 5;
    const depthNow = (worldZ - r.travel) / params.rows;
    stepRidges(r, params, 1);
    const depthLater = (worldZ - r.travel) / params.rows;

    expect(depthLater).toBeLessThan(depthNow);
    expect(rowY(depthLater, H, params)).toBeGreaterThan(rowY(depthNow, H, params));
  });

  it('keeps drawing indefinitely rather than flying off the end', () => {
    const r = seeded();
    for (let i = 0; i < 600; i++) stepRidges(r, RIDGE_DEFAULTS, 1 / 24);
    expect(lit(r)).toBeGreaterThan(50);
    expect(Number.isFinite(r.travel)).toBe(true);
  });

  it('is reproducible for a given seed', () => {
    const a = seeded(12);
    const b = seeded(12);
    for (let i = 0; i < 30; i++) {
      stepRidges(a, RIDGE_DEFAULTS, 1 / 24);
      stepRidges(b, RIDGE_DEFAULTS, 1 / 24);
    }
    expect(Array.from(a.field)).toEqual(Array.from(b.field));
  });
});
