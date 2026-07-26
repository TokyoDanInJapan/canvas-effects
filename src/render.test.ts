import { describe, expect, it } from 'vitest';

import { planSurface, type SurfaceOptions } from './render';

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
