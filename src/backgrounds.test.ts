// Every effect, mounted for real.
//
// The six mount files are thin now - each is its options, its defaults and a spec
// handed to `background.ts` - but thin is not the same as right, and a spec that
// returns the wrong field or never renders would still typecheck. So this mounts
// each of them against a stubbed canvas and checks the bytes that come out.
//
// What it is really for: these six are the entry points the README documents, and
// until now nothing exercised them at all. A wiring mistake in any of them - a
// field that is never filled, a `rebuild` that forgets to render, an interaction
// wired to the wrong axis - reaches the page and nothing else here would notice.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeRandom } from './noise.js';
import { createMetaballsBackground } from './metaballs-background.js';
import { createPlasmaBackground } from './plasma-background.js';
import { createRainBackground } from './rain-background.js';
import { createRidgesBackground } from './ridges-background.js';
import { createSmokeBackground } from './smoke-background.js';
import { createTunnelBackground } from './tunnel-background.js';
import { type BackgroundHandle } from './render.js';

type Listener = (event?: unknown) => void;

interface Page {
  canvas: HTMLCanvasElement;
  /** Advances the frame clock and runs one frame. */
  frame(): void;
  /** The greys of the last painted frame. */
  greys(): number[];
  paints(): number;
  press(u: number, v: number): void;
  dragTo(u: number, v: number): void;
  release(): void;
  listeners(): number;
  /** Changes the CSS box and lets the resize listener see it. */
  resizeTo(width: number, height: number): void;
}

// `width` and `height` are reassigned by `resizeTo`, which is why the canvas box
// below reads them through a getter rather than copying them.
function page({ width = 900, height = 600, reducedMotion = false } = {}): Page {
  const targets = {
    window: new Map<string, Set<Listener>>(),
    document: new Map<string, Set<Listener>>(),
    media: new Map<string, Set<Listener>>(),
  };

  const listen = (bag: Map<string, Set<Listener>>) => ({
    addEventListener(type: string, fn: Listener) {
      if (!bag.has(type)) bag.set(type, new Set());
      bag.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: Listener) {
      bag.get(type)?.delete(fn);
    },
  });

  let image: ImageData | null = null;
  let paints = 0;
  let queued: ((now: number) => void) | null = null;
  let clock = 1000;

  const ctx = {
    createImageData: (w: number, h: number) =>
      ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) as ImageData,
    putImageData: (painted: ImageData) => {
      paints++;
      image = painted;
    },
  } as unknown as CanvasRenderingContext2D;

  const canvas = {
    get clientWidth() {
      return width;
    },
    get clientHeight() {
      return height;
    },
    width: 0,
    height: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
  } as unknown as HTMLCanvasElement;

  vi.stubGlobal('document', { hidden: false, documentElement: {}, ...listen(targets.document) });
  vi.stubGlobal('window', {
    innerWidth: width,
    innerHeight: height,
    ...listen(targets.window),
    matchMedia: (query: string) => ({
      matches: query.includes('reduced-motion') ? reducedMotion : false,
      ...listen(targets.media),
    }),
  });
  vi.stubGlobal('performance', { now: () => clock });
  vi.stubGlobal('requestAnimationFrame', (fn: (now: number) => void) => {
    queued = fn;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    queued = null;
  });
  vi.stubGlobal('ResizeObserver', undefined);
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
      disconnect() {}
    }
  );

  const fire = (type: string, event?: unknown) => {
    for (const fn of [...(targets.window.get(type) ?? [])]) fn(event);
  };

  const pointer = (u: number, v: number, buttons: number) =>
    ({ clientX: u * width, clientY: v * height, buttons, pointerId: 1 }) as PointerEvent;

  return {
    canvas,
    frame() {
      // Well past any frame interval, so nothing is throttled away.
      clock += 200;
      const fn = queued;
      queued = null;
      fn?.(clock);
    },
    greys: () => {
      if (!image) return [];
      const out: number[] = [];
      for (let i = 0; i < image.data.length; i += 4) out.push(image.data[i]);
      return out;
    },
    paints: () => paints,
    resizeTo(nextWidth, nextHeight) {
      width = nextWidth;
      height = nextHeight;
      // The window event rather than a ResizeObserver, which is stubbed away
      // here - the driver falls back to this and it is the path being tested.
      fire('resize');
    },
    press: (u, v) => fire('pointerdown', pointer(u, v, 1)),
    dragTo: (u, v) => fire('pointermove', pointer(u, v, 1)),
    release: () => fire('pointerup', { pointerId: 1 }),
    listeners: () => {
      let total = 0;
      for (const bag of Object.values(targets)) for (const set of bag.values()) total += set.size;
      return total;
    },
  };
}

