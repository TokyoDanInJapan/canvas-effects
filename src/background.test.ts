// The mount harness. Worth testing directly because there is now exactly one of
// it: every one of the six effects gets its options merged, its surface sized,
// its loop driven and its listeners cleaned up by this code, so a test here is
// six tests.
//
// The DOM is stubbed for the same reasons driver.test.ts stubs it - what matters
// is the sequence of calls made on a canvas and a context, and a fake reports
// that directly.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMON_BACKGROUND_DEFAULTS,
  aspectOf,
  createAgeingList,
  mountBackground,
  type BackgroundSpec,
  type CommonBackgroundOptions,
} from './background';

type Listener = (event?: unknown) => void;

interface Harness {
  canvas: HTMLCanvasElement;
  /** Fires a listener the harness registered. */
  fire(target: 'window' | 'document' | 'media', type: string, event?: unknown): void;
  /** Runs the queued frame callback with a timestamp, as rAF would. */
  advance(now: number): void;
  listeners(): number;
  paints(): number;
  /** Set to false to make the canvas refuse a 2D context. */
  contextAvailable: boolean;
  reducedMotion: boolean;
  resizeTo(width: number, height: number): void;
}

function stub({ cssWidth = 1200, cssHeight = 600 } = {}): Harness {
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

  let paints = 0;
  let queued: ((now: number) => void) | null = null;

  const harness = {
    contextAvailable: true,
    reducedMotion: false,
  } as Harness;

  const ctx = {
    createImageData: (width: number, height: number) =>
      ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData,
    putImageData: () => {
      paints++;
    },
  } as unknown as CanvasRenderingContext2D;

  const canvas = {
    clientWidth: cssWidth,
    clientHeight: cssHeight,
    width: 0,
    height: 0,
    getContext: () => (harness.contextAvailable ? ctx : null),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: cssWidth, height: cssHeight }),
  } as unknown as HTMLCanvasElement;

  vi.stubGlobal('document', { hidden: false, documentElement: {}, ...listen(targets.document) });
  vi.stubGlobal('window', {
    innerWidth: 800,
    innerHeight: 600,
    ...listen(targets.window),
    matchMedia: (query: string) => ({
      matches: query.includes('reduced-motion') ? harness.reducedMotion : false,
      ...listen(targets.media),
    }),
  });
  vi.stubGlobal('performance', { now: () => 1000 });
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

  harness.canvas = canvas;
  harness.fire = (target, type, event) => {
    for (const fn of [...(targets[target].get(type) ?? [])]) fn(event);
  };
  harness.advance = (now) => {
    const fn = queued;
    queued = null;
    fn?.(now);
  };
  harness.listeners = () => {
    let total = 0;
    for (const bag of Object.values(targets)) for (const set of bag.values()) total += set.size;
    return total;
  };
  harness.paints = () => paints;
  harness.resizeTo = (width, height) => {
    (canvas as { clientWidth: number }).clientWidth = width;
    (canvas as { clientHeight: number }).clientHeight = height;
  };

  return harness;
}

function config(over: Partial<CommonBackgroundOptions> = {}): CommonBackgroundOptions {
  return { ...COMMON_BACKGROUND_DEFAULTS, shading: { base: 18, amplitude: 26 }, ...over };
}

