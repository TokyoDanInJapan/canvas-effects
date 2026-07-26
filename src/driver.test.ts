// The loop and the listeners. Tested with the DOM stubbed rather than under
// jsdom, because what needs checking is which listeners get added and what they
// do to the loop - a fake that records both says it more directly than a real
// implementation would, and it keeps the suite in the `node` environment the
// rest of the tests run in.
//
// The behaviour these exist for: the driver keeps the host's intent separate
// from whether it is currently drawing. A tab switch must not start a loop
// nobody asked for, which is what `respectReducedMotion` and a deliberate
// `stop()` both depend on.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDragSource, createDriver, prefersReducedMotion, type DragOptions, type DriverOptions } from './driver';

type Listener = (event?: unknown) => void;

/** Listeners added by the driver, so a test can fire them. */
interface Stub {
  document: { hidden: boolean };
  fire(target: 'window' | 'document' | 'media', type: string, event?: unknown): void;
  /** How many listeners are still registered across every target. */
  count(): number;
  frames(): number;
  /** Runs the queued frame callback with a timestamp, as rAF would. */
  advance(now: number): void;
  observed: { resize: number; mutation: number; disconnected: number };
}

function stubDom({ resizeObserver = true, matchMedia = true } = {}): Stub {
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

  const observed = { resize: 0, mutation: 0, disconnected: 0 };

  let queued: ((now: number) => void) | null = null;
  let handle = 0;
  let frames = 0;

  const doc = {
    hidden: false,
    documentElement: {},
    ...listen(targets.document),
  };

  const media = {
    matches: false,
    ...listen(targets.media),
  };

  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', {
    innerWidth: 800,
    innerHeight: 600,
    ...listen(targets.window),
    matchMedia: matchMedia ? () => media : undefined,
  });

  vi.stubGlobal('requestAnimationFrame', (fn: (now: number) => void) => {
    queued = fn;
    frames++;
    return ++handle;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    queued = null;
  });

  vi.stubGlobal(
    'ResizeObserver',
    resizeObserver
      ? class {
          observe() {
            observed.resize++;
          }
          disconnect() {
            observed.disconnected++;
          }
        }
      : undefined
  );

  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {
        observed.mutation++;
      }
      disconnect() {
        observed.disconnected++;
      }
    }
  );

  return {
    document: doc,
    fire(target, type, event) {
      // Copied before iterating: a listener may remove itself or another.
      for (const fn of [...(targets[target].get(type) ?? [])]) fn(event);
    },
    count() {
      let total = 0;
      for (const bag of Object.values(targets)) for (const set of bag.values()) total += set.size;
      return total;
    },
    frames: () => frames,
    advance(now: number) {
      const fn = queued;
      queued = null;
      fn?.(now);
    },
    observed,
  };
}

function options(overrides: Partial<DriverOptions> = {}): DriverOptions {
  return {
    fps: 24,
    onFrame: () => {},
    onResize: () => {},
    onThemeChange: () => {},
    pauseWhenHidden: true,
    watchThemeClass: false,
    watchColorScheme: false,
    ...overrides,
  };
}

const canvas = {} as HTMLCanvasElement;

afterEach(() => vi.unstubAllGlobals());

