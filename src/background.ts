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

import { createDragSource, createDriver, prefersReducedMotion, type DragOptions } from './driver';
import { createSurface, defaultShading, sameShading, type BackgroundHandle, type Shading } from './render';

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

  const still = config.respectReducedMotion && prefersReducedMotion();

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
    if (spec.timestep === 'fixed') return 1 / config.fps;

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
  // be dragged is the point, not an oversight.
  const stopDragging = spec.drag && config.interactive && !still ? createDragSource(canvas, spec.drag) : null;

  readShading();
  surface.resize();
  rebuild();
  shade();
  if (!still) driver.start();

  return {
    canvas,
    start() {
      if (still) return;
      lastNow = 0;
      driver.start();
    },
    stop() {
      driver.stop();
      lastNow = 0;
    },
    refresh() {
      readShading();
      shade();
    },
    destroy() {
      driver.destroy();
      stopDragging?.();
      spec.destroy?.();
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
