import { describe, expect, it } from 'vitest';

import { buildPalette, planSurface, type Shading, type SurfaceOptions } from './render';

const options = (over: Partial<SurfaceOptions> = {}): SurfaceOptions => ({
  pixelSize: 6,
  fieldScale: 2,
  maxPixels: 160_000,
  maxFieldCells: Infinity,
  levels: 5,
  ...over,
});

describe('planSurface', () => {
  it('divides the CSS size by the pixel size', () => {
    const plan = planSurface(1200, 600, options());
    expect(plan.width).toBe(200);
    expect(plan.height).toBe(100);
  });

  it('makes the field coarser than the output by fieldScale, per axis', () => {
    const plan = planSurface(1200, 600, options({ fieldScale: 2 }));
    expect(plan.fieldW).toBe(100);
    expect(plan.fieldH).toBe(50);
  });

  it('never returns a degenerate surface, however small the element', () => {
    const plan = planSurface(0, 0, options());
    expect(plan.width).toBeGreaterThanOrEqual(2);
    expect(plan.height).toBeGreaterThanOrEqual(2);
    expect(plan.fieldW).toBeGreaterThanOrEqual(2);
    expect(plan.fieldH).toBeGreaterThanOrEqual(2);
  });

  describe('the pixel ceiling', () => {
    it('leaves a window under it alone', () => {
      const plan = planSurface(1920, 1080, options());
      expect(plan.width * plan.height).toBeLessThanOrEqual(160_000);
      // 1080p at 6px is ~57,600 pixels, well inside the cap.
      expect(plan.width).toBe(320);
    });

    it('holds on a window far over it', () => {
      const plan = planSurface(3840, 2160, options({ maxPixels: 160_000 }));
      expect(plan.width * plan.height).toBeLessThanOrEqual(160_000);
    });

    it('is why a 4K window is not four times the work of a 1080p one', () => {
      const small = planSurface(1920, 1080, options({ maxPixels: 40_000 }));
      const large = planSurface(3840, 2160, options({ maxPixels: 40_000 }));
      const ratio = (large.width * large.height) / (small.width * small.height);
      expect(ratio).toBeLessThan(1.2);
    });
  });

  describe('the field ceiling', () => {
    it('holds independently of the pixel ceiling', () => {
      const plan = planSurface(2560, 1440, options({ maxFieldCells: 8_000 }));
      expect(plan.fieldW * plan.fieldH).toBeLessThanOrEqual(8_000);
    });

    it('bites before the pixel ceiling does, which is the point of having both', () => {
      const capped = planSurface(2560, 1440, options({ maxFieldCells: 8_000 }));
      const free = planSurface(2560, 1440, options({ maxFieldCells: Infinity }));
      expect(capped.width).toBe(free.width);
      expect(capped.fieldW).toBeLessThan(free.fieldW);
    });

    it('keeps the aspect ratio roughly intact when it shrinks the field', () => {
      const plan = planSurface(2560, 1440, options({ maxFieldCells: 4_000 }));
      expect(plan.fieldW / plan.fieldH).toBeCloseTo(2560 / 1440, 1);
    });
  });
});