describe('createDriver', () => {
  it('runs once started and stops once stopped', () => {
    stubDom();
    const driver = createDriver(canvas, options());

    expect(driver.running).toBe(false);
    driver.start();
    expect(driver.running).toBe(true);
    driver.stop();
    expect(driver.running).toBe(false);
  });

  it('is idempotent in both directions', () => {
    const dom = stubDom();
    const driver = createDriver(canvas, options());

    driver.start();
    const after = dom.frames();
    driver.start();
    // A second start must not queue a second frame, or the loop doubles up.
    expect(dom.frames()).toBe(after);

    driver.stop();
    expect(() => driver.stop()).not.toThrow();
    expect(driver.running).toBe(false);
  });

  it('throttles to the target rate rather than the refresh rate', () => {
    const dom = stubDom();
    let drawn = 0;
    const driver = createDriver(canvas, options({ fps: 10, onFrame: () => drawn++ }));

    driver.start();
    // Page-relative timestamps, as rAF gives: mounting happens some way into
    // the page's life, so the first tick is already past the interval.
    dom.advance(1000);
    expect(drawn).toBe(1);

    // 50ms at 10fps is half an interval: the frame is requested but not drawn.
    dom.advance(1050);
    expect(drawn).toBe(1);

    dom.advance(1100);
    expect(drawn).toBe(2);
  });

  it('keeps requesting frames while throttling', () => {
    const dom = stubDom();
    let drawn = 0;
    const driver = createDriver(canvas, options({ fps: 10, onFrame: () => drawn++ }));

    driver.start();
    // A skipped frame must still queue the next one, or the loop dies the first
    // time the refresh rate outpaces the target.
    dom.advance(1000);
    dom.advance(1010);
    expect(drawn).toBe(1);
    expect(driver.running).toBe(true);
    dom.advance(1200);
    expect(drawn).toBe(2);
  });

  describe('a hidden tab', () => {
    it('pauses a running loop and resumes it', () => {
      const dom = stubDom();
      const driver = createDriver(canvas, options());
      driver.start();

      dom.document.hidden = true;
      dom.fire('document', 'visibilitychange');
      expect(driver.running).toBe(false);

      dom.document.hidden = false;
      dom.fire('document', 'visibilitychange');
      expect(driver.running).toBe(true);
    });

    it('does not resume a loop the host stopped', () => {
      const dom = stubDom();
      const driver = createDriver(canvas, options());

      driver.start();
      driver.stop();

      dom.document.hidden = true;
      dom.fire('document', 'visibilitychange');
      dom.document.hidden = false;
      dom.fire('document', 'visibilitychange');

      expect(driver.running).toBe(false);
    });

    it('does not resume a loop that was never started', () => {
      // What reduced motion does: every mount draws one settled frame and
      // leaves the driver alone. A tab switch must not set it going.
      const dom = stubDom();
      const driver = createDriver(canvas, options());

      dom.document.hidden = true;
      dom.fire('document', 'visibilitychange');
      dom.document.hidden = false;
      dom.fire('document', 'visibilitychange');

      expect(driver.running).toBe(false);
    });

    it('defers a start until the tab is shown', () => {
      const dom = stubDom();
      dom.document.hidden = true;
      const driver = createDriver(canvas, options());

      driver.start();
      // Nothing to draw for, but the intent is remembered.
      expect(driver.running).toBe(false);

      dom.document.hidden = false;
      dom.fire('document', 'visibilitychange');
      expect(driver.running).toBe(true);
    });

    it('starts regardless when nothing will ever resume it', () => {
      // Without `pauseWhenHidden` there is no visibility listener, so refusing
      // to start in a background tab would leave it stopped for good.
      const dom = stubDom();
      dom.document.hidden = true;
      const driver = createDriver(canvas, options({ pauseWhenHidden: false }));

      driver.start();
      expect(driver.running).toBe(true);
    });
  });

  describe('resizing', () => {
    it('observes the canvas where ResizeObserver exists', () => {
      const dom = stubDom();
      let resizes = 0;
      createDriver(canvas, options({ onResize: () => resizes++ }));

      expect(dom.observed.resize).toBe(1);
      // The element's own box, not the window: the canvas need not be fullscreen.
      expect(resizes).toBe(0);
    });

    it('falls back to the window event without one', () => {
      const dom = stubDom({ resizeObserver: false });
      let resizes = 0;
      createDriver(canvas, options({ onResize: () => resizes++ }));

      dom.fire('window', 'resize');
      expect(resizes).toBe(1);
    });
  });

  describe('theme changes', () => {
    it('reports a class change on <html> when asked', () => {
      const dom = stubDom();
      createDriver(canvas, options({ watchThemeClass: true }));
      expect(dom.observed.mutation).toBe(1);
    });

    it('reports an OS colour scheme change when asked', () => {
      const dom = stubDom();
      let themes = 0;
      createDriver(canvas, options({ watchColorScheme: true, onThemeChange: () => themes++ }));

      dom.fire('media', 'change');
      expect(themes).toBe(1);
    });

    it('survives a browser without matchMedia', () => {
      stubDom({ matchMedia: false });
      expect(() => createDriver(canvas, options({ watchColorScheme: true }))).not.toThrow();
    });

    it('watches neither by default in these tests', () => {
      const dom = stubDom();
      createDriver(canvas, options());
      expect(dom.observed.mutation).toBe(0);
    });
  });

  describe('destroy', () => {
    it('removes every listener it added', () => {
      const dom = stubDom({ resizeObserver: false });
      const driver = createDriver(
        canvas,
        options({ pauseWhenHidden: true, watchThemeClass: true, watchColorScheme: true })
      );

      expect(dom.count()).toBeGreaterThan(0);
      driver.destroy();
      expect(dom.count()).toBe(0);
      expect(driver.running).toBe(false);
    });

    it('disconnects its observers', () => {
      const dom = stubDom();
      createDriver(canvas, options({ watchThemeClass: true })).destroy();
      // The resize observer and the mutation observer.
      expect(dom.observed.disconnected).toBe(2);
    });

    it('is idempotent', () => {
      stubDom();
      const driver = createDriver(canvas, options());
      driver.destroy();
      expect(() => driver.destroy()).not.toThrow();
    });

    it('leaves a destroyed driver stopped', () => {
      const dom = stubDom();
      const driver = createDriver(canvas, options());
      driver.start();
      driver.destroy();

      // The listener is gone, but fire it anyway: a stale event must not revive it.
      dom.document.hidden = false;
      dom.fire('document', 'visibilitychange');
      expect(driver.running).toBe(false);
    });
  });
});