/** A spec that records what the harness asked of it. */
function spec(over: Partial<BackgroundSpec> = {}) {
  const calls: string[] = [];
  const steps: number[] = [];
  let field: Float32Array | null = null;
  const sizes: Array<[number, number]> = [];

  const base: BackgroundSpec = {
    maxFieldCells: Infinity,
    gamma: 1,
    timestep: 'fixed',
    rebuild(w, h) {
      calls.push('rebuild');
      sizes.push([w, h]);
      field = new Float32Array(w * h).fill(0.5);
    },
    field: () => field,
    step(dt) {
      calls.push('step');
      steps.push(dt);
    },
    destroy() {
      calls.push('destroy');
    },
    ...over,
  };

  return {
    ...base,
    calls,
    steps,
    sizes,
    reset() {
      calls.length = 0;
      steps.length = 0;
      sizes.length = 0;
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('mountBackground', () => {
  it('returns null when the browser will not give up a 2D context', () => {
    const dom = stub();
    dom.contextAvailable = false;
    // The page should carry on without a background rather than throw.
    expect(mountBackground(dom.canvas, config(), spec())).toBeNull();
  });

  it('builds a field and paints one frame before returning', () => {
    // A background that appeared only on the second frame would flash the page
    // colour on load.
    const dom = stub();
    const effect = spec();

    const handle = mountBackground(dom.canvas, config(), effect)!;

    expect(effect.calls).toEqual(['rebuild']);
    expect(dom.paints()).toBe(1);
    expect(handle.canvas).toBe(dom.canvas);
  });

  it('sizes the field from the surface, not from the CSS box', () => {
    const dom = stub({ cssWidth: 1200, cssHeight: 600 });
    const effect = spec();

    mountBackground(dom.canvas, config({ pixelSize: 6, fieldScale: 2 }), effect);

    // 1200/6 = 200 output pixels, halved again for the field.
    expect(effect.sizes[0]).toEqual([100, 50]);
  });

  it('hands the effect its own field ceiling', () => {
    const dom = stub({ cssWidth: 1920, cssHeight: 1080 });
    const effect = spec({ maxFieldCells: 8_000 });

    mountBackground(dom.canvas, config(), effect);

    const [w, h] = effect.sizes[0];
    expect(w * h).toBeLessThanOrEqual(8_000);
  });

  it('paints nothing when the effect has no field yet', () => {
    const dom = stub();
    mountBackground(dom.canvas, config(), spec({ rebuild: () => {}, field: () => null }));
    expect(dom.paints()).toBe(0);
  });

  describe('the frame loop', () => {
    it('steps and then shades', () => {
      const dom = stub();
      const effect = spec();
      mountBackground(dom.canvas, config(), effect);
      effect.reset();

      dom.advance(2000);

      expect(effect.calls).toEqual(['step']);
      expect(dom.paints()).toBe(2);
    });

    it('runs at a fixed timestep of one frame at the target rate', () => {
      // Frame N is built from frame N-1, so a stalled tab must not resume with
      // one enormous step.
      const dom = stub();
      const effect = spec({ timestep: 'fixed' });
      mountBackground(dom.canvas, config({ fps: 20 }), effect);
      effect.reset();

      dom.advance(5000);
      dom.advance(9000);

      expect(effect.steps).toEqual([0.05, 0.05]);
    });

    it('runs a clock effect off real elapsed seconds', () => {
      const dom = stub();
      const effect = spec({ timestep: 'clock' });
      mountBackground(dom.canvas, config(), effect);
      effect.reset();

      // performance.now is pinned, so the first frame has no previous stamp to
      // measure against and must not invent one.
      dom.advance(2000);
      expect(effect.steps).toEqual([0]);
    });
  });

  describe('resizing', () => {
    it('rebuilds the field when the canvas changes shape', () => {
      const dom = stub({ cssWidth: 1200, cssHeight: 600 });
      const effect = spec();
      mountBackground(dom.canvas, config(), effect);
      effect.reset();

      dom.resizeTo(600, 300);
      dom.fire('window', 'resize');

      expect(effect.calls).toEqual(['rebuild']);
      expect(effect.sizes[0]).toEqual([50, 25]);
    });

    it('repaints without rebuilding when the shape holds', () => {
      // Throwing a simulation away on every scroll-driven resize event would be
      // visible as a stutter.
      const dom = stub();
      const effect = spec();
      mountBackground(dom.canvas, config(), effect);
      effect.reset();
      const painted = dom.paints();

      dom.fire('window', 'resize');

      expect(effect.calls).toEqual([]);
      expect(dom.paints()).toBe(painted + 1);
    });
  });

  describe('theme changes', () => {
    it('re-reads a shading callback and repaints when it differs', () => {
      const dom = stub();
      let dark = false;
      const effect = spec();
      mountBackground(
        dom.canvas,
        config({
          watchColorScheme: true,
          shading: () => (dark ? { base: 18, amplitude: 26 } : { base: 255, amplitude: -22 }),
        }),
        effect
      );
      const painted = dom.paints();

      dark = true;
      dom.fire('media', 'change');

      expect(dom.paints()).toBe(painted + 1);
    });

    it('repaints nothing when the shading has not moved', () => {
      // Most class changes on <html> have nothing to do with the canvas.
      const dom = stub();
      mountBackground(
        dom.canvas,
        config({ watchColorScheme: true, shading: () => ({ base: 18, amplitude: 26 }) }),
        spec()
      );
      const painted = dom.paints();

      dom.fire('media', 'change');

      expect(dom.paints()).toBe(painted);
    });

    it('repaints on a ramp change that keeps the page colour', () => {
      // The bug that prompted `sameShading`: a dark page swapping its accent
      // keeps `base` and `amplitude` and changes everything visible.
      const dom = stub();
      let accent: [number, number, number] = [190, 66, 8];
      mountBackground(
        dom.canvas,
        config({
          watchColorScheme: true,
          shading: () => ({ base: 18, amplitude: 0, ramp: [[18, 18, 18], accent] }),
        }),
        spec()
      );
      const painted = dom.paints();

      accent = [22, 122, 46];
      dom.fire('media', 'change');

      expect(dom.paints()).toBe(painted + 1);
    });

    it('repaints on demand through refresh', () => {
      const dom = stub();
      const handle = mountBackground(dom.canvas, config(), spec())!;
      const painted = dom.paints();

      handle.refresh();

      // Unconditional, unlike a theme change: the caller has said something
      // changed that we have no way to compare.
      expect(dom.paints()).toBe(painted + 1);
    });
  });

  describe('reduced motion', () => {
    it('draws one frame and starts no loop', () => {
      const dom = stub();
      dom.reducedMotion = true;
      const effect = spec();

      mountBackground(dom.canvas, config(), effect);

      expect(effect.calls).toEqual(['rebuild']);
      expect(dom.paints()).toBe(1);
    });

    it('refuses to start even when asked', () => {
      const dom = stub();
      dom.reducedMotion = true;
      const effect = spec();
      const handle = mountBackground(dom.canvas, config(), effect)!;
      effect.reset();

      handle.start();
      dom.advance(2000);

      expect(effect.calls).toEqual([]);
    });

    it('wires up no pointer handling', () => {
      const dom = stub();
      dom.reducedMotion = true;
      let emissions = 0;
      mountBackground(
        dom.canvas,
        config(),
        spec({ drag: { spacing: 0.02, maxPerMove: 4, onEmit: () => emissions++ } })
      );

      dom.fire('window', 'pointerdown', { clientX: 10, clientY: 10, buttons: 1 });
      expect(emissions).toBe(0);
    });

    it('animates as usual when the visitor has not asked for less', () => {
      const dom = stub();
      dom.reducedMotion = true;
      const effect = spec();
      // Opting out of the courtesy is the host's call to make.
      mountBackground(dom.canvas, config({ respectReducedMotion: false }), effect);
      effect.reset();

      dom.advance(2000);
      expect(effect.calls).toEqual(['step']);
    });
  });

  describe('pointer handling', () => {
    it('is wired up when the effect asks for it', () => {
      const dom = stub();
      let emissions = 0;
      mountBackground(
        dom.canvas,
        config(),
        spec({ drag: { spacing: 0.02, maxPerMove: 4, onEmit: () => emissions++ } })
      );

      dom.fire('window', 'pointerdown', { clientX: 10, clientY: 10, buttons: 1 });
      expect(emissions).toBe(1);
    });

    it('is left alone when the host has switched it off', () => {
      const dom = stub();
      let emissions = 0;
      mountBackground(
        dom.canvas,
        config({ interactive: false }),
        spec({ drag: { spacing: 0.02, maxPerMove: 4, onEmit: () => emissions++ } })
      );

      dom.fire('window', 'pointerdown', { clientX: 10, clientY: 10, buttons: 1 });
      expect(emissions).toBe(0);
    });

    it('adds no listeners for an effect with nothing to disturb', () => {
      const dom = stub();
      const before = dom.listeners();
      mountBackground(dom.canvas, config(), spec({ drag: undefined }));
      const withoutDrag = dom.listeners() - before;

      vi.unstubAllGlobals();
      const other = stub();
      const beforeOther = other.listeners();
      mountBackground(other.canvas, config(), spec({ drag: { spacing: 0.02, maxPerMove: 4, onEmit: () => {} } }));

      expect(other.listeners() - beforeOther).toBeGreaterThan(withoutDrag);
    });
  });

  describe('start and stop', () => {
    it('stops and restarts the loop', () => {
      const dom = stub();
      const effect = spec();
      const handle = mountBackground(dom.canvas, config(), effect)!;

      handle.stop();
      effect.reset();
      dom.advance(2000);
      expect(effect.calls).toEqual([]);

      handle.start();
      dom.advance(3000);
      expect(effect.calls).toEqual(['step']);
    });

    it('does not credit a clock effect with the time it spent stopped', () => {
      // Otherwise a background stopped for a minute would jump a minute forward
      // the moment it was started again.
      const dom = stub();
      const effect = spec({ timestep: 'clock' });
      const handle = mountBackground(dom.canvas, config(), effect)!;

      dom.advance(2000);
      handle.stop();
      handle.start();
      effect.reset();
      dom.advance(3000);

      expect(effect.steps).toEqual([0]);
    });
  });

  describe('destroy', () => {
    it('tells the effect and removes every listener', () => {
      const dom = stub();
      const effect = spec({ drag: { spacing: 0.02, maxPerMove: 4, onEmit: () => {} } });
      const handle = mountBackground(dom.canvas, config({ watchColorScheme: true }), effect)!;
      effect.reset();

      expect(dom.listeners()).toBeGreaterThan(0);
      handle.destroy();

      expect(effect.calls).toEqual(['destroy']);
      expect(dom.listeners()).toBe(0);
    });

    it('leaves the loop stopped', () => {
      const dom = stub();
      const effect = spec();
      const handle = mountBackground(dom.canvas, config(), effect)!;

      handle.destroy();
      effect.reset();
      dom.advance(2000);

      expect(effect.calls).toEqual([]);
    });

    it('is idempotent', () => {
      const dom = stub();
      const handle = mountBackground(dom.canvas, config(), spec())!;
      handle.destroy();
      expect(() => handle.destroy()).not.toThrow();
    });
  });
});

describe('createAgeingList', () => {
  interface Thing extends Record<string, unknown> {
    age: number;
    id: number;
  }

  const thing = (id: number): Thing => ({ age: 0, id });

  it('starts empty', () => {
    expect(createAgeingList<Thing>(4, 1).items).toHaveLength(0);
  });

  it('keeps what it is given, oldest first', () => {
    const list = createAgeingList<Thing>(4, 1);
    list.add(thing(1));
    list.add(thing(2));
    expect(list.items.map((t) => t.id)).toEqual([1, 2]);
  });

  it('retires the oldest at the cap, not the newest', () => {
    // The distinction that makes a drag feel alive: dropping the newest means an
    // ongoing drag goes dead the moment the cap is reached.
    const list = createAgeingList<Thing>(2, 1);
    list.add(thing(1));
    list.add(thing(2));
    list.add(thing(3));

    expect(list.items.map((t) => t.id)).toEqual([2, 3]);
  });

  it('ages everything it holds', () => {
    const list = createAgeingList<Thing>(4, 10);
    list.add(thing(1));
    list.advance(0.5);
    list.advance(0.25);
    expect(list.items[0].age).toBeCloseTo(0.75, 6);
  });

  it('drops what has outlived its lifetime', () => {
    const list = createAgeingList<Thing>(4, 1);
    list.add(thing(1));
    list.advance(0.9);
    expect(list.items).toHaveLength(1);
    list.advance(0.2);
    expect(list.items).toHaveLength(0);
  });

  it('drops several at once without skipping any', () => {
    // The reverse loop exists for this: expiring one shortens the list under it.
    const list = createAgeingList<Thing>(8, 1);
    for (let i = 0; i < 5; i++) list.add(thing(i));
    list.advance(2);
    expect(list.items).toHaveLength(0);
  });

  it('keeps the young while dropping the old', () => {
    const list = createAgeingList<Thing>(8, 1);
    list.add(thing(1));
    list.advance(0.8);
    list.add(thing(2));
    list.advance(0.4);

    expect(list.items.map((t) => t.id)).toEqual([2]);
  });

  it('clears on demand', () => {
    const list = createAgeingList<Thing>(4, 1);
    list.add(thing(1));
    list.clear();
    expect(list.items).toHaveLength(0);
  });
});

describe('aspectOf', () => {
  it('divides width by height', () => {
    expect(aspectOf({ w: 200, h: 100 })).toBe(2);
  });

  it('falls back to square rather than returning Infinity', () => {
    // A field with no height would otherwise take a frame's worth of positions
    // down with it.
    expect(aspectOf({ w: 200, h: 0 })).toBe(1);
  });
});
