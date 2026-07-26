// The ridgeline background: canvas and loop. The landscape it draws lives in
// ridges.ts, and the shading it hands the result to lives in render.ts.
//
// Unlike the smoke and the rain this normally carries no history: the field is a
// pure function of how far we have flown, so it can be drawn at any moment. The
// only state is `travel`, which is a number rather than a simulation. That makes
// the reduced-motion path a single draw.
//
// The exception is `ridges.trail`. Above zero, each frame starts from the last
// one faded and the field does depend on history - so a still frame under
// reduced motion shows no trail, which is correct for a still.

import { createDriver, prefersReducedMotion } from './driver';
import { withDefaults } from './options';
import { createSurface, defaultShading, type BackgroundHandle, type Shading } from './render';
import { RIDGE_DEFAULTS, createRidges, renderRidges, stepRidges, type RidgeParams, type Ridges } from './ridges';

export interface RidgesBackgroundOptions {
  /** CSS pixels per rendered pixel - one dither cell, and one line thickness. */
  pixelSize: number;
  /**
   * How much coarser the field is than the output, per axis.
   *
   * **One, like the rain and unlike the field effects.** `shade` interpolates
   * bilinearly between cells, which smooths a continuous field and smears line
   * art. At a scale of one each output pixel maps to exactly one cell, so the
   * lines stay one pixel wide and crisp.
   */
  fieldScale: number;
  /** Ceiling on rendered pixels, so a 4K window is not four times a 1080p one. */
  maxPixels: number;
  /** Ceiling on field cells. Matched to `maxPixels`, so it never interpolates. */
  maxFieldCells: number;
  /** Redraw rate. The timestep is `1 / fps`, fixed. */
  fps: number;
  /** Palette size. Lines are drawn at full brightness; this shades the haze. */
  levels: number;
  /** Ordered-dither the output. Off posterises flat, showing the bands. */
  dither: boolean;
  /**
   * Weights the field towards its dark end. One by default: the field is
   * already mostly empty, and biasing it would only dim the distant rows the
   * depth fade has already dimmed.
   */
  gamma: number;
  /** The greys the field is mapped onto. A function is re-read on theme changes. */
  shading: Shading | (() => Shading);
  /** Landscape parameters. Anything omitted falls back to `RIDGE_DEFAULTS`. */
  ridges: Partial<RidgeParams>;
  /** Draw one frame and stop when the visitor has asked for less motion. */
  respectReducedMotion: boolean;
  /** Stop the loop while the tab is hidden. */
  pauseWhenHidden: boolean;
  /** Re-read `shading` when the `class` on `<html>` changes. */
  watchThemeClass: boolean;
  /** Re-read `shading` when the OS colour scheme changes. */
  watchColorScheme: boolean;
  /** Source of randomness. Pass a seeded generator for a repeatable landscape. */
  random: () => number;
}

export const RIDGES_BACKGROUND_DEFAULTS: RidgesBackgroundOptions = {
  // Four, not the six the others use. This is line art, and a line is one cell
  // wide: at six the lines are thick relative to the gaps between rows and the
  // stack reads as static. Four still clears the pixel ceiling at 1080p
  // (480x270 = 129,600 against a 160,000 cap).
  pixelSize: 4,
  fieldScale: 1,
  maxPixels: 160_000,
  maxFieldCells: 160_000,
  fps: 24,
  levels: 5,
  dither: true,
  gamma: 1,
  shading: defaultShading,
  ridges: {},
  respectReducedMotion: true,
  pauseWhenHidden: true,
  watchThemeClass: true,
  watchColorScheme: true,
  random: Math.random,
};

/**
 * Mounts the ridgeline landscape on a canvas. The canvas keeps whatever size
 * CSS gives it; this only ever sets its backing-store dimensions.
 *
 * Returns null if the browser will not give up a 2D context, which is the one
 * failure worth handling: the page should carry on without a background rather
 * than throw.
 */
export function createRidgesBackground(
  canvas: HTMLCanvasElement,
  options: Partial<RidgesBackgroundOptions> = {}
): BackgroundHandle | null {
  const config: RidgesBackgroundOptions = withDefaults(RIDGES_BACKGROUND_DEFAULTS, options);
  const params: RidgeParams = withDefaults(RIDGE_DEFAULTS, config.ridges);

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;

  const still = config.respectReducedMotion && prefersReducedMotion();
  const dt = 1 / config.fps;

  const surface = createSurface(canvas, ctx, {
    pixelSize: config.pixelSize,
    fieldScale: config.fieldScale,
    maxPixels: config.maxPixels,
    maxFieldCells: config.maxFieldCells,
    levels: config.levels,
    dither: config.dither,
  });

  let ridges: Ridges | null = null;
  let shading: Shading = { base: 0, amplitude: 0 };

  function readShading() {
    shading = typeof config.shading === 'function' ? config.shading() : config.shading;
  }

  function shade() {
    if (ridges) surface.shade(ridges.field, shading, config.gamma);
  }

  function rebuild() {
    // A resize changes the field, but not where we are: `travel` is carried
    // over so the flight does not jump back to the start on a window drag.
    const travel = ridges?.travel ?? 0;
    const state = ridges?.state;
    ridges = createRidges(surface.fieldW, surface.fieldH, config.random);
    ridges.travel = travel;
    // Same landscape, too - only the resolution it is drawn at has changed.
    if (state) ridges.state = state;
    renderRidges(ridges, params);
  }

  const driver = createDriver(canvas, {
    fps: config.fps,
    onFrame() {
      if (ridges) stepRidges(ridges, params, dt);
      shade();
    },
    onResize() {
      if (surface.resize()) rebuild();
      shade();
    },
    onThemeChange() {
      const previous = shading;
      readShading();
      // The landscape has not changed, only what greys it maps onto.
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
      if (!still) driver.start();
    },
    stop: driver.stop,
    refresh() {
      readShading();
      shade();
    },
    destroy() {
      driver.destroy();
      ridges = null;
    },
  };
}
