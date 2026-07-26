// The smoke background: canvas, loop and input. The fluid solver it drives
// lives in smoke.ts, and the shading it hands the result to lives in render.ts.
//
// The shape of this is the same as the plasma background - a coarse field, an
// interpolated and dithered output, the same palette - with one important
// difference: this one is *stateful*. The density field is carried forward from
// frame to frame and folded by the flow, which is what produces filaments. Two
// things follow from that:
//
//   • It cannot be drawn at an arbitrary time. Frame N depends on frame N-1, so
//     there is no equivalent of the plasma's `draw(elapsed)`. Under reduced
//     motion it is settled by running a fixed number of steps up front, then
//     left alone.
//   • A stalled tab must not resume with one enormous step, or the smoke would
//     lurch. The timestep is fixed per drawn frame rather than taken from the
//     clock; a slow frame makes the smoke drift slower, never further.

import { createDriver, prefersReducedMotion } from './driver';
import { createSurface, defaultShading, type BackgroundHandle, type Shading } from './render';
import {
  SMOKE_DEFAULTS,
  applyJet,
  applyStroke,
  computeSource,
  createFluid,
  nextJetDelay,
  planJet,
  randomizeSmoke,
  stepFluid,
  type Fluid,
  type Jet,
  type SmokeParams,
  type Stroke,
} from './smoke';