describe('buildPalette', () => {
  const triple = (p: Uint8ClampedArray, i: number) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];

  describe('greyscale', () => {
    it('runs from base to base + amplitude, evenly', () => {
      const p = buildPalette({ base: 18, amplitude: 40 }, 5);
      expect(triple(p, 0)).toEqual([18, 18, 18]);
      expect(triple(p, 4)).toEqual([58, 58, 58]);
      expect(triple(p, 2)).toEqual([38, 38, 38]);
    });

    it('descends for a negative amplitude, which is what a light theme wants', () => {
      const p = buildPalette({ base: 255, amplitude: -20 }, 5);
      expect(triple(p, 0)).toEqual([255, 255, 255]);
      expect(triple(p, 4)).toEqual([235, 235, 235]);
    });

    it('keeps all three channels equal', () => {
      const p = buildPalette({ base: 30, amplitude: 60 }, 7);
      for (let i = 0; i < 7; i++) {
        const [r, g, b] = triple(p, i);
        expect(g).toBe(r);
        expect(b).toBe(r);
      }
    });
  });

  describe('tint', () => {
    it('scales the amplitude per channel and leaves base alone', () => {
      // base stays untinted on purpose: it is the page's own colour, and the
      // canvas is opaque, so it has to keep painting it faithfully.
      const p = buildPalette({ base: 18, amplitude: 100, tint: [0, 1, 0.25] }, 5);
      expect(triple(p, 0)).toEqual([18, 18, 18]);
      expect(triple(p, 4)).toEqual([18, 118, 43]);
    });
  });

  describe('ramp', () => {
    const ramp = [
      [0, 0, 0],
      [255, 0, 0],
      [255, 255, 255],
    ] as const;

    it('takes the ends exactly', () => {
      const p = buildPalette({ base: 0, amplitude: 0, ramp }, 5);
      expect(triple(p, 0)).toEqual([0, 0, 0]);
      expect(triple(p, 4)).toEqual([255, 255, 255]);
    });

    it('interpolates between stops, so stop count and level count are independent', () => {
      // Three stops over five levels: level 2 lands exactly on the middle stop,
      // and levels 1 and 3 halfway to their neighbours. 128 rather than 127
      // because a Uint8ClampedArray rounds half to even, and 127.5 goes up.
      const p = buildPalette({ base: 0, amplitude: 0, ramp }, 5);
      expect(triple(p, 2)).toEqual([255, 0, 0]);
      expect(triple(p, 1)).toEqual([128, 0, 0]);
      expect(triple(p, 3)).toEqual([255, 128, 128]);
    });

    it('handles more stops than levels by sampling across them', () => {
      const long = [
        [0, 0, 0],
        [10, 10, 10],
        [20, 20, 20],
        [30, 30, 30],
        [40, 40, 40],
      ] as const;
      const p = buildPalette({ base: 0, amplitude: 0, ramp: long }, 3);
      expect(triple(p, 0)).toEqual([0, 0, 0]);
      expect(triple(p, 1)).toEqual([20, 20, 20]);
      expect(triple(p, 2)).toEqual([40, 40, 40]);
    });

    it('supersedes base, amplitude and tint', () => {
      const shading: Shading = { base: 200, amplitude: -90, tint: [0, 1, 0], ramp };
      const p = buildPalette(shading, 3);
      expect(triple(p, 0)).toEqual([0, 0, 0]);
      expect(triple(p, 2)).toEqual([255, 255, 255]);
    });

    it('copes with a single stop', () => {
      const p = buildPalette({ base: 0, amplitude: 0, ramp: [[7, 8, 9]] }, 4);
      for (let i = 0; i < 4; i++) expect(triple(p, i)).toEqual([7, 8, 9]);
    });

    it('is ignored when empty, falling back to the greys', () => {
      const p = buildPalette({ base: 18, amplitude: 40, ramp: [] }, 5);
      expect(triple(p, 4)).toEqual([58, 58, 58]);
    });
  });

  it('returns one triple per level', () => {
    for (const levels of [1, 2, 5, 12]) {
      expect(buildPalette({ base: 18, amplitude: 40 }, levels)).toHaveLength(levels * 3);
    }
  });

  it('survives a single-level palette without dividing by zero', () => {
    const p = buildPalette({ base: 18, amplitude: 40 }, 1);
    expect(triple(p, 0)).toEqual([18, 18, 18]);
    for (const v of p) expect(Number.isFinite(v)).toBe(true);
  });

  it('clamps out-of-range values rather than wrapping them', () => {
    // A Uint8ClampedArray is doing the work, and that is deliberate: an
    // over-bright amplitude should saturate, not wrap around to black.
    const p = buildPalette({ base: 200, amplitude: 400 }, 3);
    expect(triple(p, 2)).toEqual([255, 255, 255]);
    const dark = buildPalette({ base: 20, amplitude: -400 }, 3);
    expect(triple(dark, 2)).toEqual([0, 0, 0]);
  });
});
