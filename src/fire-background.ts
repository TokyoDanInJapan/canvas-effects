// The fire background: canvas and loop. The heat field it draws lives in
// fire.ts, and the shading it hands the result to lives in render.ts.
//
// Stateful like the smoke and the rain: each frame's heat is the last frame's,
// climbed and cooled. So the timestep is fixed per drawn frame rather than
// taken from the clock, and reduced motion is served by burning it up to a
// steady state once and then leaving it alone.
//
// The heat field is continuous, so unlike the rain and the ridges it could take
// the renderer's interpolation - but it is run at full output resolution anyway.
// Measured both ways: at half resolution the interpolation smooths out exactly
// the fine tongue structure that distinguishes fire from a glow, and a cell here
// is cheap enough (two passes of a few operations) to afford the finer grid.

import { createDragSource, createDriver, prefersReducedMotion } from './driver';
import { withDefaults } from './options';
import { createSurface, defaultShading, type BackgroundHandle, type Shading } from './render';
import { FIRE_DEFAULTS, applySpark, createFire, stepFire, type Fire, type FireParams, type Spark } from './fire';

export interface FireBackgroundOptions {
  /** CSS pixels per rendered pixel - one dither cell. */
  pixelSize: number;
  /**
   * How much coarser the field is than the output, per axis.
   *
   * One, unlike the smoke and plasma. Not for crispness as with the rain and
   * ridges - the heat field is continuous and interpolates fine - but because
   * interpolating it smooths away the fine tongue structure that makes fire
   * read as fire rather than as a glow.
   */
  fieldScale: number;
  /** Ceiling on rendered pixels, so a 4K window is not four times a 1080p one. */
  maxPixels: number;
  /** Ceiling on field cells. */
  maxFieldCells: number;
  /** Redraw rate. The timestep is `1 / fps`, fixed. */
  fps: number;
  /** Palette size. Small on purpose - the dither is what makes it look smooth. */
  levels: number;
  /** Ordered-dither the output. Off posterises flat, showing the bands. */
  dither: boolean;
  /**
   * Weights the field towards its dark end above 1, and towards its light end
   * below. Below 1 here, uniquely: see the default for the measurement.
   */
  gamma: number;
  /** Frames burned before the first paint, so it opens alight rather than cold. */
  settleSteps: number;
  /** The greys the field is mapped onto. A function is re-read on theme changes. */
  shading: Shading | (() => Shading);
  /** Fire parameters. Anything omitted falls back to `FIRE_DEFAULTS`. */
  fire: Partial<FireParams>;
  /**
   * Let a click or drag throw sparks of new fuel in.
   *
   * Dragging paints a trail of them, which turns the effect into a brush: each
   * spark is carried up and torn apart independently, so a stroke becomes a row
   * of plumes rather than one smear.
   *
   * Listened for on the window rather than the canvas, like every other
   * interaction here: a background canvas is `pointer-events: none`, so it never
   * sees a pointer itself.
   */
  interactive: boolean;
  /** Draw one settled frame and stop when the visitor has asked for less motion. */
  respectReducedMotion: boolean;
  /** Stop the loop while the tab is hidden. */
  pauseWhenHidden: boolean;
  /** Re-read `shading` when the `class` on `<html>` changes. */
  watchThemeClass: boolean;
  /** Re-read `shading` when the OS colour scheme changes. */
  watchColorScheme: boolean;
  /** Source of randomness. Pass a seeded generator for a repeatable fire. */
  random: () => number;
}

export const FIRE_BACKGROUND_DEFAULTS: FireBackgroundOptions = {
  pixelSize: 6,
  // One, for tongue structure rather than for crispness - see the file header.
  fieldScale: 1,
  maxPixels: 160_000,
  maxFieldCells: 160_000,
  fps: 24,
  levels: 5,
  dither: true,
  // Below one, which *brightens* rather than darkens - the only effect here
  // that wants that. Heat falls off linearly with height, so most of a flame's
  // area sits at low values and the top palette level went entirely unused:
  // measured 18:72% 33:12% 48:12% 63:4% and nothing at all in the brightest
  // grey. At 0.6 the flame body climbs into the upper levels and reads as a
  // mass with an edge instead of as mottling.
  gamma: 0.6,
  // Enough for the front to climb to its steady height and start flickering:
  // at two passes a frame that is about a hundred rows of travel.
  settleSteps: 60,
  shading: defaultShading,
  fire: {},
  interactive: true,
  respectReducedMotion: true,
  pauseWhenHidden: true,
  watchThemeClass: true,
  watchColorScheme: true,
  random: Math.random,
};

/**
 * Mounts the fire on a canvas. The canvas keeps whatever size CSS gives it;
 * this only ever sets its backing-store dimensions.
 *
 * Returns null if the browser will not give up a 2D context, which is the one
 * failure worth handling: the page should carry on without a background rather
 * than throw.
 */
export function createFireBackground(
  canvas: HTMLCanvasElement,
  options: Partial<FireBackgroundOptions> = {}
): BackgroundHandle | null {
  const config: FireBackgroundOptions = withDefaults(FIRE_BACKGROUND_DEFAULTS, options);
  const params: FireParams = withDefaults(FIRE_DEFAULTS, config.fire);

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

  let fire: Fire | null = null;
  let shading: Shading = { base: 0, amplitude: 0 };

  // Clicks waiting to land. Applied inside the frame and after the step, so a
  // spark shows at full heat on the frame it happens rather than being
  // propagated away on the way in.
  const pending: Spark[] = [];

  function readShading() {
    shading = typeof config.shading === 'function' ? config.shading() : config.shading;
  }

  function shade() {
    if (fire) surface.shade(fire.heat, shading, config.gamma);
  }

  function rebuild() {
    // A resize changes the grid, so the fire is relit rather than stretched -
    // and burned up to speed, so it does not restart as a cold black screen.
    const elapsed = fire?.elapsed ?? 0;
    fire = createFire(surface.fieldW, surface.fieldH, config.random);
    fire.elapsed = elapsed;
    for (let i = 0; i < config.settleSteps; i++) stepFire(fire, params, config.random, dt);
  }

  const driver = createDriver(canvas, {
    fps: config.fps,
    onFrame() {
      if (fire) {
        stepFire(fire, params, config.random, dt);
        for (const spark of pending) applySpark(fire, spark, params);
      }
      pending.length = 0;
      shade();
    },
    onResize() {
      if (surface.resize()) rebuild();
      shade();
    },
    onThemeChange() {
      const previous = shading;
      readShading();
      // The heat has not changed, only what greys it maps onto.
      if (shading.base !== previous.base || shading.amplitude !== previous.amplitude) shade();
    },
    pauseWhenHidden: config.pauseWhenHidden,
    watchThemeClass: config.watchThemeClass,
    watchColorScheme: config.watchColorScheme,
  });

  const stopDragging =
    config.interactive && !still
      ? createDragSource(canvas, {
          // A fifth of a spark's radius, so consecutive blobs overlap heavily and
          // the stroke is solid. Sparks are one-shot deposits with no lifetime,
          // so a dense trail costs nothing beyond the deposits themselves.
          spacing: params.sparkRadius * 0.2,
          maxPerMove: 24,
          onEmit(u, v) {
            if (!fire) return;
            pending.push({ x: u * fire.w, y: v * fire.h, strength: 1 });
          },
        })
      : null;

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
      stopDragging?.();
      pending.length = 0;
      fire = null;
    },
  };
}
