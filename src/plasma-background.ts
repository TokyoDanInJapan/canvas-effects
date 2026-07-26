// The plasma background: canvas and loop. The warp it samples lives in
// plasma-warp.ts, and the shading it hands the result to lives in render.ts.
//
// Unlike the smoke this is stateless in time: the field is a pure function of
// the elapsed animation time, so it can be drawn at any moment without having
// drawn the moments before it. That is what makes the reduced-motion path a
// single `draw(0)` rather than a settling run.
//
// The one piece of state is the motion blur, which mixes each frame towards the
// last. It smooths the underlying field between frames, so cells drift between
// palette levels rather than flicking between them.

import { createDriver, prefersReducedMotion } from './driver';
import { withDefaults } from './options';
import { createSurface, defaultShading, type BackgroundHandle, type Shading } from './render';
import { darken } from './dither';
import {
  WARP_GRID_X,
  WARP_GRID_Y,
  PLASMA_WARP_DEFAULTS,
  buildPlasmaTile,
  fillDisplacementGrid,
  randomizePlasmaWarp,
  sampleDisplacementGrid,
  samplePlasma,
  type PlasmaWarpConfig,
} from './plasma-warp';

export interface PlasmaBackgroundOptions {
  /** CSS pixels per rendered pixel - one dither cell. Bigger is coarser and cheaper. */
  pixelSize: number;
  /**
   * How much coarser the field is than the output, per axis. Two, by default,
   * so the field cell stays ~12 CSS pixels regardless of `pixelSize` - that is
   * a property of how smooth the plasma is, not of the dither grid.
   */
  fieldScale: number;
  /** Ceiling on rendered pixels, so a 4K window is not four times a 1080p one. */
  maxPixels: number;
  /** Redraw rate. The warp drifts slowly; the refresh rate is wasted on it. */
  fps: number;
  /** Palette size. Small on purpose - the dither is what makes it look smooth. */
  levels: number;
  /** Weights the field towards its dark end. See `darken` in dither.ts. */
  gamma: number;
  /** A multiplier on animation time. Slow, by default: this is meant to go unnoticed. */
  speed: number;
  /** Motion blur - how far each frame mixes towards the previous one. */
  blend: number;
  /** Edge of the plasma tile, in samples. Wrapped on both axes. */
  tileSize: number;
  /** The greys the field is mapped onto. A function is re-read on theme changes. */
  shading: Shading | (() => Shading);
  /** Warp parameters. Anything omitted falls back to `PLASMA_WARP_DEFAULTS`. */
  warp: Partial<PlasmaWarpConfig>;
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

export const PLASMA_BACKGROUND_DEFAULTS: PlasmaBackgroundOptions = {
  pixelSize: 6,
  fieldScale: 2,
  maxPixels: 160_000,
  fps: 24,
  levels: 5,
  // Measured, not guessed: with no bias 19.9% of the background sits in the
  // lower half of the palette, and 1.18 raises that to 30.1% - half as much
  // again. Both ends of the range are fixed points, so this shifts the balance
  // between the greys without touching the palette itself.
  //
  // Solved offline across eight seeds rather than from the browser. A single
  // page load rolls one noise field, and an fbm field can be locally dark or
  // light, so one load measures that seed rather than the effect - the browser
  // numbers came out non-monotonic in gamma before this was noticed.
  gamma: 1.18,
  speed: 0.35,
  blend: 0.72,
  tileSize: 128,
  shading: defaultShading,
  warp: {},
  respectReducedMotion: true,
  pauseWhenHidden: true,
  watchThemeClass: true,
  watchColorScheme: true,
  random: Math.random,
};

/**
 * Mounts the plasma on a canvas. The canvas keeps whatever size CSS gives it;
 * this only ever sets its backing-store dimensions.
 *
 * Returns null if the browser will not give up a 2D context, which is the one
 * failure worth handling: the page should carry on without a background rather
 * than throw.
 */
export function createPlasmaBackground(
  canvas: HTMLCanvasElement,
  options: Partial<PlasmaBackgroundOptions> = {}
): BackgroundHandle | null {
  const config: PlasmaBackgroundOptions = withDefaults(PLASMA_BACKGROUND_DEFAULTS, options);
  const params: PlasmaWarpConfig = withDefaults(PLASMA_WARP_DEFAULTS, config.warp);

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;

  const still = config.respectReducedMotion && prefersReducedMotion();
  const state = randomizePlasmaWarp(config.random);
  const tile = buildPlasmaTile(config.tileSize);
  const grid = new Float32Array(WARP_GRID_X * WARP_GRID_Y * 2);
  const uv = new Float32Array(2);

  const surface = createSurface(canvas, ctx, {
    pixelSize: config.pixelSize,
    fieldScale: config.fieldScale,
    maxPixels: config.maxPixels,
    maxFieldCells: Infinity,
    levels: config.levels,
  });

  // The low-resolution field, and the previous frame of it for the blur.
  let field = new Float32Array(0);
  let previous = new Float32Array(0);
  let shading: Shading = { base: 0, amplitude: 0 };
  let elapsed = 0;

  function readShading() {
    shading = typeof config.shading === 'function' ? config.shading() : config.shading;
  }

  function rebuild() {
    field = new Float32Array(surface.fieldW * surface.fieldH);
    previous = new Float32Array(surface.fieldW * surface.fieldH);
  }

  /** The expensive half: warp and sample the plasma, coarsely. */
  function updateField(animTime: number) {
    fillDisplacementGrid(animTime, params, state, grid);

    const { fieldW, fieldH } = surface;
    const sx = fieldW > 1 ? 1 / (fieldW - 1) : 0;
    const sy = fieldH > 1 ? 1 / (fieldH - 1) : 0;

    for (let j = 0; j < fieldH; j++) {
      const t = j * sy;
      for (let i = 0; i < fieldW; i++) {
        const index = j * fieldW + i;
        sampleDisplacementGrid(grid, i * sx, t, uv);
        // Darkened here rather than at shade time, so the blur below carries
        // the biased value forward and successive frames agree with each other.
        const sampled = darken(samplePlasma(tile, config.tileSize, uv[0], uv[1]), config.gamma);
        const smoothed = previous[index] + (sampled - previous[index]) * (1 - config.blend);
        previous[index] = smoothed;
        field[index] = smoothed;
      }
    }
  }

  // Gamma is already in the field, so the shading pass must not apply it twice.
  function shade() {
    surface.shade(field, shading, 1);
  }

  function draw(animTime: number) {
    updateField(animTime);
    shade();
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
      draw(elapsed);
    },
    onResize() {
      if (surface.resize()) rebuild();
      draw(elapsed);
    },
    onThemeChange() {
      const was = shading;
      readShading();
      // The field has not changed, only what greys it maps onto.
      if (shading.base !== was.base || shading.amplitude !== was.amplitude) shade();
    },
    pauseWhenHidden: config.pauseWhenHidden,
    watchThemeClass: config.watchThemeClass,
    watchColorScheme: config.watchColorScheme,
  });

  readShading();
  surface.resize();
  rebuild();
  draw(0);
  if (!still) driver.start();

  return {
    canvas,
    start() {
      if (!still) {
        // The clock has moved on while it was stopped; do not credit that time
        // to the animation.
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
    },
  };
}
