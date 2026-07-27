// What every background here does identically, in one place.
//
// Each of the six effects differs in three ways and three only: what its field
// is, how time reaches it, and what a pointer does to it. Everything else - the
// options, the context, the surface, the loop, the theme watching, the boot
// sequence, the handle - was the same code six times over, which is six places
// to fix anything found in it. It was found: a theme change that only altered a
// ramp repainted nothing, in all six copies at once.
//
// So an effect supplies a `BackgroundSpec` and this owns the rest. A mount file
// is then its own options, its own defaults, and a spec - which is the part that
// is genuinely about smoke, or rain, or a tunnel.
//
// It is exported because writing a seventh effect should not mean writing this
// again. Hand it a field and it will size it, shade it, animate it and clean up
// after it.

import { createDragSource, createDriver, prefersReducedMotion, type DragOptions } from './driver.js';
import { createSurface, defaultShading, sameShading, type BackgroundHandle, type Shading } from './render.js';

/**
 * The options every background takes, whatever it draws.
 *
 * Each effect's own options interface extends this and adds what is particular
 * to it. Several of them also re-declare a field to document it differently -
 * `fieldScale` means something rather different to a fluid than to line art, and
 * the sensible default differs with it - which is worth the repetition, because
 * the doc comment is where anyone tuning one of these actually reads.
 */
export interface CommonBackgroundOptions {
  /** CSS pixels per rendered pixel - one dither cell. Bigger is coarser and cheaper. */
  pixelSize: number;
  /** How much coarser the field is than the output, per axis. */
  fieldScale: number;
  /** Ceiling on rendered pixels, so a 4K window is not four times a 1080p one. */
  maxPixels: number;
  /** Redraw rate. Well below the refresh rate on purpose. */
  fps: number;
  /** Palette size. Small on purpose - the dither is what makes it look smooth. */
  levels: number;
  /** Ordered-dither the output. Off posterises flat, showing the bands. */
  dither: boolean;
  /** Weights the field towards its dark end. See `darken` in dither.ts. */
  gamma: number;
  /** The greys the field is mapped onto. A function is re-read on theme changes. */
  shading: Shading | (() => Shading);
  /**
   * Let a press or drag disturb the effect.
   *
   * Listened for on the window rather than the canvas: a background canvas is
   * `pointer-events: none` so that it never intercepts anything meant for the
   * page, which also means it never sees a pointer itself.
   */
  interactive: boolean;
  /** Draw one frame and stop when the visitor has asked for less motion. */
  respectReducedMotion: boolean;
  /** Stop the loop while the tab is hidden. */
  pauseWhenHidden: boolean;
  /** Re-read `shading` when the `class` on `<html>` changes. */
  watchThemeClass: boolean;
  /** Re-read `shading` when the OS colour scheme changes. */
  watchColorScheme: boolean;
  /** Source of randomness. Pass a seeded generator for a repeatable background. */
  random: () => number;
}

/**
 * The shared half of every effect's defaults.
 *
 * Each effect spreads this and overrides what it needs, so a value here is one
 * that genuinely suits all six rather than one nobody revisited. Where an effect
 * differs - the line-art effects want `fieldScale: 1`, the field effects want a
 * gamma above 1 - it says so, with the reasoning, at the override.
 */
export const COMMON_BACKGROUND_DEFAULTS: CommonBackgroundOptions = {
  pixelSize: 6,
  fieldScale: 2,
  maxPixels: 160_000,
  fps: 24,
  levels: 5,
  dither: true,
  gamma: 1,
  shading: defaultShading,
  interactive: true,
  respectReducedMotion: true,
  pauseWhenHidden: true,
  watchThemeClass: true,
  watchColorScheme: true,
  random: Math.random,
};

/**
 * How time reaches an effect.
 *
 * `'fixed'` hands `step` exactly `1 / fps` every drawn frame, whatever the clock
 * says. That is what a stateful effect needs: frame N is built from frame N-1, so
 * a stalled tab that resumed with one enormous step would lurch. A slow frame
 * makes the smoke drift slower, never further.
 *
 * `'clock'` hands over the real elapsed seconds, clamped to 100ms for the same
 * reason and accumulated rather than read off the clock, so that stopping and
 * starting resumes where it left off instead of jumping. That suits an effect
 * whose field is a pure function of time.
 */
export type Timestep = 'fixed' | 'clock';