/** Distinct greys in the last frame - how much of the palette actually reached it. */
const distinct = (greys: number[]) => new Set(greys).size;

/** Every effect, with settings that keep the test quick and repeatable. */
const EFFECTS = [
  {
    name: 'smoke',
    mount: (canvas: HTMLCanvasElement, random: () => number) =>
      createSmokeBackground(canvas, { random, shading: { base: 18, amplitude: 60 }, settleSteps: 8, fps: 20 }),
  },
  {
    name: 'plasma',
    mount: (canvas: HTMLCanvasElement, random: () => number) =>
      createPlasmaBackground(canvas, { random, shading: { base: 18, amplitude: 60 } }),
  },
  {
    name: 'rain',
    mount: (canvas: HTMLCanvasElement, random: () => number) =>
      createRainBackground(canvas, { random, shading: { base: 18, amplitude: 60 }, settleSteps: 8 }),
  },
  {
    name: 'ridges',
    mount: (canvas: HTMLCanvasElement, random: () => number) =>
      createRidgesBackground(canvas, { random, shading: { base: 18, amplitude: 60 } }),
  },
  {
    name: 'metaballs',
    mount: (canvas: HTMLCanvasElement, random: () => number) =>
      createMetaballsBackground(canvas, { random, shading: { base: 18, amplitude: 60 } }),
  },
  {
    name: 'tunnel',
    mount: (canvas: HTMLCanvasElement, random: () => number) =>
      createTunnelBackground(canvas, { random, shading: { base: 18, amplitude: 60 } }),
  },
];

afterEach(() => vi.unstubAllGlobals());

describe.each(EFFECTS)('$name', ({ mount }) => {
  /** Mounts with a seeded generator, so a failure here is reproducible. */
  const start = (dom: Page, seed = 12345): BackgroundHandle => {
    const handle = mount(dom.canvas, makeRandom(seed));
    expect(handle).not.toBeNull();
    return handle!;
  };

  it('paints a first frame on mount', () => {
    // Nothing should have to wait for a second frame to appear: a background that
    // did would flash the page colour on load.
    const dom = page();
    start(dom);
    expect(dom.paints()).toBe(1);
  });

  it('draws something rather than a flat rectangle', () => {
    // The check that catches a field that was allocated but never filled - which
    // is a plain black canvas, and exactly what a missed `render` call looks like.
    const dom = page();
    start(dom);
    expect(distinct(dom.greys())).toBeGreaterThan(1);
  });

  it('fills the canvas it was given', () => {
    const dom = page({ width: 900, height: 600 });
    start(dom);
    // 900x600 at the default 6px cell, or 4px for the line-art effects.
    expect(dom.greys().length).toBe(dom.canvas.width * dom.canvas.height);
    expect(dom.canvas.width).toBeGreaterThan(100);
  });

  it('keeps painting as it runs', () => {
    const dom = page();
    start(dom);

    dom.frame();
    dom.frame();

    expect(dom.paints()).toBe(3);
  });

  it('moves between frames', () => {
    // Every one of these is animated; a field identical across several frames
    // means time is not reaching it.
    const dom = page();
    start(dom);

    const before = dom.greys().join();
    for (let i = 0; i < 12; i++) dom.frame();

    expect(dom.greys().join()).not.toBe(before);
  });

  it('stays inside the palette it was given', () => {
    // `base` and `base + amplitude`, and nothing outside: an effect whose field
    // strays out of 0..1 would clip, and clipping is what a `NaN` looks like too.
    const dom = page();
    start(dom);
    for (let i = 0; i < 6; i++) dom.frame();

    for (const grey of dom.greys()) {
      expect(grey).toBeGreaterThanOrEqual(18);
      expect(grey).toBeLessThanOrEqual(78);
    }
  });

  it('repaints on demand', () => {
    const dom = page();
    const handle = start(dom);
    const painted = dom.paints();

    handle.refresh();

    expect(dom.paints()).toBe(painted + 1);
  });

  it('rebuilds at the new size when the window changes', () => {
    // The path that throws the field away and builds another: a resize changes
    // the cell count, so whatever the effect was holding is the wrong shape now.
    const dom = page({ width: 900, height: 600 });
    start(dom);
    const wide = dom.canvas.width;

    dom.resizeTo(450, 300);

    expect(dom.canvas.width).toBeLessThan(wide);
    expect(dom.greys().length).toBe(dom.canvas.width * dom.canvas.height);
    // Still a picture afterwards, rather than the empty field a `rebuild` that
    // forgot to render would leave behind.
    expect(distinct(dom.greys())).toBeGreaterThan(1);
  });

  it('survives a press and a drag', () => {
    // Each effect interprets a drag differently - stirring, ripples, a grabbed
    // blob - and all that is checked here is that none of them throws or blanks
    // the canvas doing it.
    const dom = page();
    start(dom);

    dom.press(0.5, 0.5);
    dom.dragTo(0.55, 0.5);
    dom.dragTo(0.62, 0.58);
    dom.frame();
    dom.release();
    dom.frame();

    expect(distinct(dom.greys())).toBeGreaterThan(1);
  });

  it('stops when told and starts again', () => {
    const dom = page();
    const handle = start(dom);

    handle.stop();
    const painted = dom.paints();
    dom.frame();
    expect(dom.paints()).toBe(painted);

    handle.start();
    dom.frame();
    expect(dom.paints()).toBeGreaterThan(painted);
  });

  it('removes every listener on destroy', () => {
    const dom = page();
    const handle = start(dom);

    expect(dom.listeners()).toBeGreaterThan(0);
    handle.destroy();

    expect(dom.listeners()).toBe(0);
  });

  it('paints nothing more once destroyed', () => {
    const dom = page();
    const handle = start(dom);
    handle.destroy();
    const painted = dom.paints();

    dom.frame();

    expect(dom.paints()).toBe(painted);
  });

  it('is reproducible from a seeded generator', () => {
    const first = page();
    start(first, 999);
    const a = first.greys().join();

    vi.unstubAllGlobals();
    const second = page();
    start(second, 999);

    expect(second.greys().join()).toBe(a);
  });

  describe('reduced motion', () => {
    it('draws one still frame and no more', () => {
      const dom = page({ reducedMotion: true });
      start(dom);

      dom.frame();
      dom.frame();

      expect(dom.paints()).toBe(1);
    });

    it('draws a still worth looking at', () => {
      // The settling runs exist for this: a single frame of an unsettled effect is
      // fog, or a dry screen, rather than a picture.
      const dom = page({ reducedMotion: true });
      start(dom);

      expect(distinct(dom.greys())).toBeGreaterThan(1);
    });

    it('ignores a pointer entirely', () => {
      const dom = page({ reducedMotion: true });
      start(dom);
      const before = dom.greys().join();

      dom.press(0.5, 0.5);
      dom.dragTo(0.6, 0.6);

      expect(dom.greys().join()).toBe(before);
    });
  });
});