describe('prefersReducedMotion', () => {
  it('follows the media query', () => {
    stubDom();
    expect(prefersReducedMotion()).toBe(false);
  });

  it('is false where matchMedia is missing', () => {
    stubDom({ matchMedia: false });
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('createDragSource', () => {
  /** A canvas with a known box, so normalised positions are predictable. */
  const boxed = (width = 1000, height = 500) =>
    ({
      getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    }) as unknown as HTMLCanvasElement;

  interface Emission {
    u: number;
    v: number;
    du: number;
    dv: number;
  }

  function source(canvas: HTMLCanvasElement, over: Partial<DragOptions> = {}) {
    const emissions: Emission[] = [];
    let releases = 0;
    const stop = createDragSource(canvas, {
      spacing: 0.02,
      maxPerMove: 12,
      onEmit: (u, v, du, dv) => emissions.push({ u, v, du, dv }),
      onRelease: () => releases++,
      ...over,
    });
    return { emissions, stop, releases: () => releases };
  }

  const down = (x: number, y: number) => ({ clientX: x, clientY: y, buttons: 1 }) as PointerEvent;
  const move = (x: number, y: number, buttons = 1) => ({ clientX: x, clientY: y, buttons }) as PointerEvent;

  it('emits on press, normalised to the canvas box', () => {
    const dom = stubDom();
    const drag = source(boxed(1000, 500));

    dom.fire('window', 'pointerdown', down(250, 100));
    expect(drag.emissions).toEqual([{ u: 0.25, v: 0.2, du: 0, dv: 0 }]);
  });

  it('ignores a canvas with no box to measure against', () => {
    const dom = stubDom();
    const drag = source(boxed(0, 0));

    dom.fire('window', 'pointerdown', down(250, 100));
    expect(drag.emissions).toHaveLength(0);
  });

  it('does not emit on movement without a press', () => {
    // A reader moving the cursor out of the way of the text is not interacting.
    const dom = stubDom();
    const drag = source(boxed());

    dom.fire('window', 'pointermove', move(500, 250));
    expect(drag.emissions).toHaveLength(0);
  });

  describe('walking a drag', () => {
    it('emits every `spacing` along the segment, not only at its end', () => {
      // The behaviour that stops a fast drag coming out dotted: 200px across a
      // canvas whose shorter side is 500 is 20 steps of 0.02, capped at 12.
      const dom = stubDom();
      const drag = source(boxed(1000, 500), { spacing: 0.02, maxPerMove: 12 });

      dom.fire('window', 'pointerdown', down(0, 250));
      dom.fire('window', 'pointermove', move(200, 250));

      expect(drag.emissions.length).toBe(13);
      // Evenly spaced along the way, rather than all at the far end.
      expect(drag.emissions[1].u).toBeCloseTo(0.01, 6);
      expect(drag.emissions[2].u).toBeCloseTo(0.02, 6);
    });

    it('holds the ceiling on one enormous jump', () => {
      const dom = stubDom();
      const drag = source(boxed(1000, 500), { spacing: 0.001, maxPerMove: 4 });

      dom.fire('window', 'pointerdown', down(0, 250));
      dom.fire('window', 'pointermove', move(999, 250));

      expect(drag.emissions.length).toBe(1 + 4);
    });

    it('stays quiet until the pointer has travelled far enough', () => {
      const dom = stubDom();
      const drag = source(boxed(1000, 500), { spacing: 0.1 });

      dom.fire('window', 'pointerdown', down(0, 250));
      // 10px against a 500px shorter side is a fifth of the 50px spacing.
      dom.fire('window', 'pointermove', move(10, 250));
      expect(drag.emissions).toHaveLength(1);
    });

    it('measures from the last emission, not from the last event', () => {
      // 50px of spacing against the 500px shorter side. Moving to 60px emits
      // once and leaves the mark at 50px - where the emission was - rather than
      // at 60px, where the pointer is. So 50px further on is 100px, and an
      // implementation that rounded the remainder away would want 110px and stay
      // silent here.
      const dom = stubDom();
      const drag = source(boxed(1000, 500), { spacing: 0.1 });

      dom.fire('window', 'pointerdown', down(0, 250));
      dom.fire('window', 'pointermove', move(60, 250));
      expect(drag.emissions).toHaveLength(2);

      dom.fire('window', 'pointermove', move(100, 250));
      expect(drag.emissions).toHaveLength(3);
    });
  });

  describe('the step handed to each emission', () => {
    it('is zero on the press', () => {
      const dom = stubDom();
      const drag = source(boxed());

      dom.fire('window', 'pointerdown', down(500, 250));
      expect(drag.emissions[0].du).toBe(0);
      expect(drag.emissions[0].dv).toBe(0);
    });

    it('adds up to the distance travelled, whatever the event rate', () => {
      // The property that makes this usable as an impulse, and the one
      // `movementX` does not have: one coarse event and several fine ones over
      // the same path hand over the same total. Well clear of `maxPerMove`,
      // which truncates a drag by design and so truncates the sum with it.
      const dom = stubDom();
      const settings = { spacing: 0.01, maxPerMove: 100 };

      const coarse = source(boxed(1000, 500), settings);
      dom.fire('window', 'pointerdown', down(0, 250));
      dom.fire('window', 'pointermove', move(100, 250));
      const coarseTotal = coarse.emissions.reduce((sum, e) => sum + e.du, 0);

      const fine = source(boxed(1000, 500), settings);
      dom.fire('window', 'pointerdown', down(0, 250));
      for (const x of [25, 50, 75, 100]) dom.fire('window', 'pointermove', move(x, 250));
      const fineTotal = fine.emissions.reduce((sum, e) => sum + e.du, 0);

      // 100px across a 1000px-wide box is 0.1 normalised.
      expect(coarseTotal).toBeCloseTo(0.1, 6);
      expect(fineTotal).toBeCloseTo(coarseTotal, 6);
    });

    it('is truncated along with the drag when the ceiling bites', () => {
      // Worth stating rather than leaving implied: the ceiling exists to stop one
      // enormous jump flooding a frame, and the cost of that is a shove smaller
      // than the distance dragged.
      const dom = stubDom();
      const drag = source(boxed(1000, 500), { spacing: 0.01, maxPerMove: 4 });

      dom.fire('window', 'pointerdown', down(0, 250));
      dom.fire('window', 'pointermove', move(100, 250));

      const total = drag.emissions.reduce((sum, e) => sum + e.du, 0);
      expect(total).toBeLessThan(0.1);
    });

    it('points along the drag on both axes', () => {
      const dom = stubDom();
      const drag = source(boxed(500, 500), { spacing: 0.1 });

      dom.fire('window', 'pointerdown', down(0, 0));
      dom.fire('window', 'pointermove', move(200, 200));

      const step = drag.emissions[1];
      expect(step.du).toBeGreaterThan(0);
      expect(step.dv).toBeCloseTo(step.du, 6);
    });
  });

  describe('release', () => {
    it('reports a pointer being lifted', () => {
      const dom = stubDom();
      const drag = source(boxed());

      dom.fire('window', 'pointerdown', down(500, 250));
      dom.fire('window', 'pointerup');
      expect(drag.releases()).toBe(1);
    });

    it('reports a cancelled pointer and a lost focus', () => {
      const dom = stubDom();
      for (const type of ['pointercancel', 'blur']) {
        const drag = source(boxed());
        dom.fire('window', 'pointerdown', down(500, 250));
        dom.fire('window', type);
        expect(drag.releases()).toBe(1);
      }
    });

    it('is not reported when no drag was in progress', () => {
      const dom = stubDom();
      const drag = source(boxed());

      dom.fire('window', 'pointerup');
      dom.fire('window', 'blur');
      expect(drag.releases()).toBe(0);
    });

    it('is reported once, however many ways the drag ends', () => {
      const dom = stubDom();
      const drag = source(boxed());

      dom.fire('window', 'pointerdown', down(500, 250));
      dom.fire('window', 'pointerup');
      dom.fire('window', 'pointercancel');
      dom.fire('window', 'blur');
      expect(drag.releases()).toBe(1);
    });

    it('catches a pointerup that happened outside the window', () => {
      // It never reaches us, so the next move with no buttons held has to end
      // the drag - otherwise it stays stuck on for good.
      const dom = stubDom();
      const drag = source(boxed());

      dom.fire('window', 'pointerdown', down(500, 250));
      dom.fire('window', 'pointermove', move(600, 250, 0));
      expect(drag.releases()).toBe(1);

      dom.fire('window', 'pointermove', move(700, 250));
      expect(drag.emissions).toHaveLength(1);
    });

    it('lets go of anything held when the source is torn down', () => {
      const dom = stubDom();
      const drag = source(boxed());

      dom.fire('window', 'pointerdown', down(500, 250));
      drag.stop();
      expect(drag.releases()).toBe(1);
    });
  });

  it('removes every listener it added', () => {
    const dom = stubDom();
    const before = dom.count();
    const drag = source(boxed());

    expect(dom.count()).toBeGreaterThan(before);
    drag.stop();
    expect(dom.count()).toBe(before);
  });
});