/** What an effect has to supply for the harness to run it. */
export interface BackgroundSpec {
  /**
   * Ceiling on field cells - a much harder limit than the pixel one for anything
   * that touches each cell more than once. `Infinity` to let it scale freely.
   */
  maxFieldCells: number;
  /**
   * The gamma to shade with, which is not always the configured one: an effect
   * that biases its field as it builds it - the plasma does, so that its motion
   * blur carries the biased value forward - has to pass 1 here or the bias is
   * applied twice.
   */
  gamma: number;
  /** How `step` is given its `dt`. See `Timestep`. */
  timestep: Timestep;
  /**
   * Build a field for a new size. Called once before the first paint and again
   * whenever the canvas changes shape.
   *
   * This is where an effect settles itself, if it needs to: resizing throws the
   * old field away, and opening on an unmoved one looks wrong.
   */
  rebuild(fieldW: number, fieldH: number): void;
  /** The field to paint, or null before the first `rebuild`. */
  field(): Float32Array | null;
  /** Advance by `dt` seconds and leave the field ready to paint. */
  step(dt: number): void;
  /** Pointer handling, if the effect has any. Only wired up when allowed. */
  drag?: DragOptions;
  /** Anything the effect wants to let go of on teardown. */
  destroy?(): void;
}

/**
 * Mounts an effect on a canvas: sizes it, shades it, animates it, watches the
 * theme, and hands back the handle that tears all of it down again.
 *
 * The canvas keeps whatever size CSS gives it; this only ever sets its
 * backing-store dimensions.
 *
 * Returns null if the browser will not give up a 2D context, which is the one
 * failure worth handling here: the page should carry on without a background
 * rather than throw.
 */
export function mountBackground(
  canvas: HTMLCanvasElement,
  config: CommonBackgroundOptions,
  spec: BackgroundSpec
): BackgroundHandle | null {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;

  let still = config.respectReducedMotion && prefersReducedMotion();

  // Whether the *host* wants the animation, as distinct from whether reduced
  // motion currently permits it. Mounting implies wanting; only the handle's
  // own `stop` withdraws it. Kept here rather than leaning on the driver's
  // notion, because the driver forgets intent when reduced motion stops it.
  let hostWants = true;

  const surface = createSurface(canvas, ctx, {
    pixelSize: config.pixelSize,
    fieldScale: config.fieldScale,
    maxPixels: config.maxPixels,
    maxFieldCells: spec.maxFieldCells,
    levels: config.levels,
    dither: config.dither,
  });

  let shading: Shading = { base: 0, amplitude: 0 };

  function readShading() {
    shading = typeof config.shading === 'function' ? config.shading() : config.shading;
  }

  function shade() {
    const field = spec.field();
    if (field) surface.shade(field, shading, spec.gamma);
  }

  function rebuild() {
    spec.rebuild(surface.fieldW, surface.fieldH);
  }

  // Real time, for a `'clock'` effect. Zeroed on every stop, so the time a
  // stopped background spent stopped is not credited to its animation.
  let lastNow = 0;

  /** Seconds to advance by on this frame. */
  function elapse(): number {
    // The same guard the driver applies: a non-positive rate would hand a
    // fixed-step effect an infinite dt.
    if (spec.timestep === 'fixed') return 1 / (config.fps > 0 ? config.fps : 1);

    const now = performance.now();
    // Clamped, so a backgrounded tab does not lurch on return.
    const dt = lastNow ? Math.min(now - lastNow, 100) * 0.001 : 0;
    lastNow = now;
    return dt;
  }

  const driver = createDriver(canvas, {
    fps: config.fps,
    onFrame() {
      spec.step(elapse());
      shade();
    },
    onResize() {
      if (surface.resize()) rebuild();
      shade();
    },
    onThemeChange() {
      const previous = shading;
      readShading();
      // The field has not changed, only what greys it maps onto.
      if (!sameShading(shading, previous)) shade();
    },
    pauseWhenHidden: config.pauseWhenHidden,
    watchThemeClass: config.watchThemeClass,
    watchColorScheme: config.watchColorScheme,
  });

  // Reduced motion gets one still frame and no listeners: an effect that cannot
  // be dragged is the point, not an oversight. Wired lazily, because reduced
  // motion is a live preference rather than a fact about the mount - see below.
  let stopDragging: (() => void) | null = null;

  function wireDrag() {
    if (!stopDragging && spec.drag && config.interactive && !still) {
      stopDragging = createDragSource(canvas, spec.drag);
    }
  }

  function unwireDrag() {
    stopDragging?.();
    stopDragging = null;
  }

  // The preference is watched, not sampled once: a visitor who turns reduced
  // motion off after the page loads used to get a permanently frozen background
  // with no recovery short of remounting, because `start()` kept refusing.
  // The colour scheme already gets a listener; motion deserves the same.
  let unwatchMotion: (() => void) | null = null;
  if (config.respectReducedMotion && typeof window.matchMedia === 'function') {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotionChange = () => {
      // Sampled fresh rather than read off `query`: the one moment this runs is
      // the moment the cached `matches` stops being true.
      still = prefersReducedMotion();
      if (still) {
        unwireDrag();
        driver.stop();
      } else {
        wireDrag();
        if (hostWants) {
          lastNow = 0;
          driver.start();
        }
      }
    };
    query.addEventListener('change', onMotionChange);
    unwatchMotion = () => query.removeEventListener('change', onMotionChange);
  }

  readShading();
  surface.resize();
  rebuild();
  shade();
  wireDrag();
  if (!still) driver.start();

  return {
    canvas,
    start() {
      hostWants = true;
      if (still) return;
      lastNow = 0;
      driver.start();
    },
    stop() {
      hostWants = false;
      driver.stop();
      lastNow = 0;
    },
    refresh() {
      readShading();
      shade();
    },
    destroy() {
      driver.destroy();
      unwatchMotion?.();
      unwireDrag();
      spec.destroy?.();
    },
    get running() {
      return driver.running;
    },
    get still() {
      return still;
    },
  };
}

