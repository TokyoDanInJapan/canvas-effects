import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildPalette,
  createSurface,
  defaultShading,
  planSurface,
  sameShading,
  type Shading,
  type SurfaceOptions,
} from './render.js';

afterEach(() => vi.unstubAllGlobals());

const options = (over: Partial<SurfaceOptions> = {}): SurfaceOptions => ({
  pixelSize: 6,
  fieldScale: 2,
  maxPixels: 160_000,
  maxFieldCells: Infinity,
  levels: 5,
  dither: true,
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

    it('holds even when rounding would nudge both axes back over it', () => {
      // 100x100 against a ceiling of 9,800: the shrink is 1.0102, and rounding
      // 98.995 up on both axes gives 99 x 99 = 9,801 - over the ceiling the
      // doc comment promises. Flooring cannot do that.
      const plan = planSurface(100, 100, options({ pixelSize: 1, fieldScale: 1, maxFieldCells: 9_800 }));
      expect(plan.fieldW * plan.fieldH).toBeLessThanOrEqual(9_800);
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

  describe('range', () => {
    it('pins both ends of the spectrum without touching the throw', () => {
      const p = buildPalette({ base: 0, amplitude: 255, range: [0.2, 0.8] }, 5);
      // Level 0 sits at 20% of the throw, the last level at 80%.
      expect(triple(p, 0)).toEqual([51, 51, 51]);
      expect(triple(p, 4)).toEqual([204, 204, 204]);
      // The levels between are still evenly spaced across the slice.
      expect(triple(p, 2)).toEqual([128, 128, 128]);
    });

    it('defaults to the whole spectrum, explicitly or by omission', () => {
      const bare = buildPalette({ base: 18, amplitude: 40 }, 5);
      const full = buildPalette({ base: 18, amplitude: 40, range: [0, 1] }, 5);
      expect([...full]).toEqual([...bare]);
    });

    it('slices a ramp the same way it slices the greys', () => {
      const stops: Array<[number, number, number]> = [
        [0, 0, 0],
        [200, 100, 50],
      ];
      // The upper half only: level 0 starts halfway along the ramp.
      const p = buildPalette({ base: 0, amplitude: 0, ramp: stops, range: [0.5, 1] }, 3);
      expect(triple(p, 0)).toEqual([100, 50, 25]);
      expect(triple(p, 2)).toEqual([200, 100, 50]);
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

describe('sameShading', () => {
  it('holds for two independently built but equal shadings', () => {
    // Identity is not enough: the natural way to write a `shading` callback
    // builds a fresh object, and often a fresh ramp, on every call.
    const build = (): Shading => ({ base: 18, amplitude: 26 });
    expect(sameShading(build(), build())).toBe(true);
  });

  it('notices a change of page colour or amplitude', () => {
    expect(sameShading({ base: 18, amplitude: 26 }, { base: 255, amplitude: 26 })).toBe(false);
    expect(sameShading({ base: 18, amplitude: 26 }, { base: 18, amplitude: -22 })).toBe(false);
  });

  describe('a tint', () => {
    it('compares by value', () => {
      const a: Shading = { base: 18, amplitude: 26, tint: [0, 1, 0.25] };
      const b: Shading = { base: 18, amplitude: 26, tint: [0, 1, 0.25] };
      expect(sameShading(a, b)).toBe(true);
    });

    it('differs from no tint at all', () => {
      const tinted: Shading = { base: 18, amplitude: 26, tint: [0, 1, 0.25] };
      expect(sameShading(tinted, { base: 18, amplitude: 26 })).toBe(false);
      expect(sameShading({ base: 18, amplitude: 26 }, tinted)).toBe(false);
    });

    it('notices a single channel moving', () => {
      const a: Shading = { base: 18, amplitude: 26, tint: [0, 1, 0.25] };
      const b: Shading = { base: 18, amplitude: 26, tint: [0, 1, 0.5] };
      expect(sameShading(a, b)).toBe(false);
    });
  });

  describe('a ramp', () => {
    const fire: Shading = {
      base: 18,
      amplitude: 0,
      ramp: [
        [18, 18, 18],
        [190, 66, 8],
        [255, 240, 200],
      ],
    };

    it('compares by value', () => {
      expect(sameShading(fire, { ...fire, ramp: fire.ramp!.map((s) => [...s] as [number, number, number]) })).toBe(
        true
      );
    });

    it('notices a stop changing while the page colour stays put', () => {
      // The case the old base-and-amplitude comparison got wrong: a dark page
      // swapping its accent keeps `base` and `amplitude` and changes everything
      // the visitor can actually see.
      const matrix: Shading = {
        base: 18,
        amplitude: 0,
        ramp: [
          [18, 18, 18],
          [22, 122, 46],
          [190, 255, 200],
        ],
      };
      expect(sameShading(fire, matrix)).toBe(false);
    });

    it('notices a ramp being lengthened or dropped', () => {
      expect(sameShading(fire, { ...fire, ramp: fire.ramp!.slice(0, 2) })).toBe(false);
      expect(sameShading(fire, { base: 18, amplitude: 0 })).toBe(false);
    });
  });

  describe('a range', () => {
    it('notices either end moving', () => {
      const a: Shading = { base: 18, amplitude: 26, range: [0.1, 0.9] };
      expect(sameShading(a, { ...a, range: [0.2, 0.9] })).toBe(false);
      expect(sameShading(a, { ...a, range: [0.1, 0.8] })).toBe(false);
      expect(sameShading(a, { base: 18, amplitude: 26, range: [0.1, 0.9] })).toBe(true);
    });

    it('treats the full range and no range as the same picture', () => {
      const bare: Shading = { base: 18, amplitude: 26 };
      expect(sameShading(bare, { ...bare, range: [0, 1] })).toBe(true);
      expect(sameShading({ ...bare, range: [0, 1] }, bare)).toBe(true);
      expect(sameShading(bare, { ...bare, range: [0, 0.9] })).toBe(false);
    });
  });
});

// The half of render.ts that needs a canvas. Stubbed rather than run under jsdom
// for the same reason the driver's tests are: what matters is the sequence of
// calls it makes on a context and the bytes it writes into the ImageData, and a
// fake reports both directly.
describe('createSurface', () => {
  interface Fake {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    /** The ImageData handed to the last putImageData, if any. */
    painted(): ImageData | null;
    paints(): number;
    allocations(): number;
    resizeTo(width: number, height: number): void;
  }

  function fake(cssWidth = 1200, cssHeight = 600): Fake {
    let painted: ImageData | null = null;
    let paints = 0;
    let allocations = 0;

    const canvas = {
      clientWidth: cssWidth,
      clientHeight: cssHeight,
      width: 0,
      height: 0,
    } as HTMLCanvasElement;

    const ctx = {
      createImageData(width: number, height: number) {
        allocations++;
        return { width, height, data: new Uint8ClampedArray(width * height * 4) } as ImageData;
      },
      putImageData(image: ImageData) {
        paints++;
        painted = image;
      },
    } as unknown as CanvasRenderingContext2D;

    vi.stubGlobal('window', { innerWidth: 800, innerHeight: 600 });

    return {
      canvas,
      ctx,
      painted: () => painted,
      paints: () => paints,
      allocations: () => allocations,
      resizeTo(width, height) {
        (canvas as { clientWidth: number }).clientWidth = width;
        (canvas as { clientHeight: number }).clientHeight = height;
      },
    };
  }

  /** A field of a constant value, at whatever size the surface asked for. */
  const flat = (surface: { fieldW: number; fieldH: number }, value: number) =>
    new Float32Array(surface.fieldW * surface.fieldH).fill(value);

  const pixel = (image: ImageData, index: number) => [...image.data.slice(index * 4, index * 4 + 4)];

  describe('resize', () => {
    it('reports a change on the first measurement', () => {
      const dom = fake();
      const surface = createSurface(dom.canvas, dom.ctx, options());

      expect(surface.resize()).toBe(true);
      expect(surface.width).toBe(200);
      expect(surface.height).toBe(100);
      expect(surface.fieldW).toBe(100);
      expect(surface.fieldH).toBe(50);
    });

    it('sets the backing store, not the CSS box', () => {
      const dom = fake(1200, 600);
      const surface = createSurface(dom.canvas, dom.ctx, options());
      surface.resize();

      expect(dom.canvas.width).toBe(200);
      expect(dom.canvas.height).toBe(100);
      // The element's own box is left for CSS to decide.
      expect(dom.canvas.clientWidth).toBe(1200);
    });

    it('reports no change and reallocates nothing when the size holds', () => {
      const dom = fake();
      const surface = createSurface(dom.canvas, dom.ctx, options());

      surface.resize();
      const allocated = dom.allocations();
      expect(surface.resize()).toBe(false);
      // The caller's cue to rebuild its field - a false alarm would throw away a
      // simulation on every scroll-driven resize event.
      expect(dom.allocations()).toBe(allocated);
    });

    it('reallocates when the size does change', () => {
      const dom = fake(1200, 600);
      const surface = createSurface(dom.canvas, dom.ctx, options());
      surface.resize();

      dom.resizeTo(600, 300);
      expect(surface.resize()).toBe(true);
      expect(surface.width).toBe(100);
      expect(dom.allocations()).toBe(2);
    });

    it('falls back to the window for a canvas with no box yet', () => {
      const dom = fake(0, 0);
      const surface = createSurface(dom.canvas, dom.ctx, options());
      surface.resize();

      // 800x600 from the stubbed window, at 6px a pixel.
      expect(surface.width).toBe(134);
      expect(surface.height).toBe(100);
    });
  });

  describe('shade', () => {
    it('paints once per call', () => {
      const dom = fake();
      const surface = createSurface(dom.canvas, dom.ctx, options());
      surface.resize();

      surface.shade(flat(surface, 0.5), { base: 18, amplitude: 26 }, 1);
      expect(dom.paints()).toBe(1);
    });

    it('does nothing before the first resize', () => {
      // There is no ImageData to write into yet, and inventing one would paint at
      // the wrong size.
      const dom = fake();
      const surface = createSurface(dom.canvas, dom.ctx, options());

      surface.shade(new Float32Array(4), { base: 18, amplitude: 26 }, 1);
      expect(dom.paints()).toBe(0);
    });

    it('leaves every pixel opaque', () => {
      const dom = fake();
      const surface = createSurface(dom.canvas, dom.ctx, options());
      surface.resize();
      surface.shade(flat(surface, 0.5), { base: 18, amplitude: 26 }, 1);

      const image = dom.painted()!;
      for (let i = 3; i < image.data.length; i += 4) expect(image.data[i]).toBe(255);
    });

    it('paints the page colour where the field is empty', () => {
      // What lets body text sit on one of these: an empty field is the page's own
      // colour exactly, so the canvas edge shows no seam.
      const dom = fake();
      const surface = createSurface(dom.canvas, dom.ctx, options());
      surface.resize();
      surface.shade(flat(surface, 0), { base: 18, amplitude: 26 }, 1);

      const image = dom.painted()!;
      expect(pixel(image, 0)).toEqual([18, 18, 18, 255]);
    });

    it('reaches the far end of the palette on a full field', () => {
      const dom = fake();
      const surface = createSurface(dom.canvas, dom.ctx, options());
      surface.resize();
      surface.shade(flat(surface, 1), { base: 18, amplitude: 26 }, 1);

      const image = dom.painted()!;
      expect(pixel(image, 0)).toEqual([44, 44, 44, 255]);
    });

    it('dithers a mid field into more than one level', () => {
      // The whole point of the library: a constant field halfway between two
      // levels comes out as a mixture rather than as one flat plateau.
      //
      // 0.375 rather than 0.5, which at five levels is *on* a palette step and so
      // has nothing to dither - the threshold moves it, but never far enough to
      // round anywhere else.
      const dom = fake();
      const surface = createSurface(dom.canvas, dom.ctx, options({ dither: true }));
      surface.resize();
      surface.shade(flat(surface, 0.375), { base: 0, amplitude: 255 }, 1);

      const image = dom.painted()!;
      const seen = new Set<number>();
      for (let i = 0; i < image.data.length; i += 4) seen.add(image.data[i]);
      expect(seen.size).toBeGreaterThan(1);
    });

    it('holds up at a 256-entry palette', () => {
      // The shade loop indexes the palette with `round(level * (levels - 1)) * 3`,
      // which has to stay inside it at every level count - and the top of the
      // range is where it would not.
      for (const levels of [2, 5, 64, 255, 256]) {
        const dom = fake();
        const surface = createSurface(dom.canvas, dom.ctx, options({ levels, dither: false }));
        surface.resize();
        for (const value of [0, 0.5, 1]) {
          surface.shade(flat(surface, value), { base: 0, amplitude: 255 }, 1);
          const image = dom.painted()!;
          for (let i = 0; i < image.data.length; i += 4) {
            expect(Number.isFinite(image.data[i]), `levels ${levels} at ${value}`).toBe(true);
          }
        }
        // The ends of the field land on the ends of the palette, whatever its size.
        surface.shade(flat(surface, 1), { base: 0, amplitude: 255 }, 1);
        expect(dom.painted()!.data[0], `levels ${levels}`).toBe(255);
        surface.shade(flat(surface, 0), { base: 0, amplitude: 255 }, 1);
        expect(dom.painted()!.data[0], `levels ${levels}`).toBe(0);
      }
    });

    it('runs out of distinct greys before it runs out of levels', () => {
      // The ceiling on `levels` is `amplitude`, not `levels`. A byte palette
      // over a 26-step throw has 27 greys in it however many are asked for,
      // which is worth knowing before turning the dial up and seeing nothing.
      const distinct = (levels: number, amplitude: number) => {
        const palette = buildPalette({ base: 18, amplitude }, levels);
        const seen = new Set<number>();
        for (let i = 0; i < levels; i++) seen.add(palette[i * 3]);
        return seen.size;
      };

      expect(distinct(64, 26)).toBe(27);
      expect(distinct(256, 26)).toBe(27);
      // With room to work in, the levels are all there.
      expect(distinct(256, 237)).toBeGreaterThan(200);
    });

    it("takes 'auto' to mean dither above one CSS pixel a cell and not at one", () => {
      // The size the surface *settled* at, not the one asked for. A 1200-wide
      // canvas at one pixel a cell is 1200 cells, so the dither goes off; the
      // same request under a `maxPixels` that cannot afford it comes back
      // coarser than one and the dither stays on.
      const mid = 0.375;
      const levels = (dither: SurfaceOptions['dither'], pixelSize: number, maxPixels: number) => {
        const dom = fake();
        const surface = createSurface(dom.canvas, dom.ctx, options({ dither, pixelSize, maxPixels }));
        surface.resize();
        surface.shade(flat(surface, mid), { base: 0, amplitude: 255 }, 1);
        const image = dom.painted()!;
        const seen = new Set<number>();
        for (let i = 0; i < image.data.length; i += 4) seen.add(image.data[i]);
        return seen.size;
      };

      // One CSS pixel a cell, and affordable: no dither, one flat plateau.
      expect(levels('auto', 1, 1_000_000)).toBe(1);
      // Asked for one, given three by the pixel ceiling: dithered after all.
      expect(levels('auto', 1, 160_000)).toBeGreaterThan(1);
      // Six as usual: dithered.
      expect(levels('auto', 6, 160_000)).toBeGreaterThan(1);
      // And `true` still overrides it at one, which is the setting to reach for
      // if you want smooth gradient at native resolution.
      expect(levels(true, 1, 1_000_000)).toBeGreaterThan(1);
      expect(levels(false, 6, 160_000)).toBe(1);
    });

    it('posterises flat with the dither off', () => {
      // The same field as above, and the reason the dither exists: without it
      // every cell rounds the same way and the region is one flat plateau.
      const dom = fake();
      const surface = createSurface(dom.canvas, dom.ctx, options({ dither: false }));
      surface.resize();
      surface.shade(flat(surface, 0.375), { base: 0, amplitude: 255 }, 1);

      const image = dom.painted()!;
      const seen = new Set<number>();
      for (let i = 0; i < image.data.length; i += 4) seen.add(image.data[i]);
      expect(seen.size).toBe(1);
    });

    it('applies the gamma it is handed', () => {
      const dom = fake();
      const surface = createSurface(dom.canvas, dom.ctx, options({ dither: false, levels: 9 }));
      surface.resize();

      surface.shade(flat(surface, 0.5), { base: 0, amplitude: 255 }, 1);
      const plain = pixel(dom.painted()!, 0)[0];

      surface.shade(flat(surface, 0.5), { base: 0, amplitude: 255 }, 2.2);
      const darkened = pixel(dom.painted()!, 0)[0];

      expect(darkened).toBeLessThan(plain);
    });

    it('applies gamma indistinguishably from computing it per pixel', () => {
      // The table stands in for `Math.pow`; after the five-or-so-level
      // quantise, its error must never move a pixel to a different level. The
      // endpoints are exact by construction, so black stays black.
      const dom = fake();
      const surface = createSurface(dom.canvas, dom.ctx, options({ dither: false, levels: 9 }));
      surface.resize();

      for (const value of [0, 0.2, 0.5, 0.8, 1]) {
        surface.shade(flat(surface, value), { base: 0, amplitude: 255 }, 2.2);
        const tabled = pixel(dom.painted()!, 0)[0];

        // The same field with the gamma already applied, through the untabled
        // gamma-of-1 path.
        surface.shade(flat(surface, Math.pow(value, 2.2)), { base: 0, amplitude: 255 }, 1);
        const direct = pixel(dom.painted()!, 0)[0];

        expect(tabled).toBe(direct);
      }
    });

    it('notices a shading mutated in place rather than replaced', () => {
      // The palette is cached against the last shading; a host that mutates one
      // object and repaints must not be handed yesterday's palette back.
      const dom = fake();
      const surface = createSurface(dom.canvas, dom.ctx, options({ dither: false }));
      surface.resize();

      const shading: Shading = { base: 0, amplitude: 255 };
      surface.shade(flat(surface, 1), shading, 1);
      expect(pixel(dom.painted()!, 0)[0]).toBe(255);

      shading.amplitude = 100;
      surface.shade(flat(surface, 1), shading, 1);
      expect(pixel(dom.painted()!, 0)[0]).toBe(100);
    });

    it('interpolates the coarse field up rather than blocking it', () => {
      // A field that is dark at one end and light at the other must come out as a
      // gradient across the output, not as fieldW flat columns.
      const dom = fake();
      const surface = createSurface(dom.canvas, dom.ctx, options({ fieldScale: 4, dither: false, levels: 9 }));
      surface.resize();

      const field = new Float32Array(surface.fieldW * surface.fieldH);
      for (let j = 0; j < surface.fieldH; j++) {
        for (let i = 0; i < surface.fieldW; i++) field[j * surface.fieldW + i] = i / (surface.fieldW - 1);
      }
      surface.shade(field, { base: 0, amplitude: 255 }, 1);

      const image = dom.painted()!;
      const left = pixel(image, 0)[0];
      const middle = pixel(image, Math.floor(surface.width / 2))[0];
      const right = pixel(image, surface.width - 1)[0];
      expect(left).toBeLessThan(middle);
      expect(middle).toBeLessThan(right);
    });

    it('honours a ramp over base and amplitude', () => {
      const dom = fake();
      const surface = createSurface(dom.canvas, dom.ctx, options({ dither: false }));
      surface.resize();
      surface.shade(
        flat(surface, 1),
        {
          base: 18,
          amplitude: 26,
          ramp: [
            [18, 18, 18],
            [255, 240, 200],
          ],
        },
        1
      );

      expect(pixel(dom.painted()!, 0)).toEqual([255, 240, 200, 255]);
    });
  });
});

describe('defaultShading', () => {
  /** A document with or without the `dark` class, and an OS preference. */
  function stubTheme({ darkClass = false, osDark = false, matchMedia = true } = {}) {
    vi.stubGlobal('document', {
      documentElement: { classList: { contains: (name: string) => darkClass && name === 'dark' } },
    });
    vi.stubGlobal('window', {
      matchMedia: matchMedia ? () => ({ matches: osDark }) : undefined,
    });
  }

  it('paints near-white behind a light page, moving down', () => {
    stubTheme();
    // Negative amplitude is what a light theme wants: the effect darkens the page
    // rather than trying to brighten something already white.
    expect(defaultShading()).toEqual({ base: 255, amplitude: -22 });
  });

  it('paints near-black behind a dark page, moving up', () => {
    stubTheme({ darkClass: true });
    expect(defaultShading()).toEqual({ base: 18, amplitude: 26 });
  });

  it('follows the OS when the page says nothing', () => {
    stubTheme({ osDark: true });
    expect(defaultShading().base).toBe(18);
  });

  it('lets the page override the OS', () => {
    // A `dark` class is a decision; `prefers-color-scheme` is a hint.
    stubTheme({ darkClass: true, osDark: false });
    expect(defaultShading().base).toBe(18);
  });

  it('assumes light where matchMedia is missing', () => {
    stubTheme({ matchMedia: false });
    expect(defaultShading().base).toBe(255);
  });
});