export interface SmokeBackgroundOptions {
  /** CSS pixels per rendered pixel - one dither cell. Bigger is coarser and cheaper. */
  pixelSize: number;
  /**
   * How much coarser the simulation grid is than the output, per axis.
   *
   * The solver touches every cell about a dozen times a frame - six passes plus
   * every Jacobi iteration - so its cost is far more sensitive to this than a
   * plain noise field's would be, and one step coarser is four times less work.
   * The dither hides the difference.
   */
  fieldScale: number;
  /** Ceiling on rendered pixels, so a 4K window is not four times a 1080p one. */
  maxPixels: number;
  /**
   * Ceiling on simulation cells, which is a much harder limit than the pixel
   * one. Left uncapped, a 1440p window would simulate five times the cells of a
   * 1080p one and the whole thing would fall over on exactly the machines least
   * able to take it.
   */
  maxSimCells: number;
  /** Redraw rate. The timestep is `1 / fps`, fixed - see the note above. */
  fps: number;
  /** Palette size. Small on purpose - the dither is what makes it look smooth. */
  levels: number;
  /** Weights the field towards its dark end. See `darken` in dither.ts. */
  gamma: number;
  /** Steps run before the first paint, so it opens as smoke rather than fog. */
  settleSteps: number;
  /** The greys the field is mapped onto. A function is re-read on theme changes. */
  shading: Shading | (() => Shading);
  /** Solver parameters. Anything omitted falls back to `SMOKE_DEFAULTS`. */
  simulation: Partial<SmokeParams>;
  /** Let a cursor drag stir the fluid. */
  interactive: boolean;
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

export const SMOKE_BACKGROUND_DEFAULTS: SmokeBackgroundOptions = {
  pixelSize: 6,
  fieldScale: 2,
  maxPixels: 160_000,
  maxSimCells: 8_000,
  fps: 24,
  levels: 5,
  // Solved offline across four seeds rather than in the browser. Each page load
  // rolls a fresh field and fires jets at random times, so a single run's mean
  // shade swings by three or four levels - measuring this live gave results
  // that were not even monotonic in gamma.
  //
  // At 1 the darkest grey covered 11% of the background; 1.6 takes it to 23%
  // while leaving 9% at the brightest, so the highlights that make it read as
  // smoke survive. Further, if wanted: 2.0 gives 30%, 2.5 gives 38%.
  gamma: 1.6,
  settleSteps: 90,
  shading: defaultShading,
  simulation: {},
  interactive: true,
  respectReducedMotion: true,
  pauseWhenHidden: true,
  watchThemeClass: true,
  watchColorScheme: true,
  random: Math.random,
};

/**
 * Mounts the smoke on a canvas. The canvas keeps whatever size CSS gives it;
 * this only ever sets its backing-store dimensions.
 *
 * Returns null if the browser will not give up a 2D context, which is the one
 * failure worth handling: the page should carry on without a background rather
 * than throw.
 */
export function createSmokeBackground(
  canvas: HTMLCanvasElement,
  options: Partial<SmokeBackgroundOptions> = {}
): BackgroundHandle | null {
  const config: SmokeBackgroundOptions = { ...SMOKE_BACKGROUND_DEFAULTS, ...options };
  const params: SmokeParams = { ...SMOKE_DEFAULTS, ...config.simulation };

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;

  const still = config.respectReducedMotion && prefersReducedMotion();
  const state = randomizeSmoke(config.random);
  const dt = 1 / config.fps;

  const surface = createSurface(canvas, ctx, {
    pixelSize: config.pixelSize,
    fieldScale: config.fieldScale,
    maxPixels: config.maxPixels,
    maxFieldCells: config.maxSimCells,
    levels: config.levels,
  });

  let fluid: Fluid | null = null;
  let shading: Shading = { base: 0, amplitude: 0 };
  let elapsed = 0;

  // Jets fire on their own schedule rather than every N frames, so they do not
  // fall into step with anything else on the page.
  let jet: Jet | null = null;
  let jetEndsAt = 0;
  let nextJetAt = nextJetDelay(config.random, params);

  // Drags waiting to be applied. Pointer events fire faster than the simulation
  // steps, so they are collected and spent on the next frame rather than each
  // one poking the fluid on its own.
  const pending: Stroke[] = [];

  function readShading() {
    shading = typeof config.shading === 'function' ? config.shading() : config.shading;
  }

  /** Runs the simulation forward one step. */
  function step() {
    if (!fluid) return;
    elapsed += dt;

    for (const stroke of pending) applyStroke(fluid, stroke, params, dt);
    pending.length = 0;

    if (!jet && elapsed >= nextJetAt) {
      jet = planJet(fluid.w, fluid.h, config.random, params);
      jetEndsAt = elapsed + jet.duration;
    }

    if (jet) {
      // Every frame it is alive - a jet is sustained, not an impulse.
      applyJet(fluid, jet, dt);
      if (elapsed >= jetEndsAt) {
        jet = null;
        nextJetAt = elapsed + nextJetDelay(config.random, params);
      }
    }

    stepFluid(fluid, params, state, elapsed, dt);
  }

  function shade() {
    if (fluid) surface.shade(fluid.density, shading, config.gamma);
  }

  function rebuild() {
    fluid = createFluid(surface.fieldW, surface.fieldH);

    // Resizing throws the simulation away, so run a fresh one up to speed
    // rather than opening on still, unmoved source noise.
    computeSource(elapsed, params, state, fluid.source, fluid.w, fluid.h);
    fluid.density.set(fluid.source);
    for (let i = 0; i < config.settleSteps; i++) step();
  }

  const driver = createDriver(canvas, {
    fps: config.fps,
    onFrame() {
      step();
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

  /**
   * Dragging stirs the smoke.
   *
   * Listened for on the window rather than the canvas: a background canvas is
   * usually `pointer-events: none` so that it never intercepts anything meant
   * for the page, which also means it never sees a pointer itself.
   *
   * Only while a button is held. Reacting to every idle mouse movement would
   * mean the background is permanently being disturbed by a reader who is only
   * moving the cursor out of the way of the text.
   */
  function onPointerMove(event: PointerEvent) {
    if (still || !fluid || event.buttons === 0) return;
    // A long stall between events would otherwise arrive as one huge drag.
    if (pending.length > 16) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const toCellsX = fluid.w / rect.width;
    const toCellsY = fluid.h / rect.height;

    pending.push({
      x: (event.clientX - rect.left) * toCellsX,
      y: (event.clientY - rect.top) * toCellsY,
      dx: event.movementX * toCellsX,
      dy: event.movementY * toCellsY,
    });
  }

  if (config.interactive && !still) {
    window.addEventListener('pointermove', onPointerMove, { passive: true });
  }

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
      window.removeEventListener('pointermove', onPointerMove);
      fluid = null;
    },
  };
}
