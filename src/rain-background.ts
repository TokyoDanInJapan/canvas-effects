// The digital-rain background: canvas and loop. The falling-streak field it
// draws lives in rain.ts, and the shading it hands the result to lives in
// render.ts.
//
// Stateful like the smoke rather than a pure function of time like the plasma:
// each frame's trails are the previous frame's, faded. So there is no
// `draw(elapsed)`, the timestep is fixed per drawn frame so a stalled tab
// resumes rather than lurching, and reduced motion is served by settling it
// once up front and then leaving it alone.

import { createDriver, prefersReducedMotion } from './driver';
import { withDefaults } from './options';
import { createSurface, defaultShading, type BackgroundHandle, type Shading } from './render';
import { RAIN_DEFAULTS, createRain, stepRain, type Rain, type RainParams } from './rain';

export interface RainBackgroundOptions {
  /** CSS pixels per rendered pixel - one dither cell. Bigger is coarser and cheaper. */
  pixelSize: number;
  /**
   * How much coarser the field is than the output, per axis.
   *
   * **One here, where the other two effects use two, and that is deliberate.**
   * `shade` interpolates bilinearly between field cells. For a continuous
   * field that is free smoothing; for discrete lanes it is blur - neighbouring
   * lanes bleed into each other and crisp streaks turn into soft vertical
   * smudges. At a scale of one, each output pixel maps to exactly one field
   * cell, the horizontal interpolation weight is zero everywhere, and the
   * streaks stay sharp. Raising it is the single biggest thing you can do to
   * make this look wrong.
   *
   * It is also the lane spacing: one lane per field column means a drop every
   * `pixelSize * fieldScale` CSS pixels, so at the defaults, every six.
   */
  fieldScale: number;
  /** Ceiling on rendered pixels, so a 4K window is not four times a 1080p one. */
  maxPixels: number;
  /** Ceiling on field cells, which is also a ceiling on lanes. */
  maxFieldCells: number;
  /** Redraw rate. The timestep is `1 / fps`, fixed - see the note above. */
  fps: number;
  /** Palette size. Small on purpose - the dither is what makes it look smooth. */
  levels: number;
  /** Ordered-dither the output. Off posterises flat, showing the bands. */
  dither: boolean;
  /**
   * Weights the field towards its dark end. See `darken` in dither.ts.
   *
   * One by default, unlike the other two effects. They fill the screen and need
   * biasing dark to stay behind text; rain is mostly empty already, and
   * darkening it further just eats the streaks.
   */
  gamma: number;
  /** Steps run before the first paint, so it opens mid-storm rather than dry. */
  settleSteps: number;
  /** The greys the field is mapped onto. A function is re-read on theme changes. */
  shading: Shading | (() => Shading);
  /** Rain parameters. Anything omitted falls back to `RAIN_DEFAULTS`. */
  rain: Partial<RainParams>;
  /** Draw one settled frame and stop when the visitor has asked for less motion. */
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

export const RAIN_BACKGROUND_DEFAULTS: RainBackgroundOptions = {
  pixelSize: 6,
  // See the note on the option. One, not two, and it matters.
  fieldScale: 1,
  maxPixels: 160_000,
  // Matched to `maxPixels`, which at `fieldScale: 1` means never capped - and
  // that is the point, because capping the field would reintroduce exactly the
  // horizontal interpolation the scale of one exists to avoid. Affordable
  // because a cell costs one multiply for the fade, against the dozen or more
  // the fluid solver spends.
  maxFieldCells: 160_000,
  fps: 24,
  levels: 5,
  dither: true,
  gamma: 1,
  // Long enough for the staggered opening lanes to have laid down trails.
  settleSteps: 48,
  shading: defaultShading,
  rain: {},
  respectReducedMotion: true,
  pauseWhenHidden: true,
  watchThemeClass: true,
  watchColorScheme: true,
  random: Math.random,
};

/**
 * Mounts the digital rain on a canvas. The canvas keeps whatever size CSS gives
 * it; this only ever sets its backing-store dimensions.
 *
 * Returns null if the browser will not give up a 2D context, which is the one
 * failure worth handling: the page should carry on without a background rather
 * than throw.
 */
export function createRainBackground(
  canvas: HTMLCanvasElement,
  options: Partial<RainBackgroundOptions> = {}
): BackgroundHandle | null {
  const config: RainBackgroundOptions = withDefaults(RAIN_BACKGROUND_DEFAULTS, options);
  const params: RainParams = withDefaults(RAIN_DEFAULTS, config.rain);

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

  let rain: Rain | null = null;
  let shading: Shading = { base: 0, amplitude: 0 };

  function readShading() {
    shading = typeof config.shading === 'function' ? config.shading() : config.shading;
  }

  function shade() {
    if (rain) surface.shade(rain.field, shading, config.gamma);
  }

  function rebuild() {
    // A resize changes the lane count, so the storm is rebuilt rather than
    // stretched - and settled, so it does not restart as a dry screen.
    rain = createRain(surface.fieldW, surface.fieldH, config.random, params);
    for (let i = 0; i < config.settleSteps; i++) stepRain(rain, params, config.random, dt);
  }

  const driver = createDriver(canvas, {
    fps: config.fps,
    onFrame() {
      if (rain) stepRain(rain, params, config.random, dt);
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
      if (!still) driver.start();
    },
    stop: driver.stop,
    refresh() {
      readShading();
      shade();
    },
    destroy() {
      driver.destroy();
      rain = null;
    },
  };
}