/** Something a pointer left behind that fades on its own. */
export interface Ageing {
  age: number;
}

/**
 * A list of live disturbances - ripples, wobbles, droplet distortions - that age
 * in real seconds and retire on their own.
 *
 * At the cap the *oldest* is retired to make room, rather than the newest being
 * dropped. That distinction is what makes a drag feel alive: dropping the newest
 * means an ongoing drag stops producing anything the moment the cap is reached,
 * which reads as the effect having died.
 */
export interface AgeingList<T extends Ageing> {
  /** The live items, oldest first. Safe to read every frame; do not mutate. */
  readonly items: readonly T[];
  /** Adds one, retiring the oldest if the list is full. */
  add(item: T): void;
  /** Ages everything by `dt` seconds and drops whatever has expired. */
  advance(dt: number): void;
  /** Drops everything. */
  clear(): void;
}

export function createAgeingList<T extends Ageing>(max: number, lifetime: number): AgeingList<T> {
  const items: T[] = [];

  return {
    items,
    add(item) {
      if (items.length >= max) items.shift();
      items.push(item);
    },
    advance(dt) {
      // Backwards, because expiring one shortens the list under the loop.
      for (let i = items.length - 1; i >= 0; i--) {
        items[i].age += dt;
        if (items[i].age >= lifetime) items.splice(i, 1);
      }
    },
    clear() {
      items.length = 0;
    },
  };
}

/**
 * The aspect ratio of a field, for effects that think in units of its height.
 *
 * Guarded, because a field with no height would otherwise hand back `Infinity`
 * or `NaN` and take a whole frame's worth of positions with it.
 */
export function aspectOf(field: { w: number; h: number }): number {
  return field.h > 0 ? field.w / field.h : 1;
}

/**
 * The distance between adjacent cell centres of a field, per axis, in the unit
 * square the field effects position things in - `[0, aspect] x [0, 1]`.
 *
 * Guarded for a single-cell axis, which would otherwise divide by zero; a zero
 * span is the callers' cue to take a whole axis rather than compute a range.
 * The guards are the subtle part, which is why this exists once rather than
 * being re-derived next to each render loop.
 */
export function cellSpansOf(field: { w: number; h: number }): [number, number] {
  const aspect = aspectOf(field);
  return [field.w > 1 ? aspect / (field.w - 1) : 0, field.h > 1 ? 1 / (field.h - 1) : 0];
}

/**
 * Moves `current` towards `target` the way a first-order lag does, sized to
 * `dt` so the ease's speed does not depend on the frame rate: two half-steps
 * land exactly where one whole step does. `rate` is the time constant, roughly
 * the seconds a step takes to cover its first 63%.
 *
 * The naive `current + (target - current) * (dt / rate)` is not this - its
 * speed varies with how `dt` happens to be chopped up, and it snaps rather
 * than eases the moment `dt` outgrows `rate`.
 */
export function approach(current: number, target: number, dt: number, rate: number): number {
  if (dt <= 0) return current;
  if (rate <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dt / rate));
}

/**
 * The strength, 0..1, of an expanding Gaussian ring at `distance` from its
 * centre: a band about the radius the ring has grown to by `age`, thinning as
 * the square of remaining life so it dies away rather than stopping abruptly.
 *
 * This is the one disturbance shape the pointer leaves behind - the plasma's
 * ripples and the rain's lens distortions are both it - and each effect keeps
 * only its own coordinate space and strength scaling around this.
 */
export function ringPulse(distance: number, age: number, speed: number, width: number, lifetime: number): number {
  if (age < 0 || age >= lifetime) return 0;
  const offset = (distance - age * speed) / width;
  const fade = 1 - age / lifetime;
  return Math.exp(-offset * offset) * fade * fade;
}