// The shared suite above covers what all six have in common. These are the parts
// that are particular to one effect, and that a generic test cannot reach: the
// branches behind an interaction being held, released and settling back.
describe('effect specifics', () => {
  const shading = { base: 18, amplitude: 60 };

  /** How far apart two frames are, summed over the palette. */
  const differs = (a: number[], b: number[]) => a.join() !== b.join();

  describe('smoke', () => {
    it('fires jets on their own schedule', () => {
      // The default interval is measured in seconds and this test runs for a
      // handful of frames, so the schedule has to be shortened to see it at all.
      const dom = page();
      createSmokeBackground(dom.canvas, {
        random: makeRandom(7),
        shading,
        settleSteps: 4,
        simulation: { jetInterval: 0.05, jetSpeed: 120 },
      });

      const before = dom.greys();
      for (let i = 0; i < 10; i++) dom.frame();

      expect(differs(before, dom.greys())).toBe(true);
    });

    it('stirs when dragged', () => {
      const dom = page();
      createSmokeBackground(dom.canvas, { random: makeRandom(7), shading, settleSteps: 4 });

      // Two runs from the same seed, one of them dragged: the drag has to be what
      // makes them differ, since nothing else does.
      const quiet = page();
      createSmokeBackground(quiet.canvas, { random: makeRandom(7), shading, settleSteps: 4 });

      dom.press(0.3, 0.7);
      for (const u of [0.4, 0.5, 0.6, 0.7]) dom.dragTo(u, 0.7);
      dom.frame();
      quiet.frame();

      expect(differs(dom.greys(), quiet.greys())).toBe(true);
    });

    it('drops strokes rather than letting a stalled drag flood a frame', () => {
      // The cap is on strokes waiting for the next simulation step, and a long
      // stall between pointer events is what fills it.
      const dom = page();
      createSmokeBackground(dom.canvas, { random: makeRandom(7), shading, settleSteps: 4 });

      dom.press(0.05, 0.5);
      for (let i = 0; i < 60; i++) dom.dragTo(0.05 + i * 0.015, 0.5);

      expect(() => dom.frame()).not.toThrow();
      expect(distinct(dom.greys())).toBeGreaterThan(1);
    });
  });

  describe('tunnel', () => {
    it('steers towards the pointer and eases back on release', () => {
      const dom = page();
      createTunnelBackground(dom.canvas, { random: makeRandom(3), shading, steerEase: 0.05 });

      // Held well off centre, so the vanishing point has somewhere to travel.
      dom.press(0.85, 0.2);
      dom.dragTo(0.86, 0.21);
      for (let i = 0; i < 4; i++) dom.frame();
      const steered = dom.greys();

      dom.release();
      for (let i = 0; i < 20; i++) dom.frame();

      // Back on its own drift, which is a different picture from the steered one.
      expect(differs(steered, dom.greys())).toBe(true);
    });

    it('keeps the same corridor across a resize', () => {
      // A rebuild must not reroll the tunnel's state: shrinking the window and
      // growing it back has to land on the picture a never-resized run shows at
      // the same elapsed time, rather than teleport into a fresh corridor.
      const run = (resize: boolean) => {
        const dom = page();
        createTunnelBackground(dom.canvas, { random: makeRandom(3), shading });
        dom.frame();
        if (resize) {
          dom.resizeTo(450, 300);
          dom.resizeTo(900, 600);
        }
        dom.frame();
        return dom.greys().join();
      };

      const steady = run(false);
      vi.unstubAllGlobals();
      expect(run(true)).toBe(steady);
    });

    it('eases the steer the same however the frames are chopped', () => {
      // The steer's blend weight runs on the clock timestep, whose `dt` is
      // whatever the frame rate hands it - so, like the metaballs' throw
      // damping, the ease must land in the same place whether a stretch of time
      // arrives whole or as two halves.
      const run = (gaps: number[]) => {
        const dom = page();
        let queued: ((now: number) => void) | null = null;
        let clock = 1000;
        // Re-stubbed over page()'s own stubs, so each frame's gap - and with it
        // `dt` - can be chosen per run instead of the harness's fixed 200ms.
        vi.stubGlobal('performance', { now: () => clock });
        vi.stubGlobal('requestAnimationFrame', (fn: (now: number) => void) => {
          queued = fn;
          return 1;
        });
        const pump = (gap: number) => {
          clock += gap;
          const fn = queued;
          queued = null;
          fn?.(clock);
        };

        createTunnelBackground(dom.canvas, { random: makeRandom(3), shading, steerEase: 0.15 });
        dom.press(0.85, 0.2);
        dom.dragTo(0.84, 0.21);
        // The first gap only primes the clock - `dt` is zero until there is a
        // previous frame to measure from - so both runs share it.
        pump(50);
        for (const gap of gaps) pump(gap);
        return dom.greys().join();
      };

      const whole = run([100]);
      vi.unstubAllGlobals();
      expect(run([50, 50])).toBe(whole);
    });
  });

  describe('metaballs', () => {
    it('carries a thrown blob on and reels it back', () => {
      const dom = page();
      createMetaballsBackground(dom.canvas, {
        random: makeRandom(11),
        shading,
        metaballs: { grabReach: 2, releaseEase: 0.05 },
      });

      // A wide reach, so the press is certain to catch a blob wherever they were
      // rolled to.
      dom.press(0.5, 0.5);
      for (const u of [0.55, 0.6, 0.65]) dom.dragTo(u, 0.5);
      dom.frame();
      const held = dom.greys();

      dom.release();
      for (let i = 0; i < 20; i++) dom.frame();

      // Settled back onto its own path - the hold has been given up entirely.
      expect(differs(held, dom.greys())).toBe(true);
    });

    it('keeps the same arrangement across a resize', () => {
      // A rebuild must not reroll the arrangement: shrinking the window and
      // growing it back has to land on the picture a never-resized run shows at
      // the same elapsed time, rather than teleport every blob.
      const run = (resize: boolean) => {
        const dom = page();
        createMetaballsBackground(dom.canvas, { random: makeRandom(11), shading });
        dom.frame();
        if (resize) {
          dom.resizeTo(450, 300);
          dom.resizeTo(900, 600);
        }
        dom.frame();
        return dom.greys().join();
      };

      const steady = run(false);
      vi.unstubAllGlobals();
      expect(run(true)).toBe(steady);
    });

    it('eases the grab the same however the frames are chopped', () => {
      // The mount-level mirror of the throw-damping test in metaballs.test.ts:
      // the hold's blend weight runs on the clock timestep, whose `dt` is
      // whatever the frame rate hands it, so the ease must land in the same
      // place whether a stretch of time arrives whole or as two halves.
      const run = (gaps: number[]) => {
        const dom = page();
        let queued: ((now: number) => void) | null = null;
        let clock = 1000;
        // Re-stubbed over page()'s own stubs, so each frame's gap - and with it
        // `dt` - can be chosen per run instead of the harness's fixed 200ms.
        vi.stubGlobal('performance', { now: () => clock });
        vi.stubGlobal('requestAnimationFrame', (fn: (now: number) => void) => {
          queued = fn;
          return 1;
        });
        const pump = (gap: number) => {
          clock += gap;
          const fn = queued;
          queued = null;
          fn?.(clock);
        };

        createMetaballsBackground(dom.canvas, { random: makeRandom(11), shading, metaballs: { grabReach: 2 } });
        dom.press(0.5, 0.5);
        dom.dragTo(0.6, 0.5);
        // The first gap only primes the clock - `dt` is zero until there is a
        // previous frame to measure from - so both runs share it.
        pump(50);
        for (const gap of gaps) pump(gap);
        return dom.greys().join();
      };

      const whole = run([100]);
      vi.unstubAllGlobals();
      expect(run([50, 50])).toBe(whole);
    });

    it('grabs nothing when the press lands on empty space', () => {
      // A miss must leave no residue behind - no phantom hold, no throw that
      // nothing ever advances - so a missed press, drag and release paints
      // exactly what an untouched run paints.
      const run = (touch: boolean) => {
        const dom = page();
        createMetaballsBackground(dom.canvas, {
          random: makeRandom(11),
          shading,
          metaballs: { grabReach: 0.001 },
        });
        if (touch) {
          dom.press(0.02, 0.02);
          dom.dragTo(0.05, 0.03);
        }
        dom.frame();
        if (touch) dom.release();
        dom.frame();
        return dom.greys().join();
      };

      const untouched = run(false);
      vi.unstubAllGlobals();
      expect(run(true)).toBe(untouched);
    });
  });

  describe('plasma', () => {
    /** Spread of a frame's greys about their mean - contrast, whatever the size. */
    const contrast = (greys: number[]) => {
      const mean = greys.reduce((sum, grey) => sum + grey, 0) / greys.length;
      return greys.reduce((sum, grey) => sum + Math.abs(grey - mean), 0) / greys.length;
    };

    it('opens at full contrast rather than fading in from black', () => {
      // The motion blur mixes each frame towards the last, and on mount there is
      // no last: blending against the zeroed buffer used to paint the first
      // frame at a fraction of its real contrast - permanently so under reduced
      // motion, where that frame is the only one. The rebuild now seeds the
      // blur, so the very first paint must already look like a settled one.
      const dom = page();
      createPlasmaBackground(dom.canvas, { random: makeRandom(5), shading });
      const first = contrast(dom.greys());

      for (let i = 0; i < 30; i++) dom.frame();

      // 0.9, not a looser bound: the dither noise on a washed-out frame props
      // its measured spread up to ~0.73 of a settled one, so anything below 0.9
      // would let the bug this exists for straight back through.
      expect(first).toBeGreaterThan(contrast(dom.greys()) * 0.9);
    });

    it('does not dip in contrast across a resize', () => {
      // Every resize rebuilds the field, and a blur restarting from the zeroed
      // buffer there was a visible darkening on every window drag.
      const dom = page();
      createPlasmaBackground(dom.canvas, { random: makeRandom(5), shading });
      for (let i = 0; i < 30; i++) dom.frame();
      const settled = contrast(dom.greys());

      dom.resizeTo(1200, 500);

      // The same 0.9 as the mount test, for the same reason: dither noise makes
      // a washed frame measure ~0.73, and a slacker bound would not catch it.
      expect(contrast(dom.greys())).toBeGreaterThan(settled * 0.9);
    });
  });

  describe.each([
    { name: 'rain', mount: createRainBackground, extra: { settleSteps: 8 } },
    { name: 'ridges', mount: createRidgesBackground, extra: {} },
    { name: 'plasma', mount: createPlasmaBackground, extra: {} },
  ])('$name', ({ mount, extra }) => {
    it('is visibly disturbed by a drag', () => {
      // Same seed, same frames, one of them dragged across.
      const dragged = page();
      mount(dragged.canvas, { random: makeRandom(5), shading, ...extra });
      const quiet = page();
      mount(quiet.canvas, { random: makeRandom(5), shading, ...extra });

      dragged.press(0.2, 0.5);
      for (const u of [0.35, 0.5, 0.65, 0.8]) dragged.dragTo(u, 0.5);

      for (let i = 0; i < 4; i++) {
        dragged.frame();
        quiet.frame();
      }

      expect(differs(dragged.greys(), quiet.greys())).toBe(true);
    });
  });
});
