// The metaballs background: canvas and loop. The implicit surface it draws lives
// in metaballs.ts, and the shading it hands the result to lives in render.ts.
//
// Stateless in time like the plasma: the field is a pure function of elapsed
// time, so a frame can be drawn at any moment without having drawn the ones
// before it. That makes reduced motion a single draw, with no settling run and
// no fixed-timestep dance to keep a stalled tab from lurching.
//
// A smooth field, so it takes the renderer's interpolation and runs at half
// output resolution like the smoke, the plasma and unlike the line-art effects.

import { createDriver, prefersReducedMotion } from './driver';
import { withDefaults } from './options';
import { createSurface, defaultShading, type BackgroundHandle, type Shading } from './render';
import { METABALL_DEFAULTS, createMetaballs, renderMetaballs, type MetaballParams, type Metaballs } from './metaballs';

export interface MetaballsBackgroundOptions {
  /** CSS pixels per rendered pixel - one dither cell. */
  pixelSize: number;
  /** How much coarser the field is than the output, per axis. */
  fieldScale: number;
  /** Ceiling on rendered pixels, so a 4K window is not four times a 1080p one. */
  maxPixels: number;
  /** Ceiling on field cells. */
  maxFieldCells: number;
  /** Redraw rate. */
  fps: number;
  /** Palette size. Small on purpose - the dither is what makes it look smooth. */
  levels: number;
  /** Weights the field towards its dark end. See `darken` in dither.ts. */
  gamma: number;
  /** A multiplier on animation time. */
  speed: number;
  /** The greys the field is mapped onto. A function is re-read on theme changes. */
  shading: Shading | (() => Shading);
  /** Metaball parameters. Anything omitted falls back to `METABALL_DEFAULTS`. */
  metaballs: Partial<MetaballParams>;
  /** Draw one frame and stop when the visitor has asked for less motion. */
  respectReducedMotion: boolean;
  /** Stop the loop while the tab is hidden. */
  pauseWhenHidden: boolean;
  /** Re-read `shading` when the `class` on `<html>` changes. */
  watchThemeClass: boolean;
  /** Re-read `shading` when the OS colour scheme changes. */
  watchColorScheme: boolean;
  /** Source of randomness. Pass a seeded generator for a repeatable arrangement. */
  random: () => number;
}

export const METABALLS_BACKGROUND_DEFAULTS: MetaballsBackgroundOptions = {
  pixelSize: 6,
  fieldScale: 2,
  maxPixels: 160_000,
  // Cheap per cell - the accumulation costs the sum of the ball areas, not
  // cells times balls - so this can be finer than the fluid solver's 8,000.
  maxFieldCells: 40_000,
  fps: 24,
  levels: 5,
  // One. The surface threshold already decides what is dark, and biasing it
  // further only eats the shaded rim the shoulder exists to produce.
  gamma: 1,
  speed: 1,
  shading: defaultShading,
  metaballs: {},
  respectReducedMotion: true,
  pauseWhenHidden: true,
  watchThemeClass: true,
  watchColorScheme: true,
  random: Math.random,
};

/**
 * Mounts the metaballs on a canvas. The canvas keeps whatever size CSS gives it;
 * this only ever sets its backing-store dimensions.
 *
 * Returns null if the browser will not give up a 2D context, which is the one
 * failure worth handling: the page should carry on without a background rather
 * than throw.
 */
export function createMetaballsBackground(
  canvas: HTMLCanvasElement,
  options: Partial<MetaballsBackgroundOptions> = {}
): BackgroundHandle | null {
  const config: MetaballsBackgroundOptions = withDefaults(METABALLS_BACKGROUND_DEFAULTS, options);
  const params: MetaballParams = withDefaults(METABALL_DEFAULTS, config.metaballs);

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;

  const still = config.respectReducedMotion && prefersReducedMotion();

  const surface = createSurface(canvas, ctx, {
    pixelSize: config.pixelSize,
    fieldScale: config.fieldScale,
    maxPixels: config.maxPixels,
    maxFieldCells: config.maxFieldCells,
    levels: config.levels,
  });

  let metaballs: Metaballs | null = null;
  let shading: Shading = { base: 0, amplitude: 0 };
  let elapsed = 0;

  function readShading() {
    shading = typeof config.shading === 'function' ? config.shading() : config.shading;
  }

  function shade() {
    if (metaballs) surface.shade(metaballs.field, shading, config.gamma);
  }

  function rebuild() {
    // The arrangement is rerolled on resize, but `elapsed` carries over so the
    // motion does not jump back to the start on a window drag.
    metaballs = createMetaballs(surface.fieldW, surface.fieldH, config.random, params);
    renderMetaballs(metaballs, params, elapsed);
  }

  let lastNow = 0;

  const driver = createDriver(canvas, {
    fps: config.fps,
    onFrame() {
      const now = performance.now();
      // Accumulated rather than read off the clock, so pausing resumes where it
      // stopped. Clamped, so a backgrounded tab does not lurch on return.
      if (lastNow) elapsed += Math.min(now - lastNow, 100) * 0.001 * config.speed;
      lastNow = now;
      if (metaballs) renderMetaballs(metaballs, params, elapsed);
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
      if (shading.base !== previous.base || shading.amplitude !== previous.amplitude) shade();
    },
    pauseWhenHidden: config.pauseWhenHidden,
    watchThemeClass: config.watchThemeClass,
    watchColorScheme: config.watchColorScheme,
  });

  readShading();
  surface.resize();
  rebuild();
  shade();
  if (!still) driver.start();

  return {
    canvas,
    start() {
      if (!still) {
        // The clock moved on while stopped; do not credit that to the animation.
        lastNow = 0;
        driver.start();
      }
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
      metaballs = null;
    },
  };
}
