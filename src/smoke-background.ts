// The smoke background. The fluid solver it drives lives in smoke.ts, the
// shading it hands the result to lives in render.ts, and the canvas, loop and
// listeners it shares with every other effect live in background.ts.
//
// The one effect here that is properly *stateful*: the density field is carried
// forward from frame to frame and folded by the flow, which is what produces
// filaments. Two things follow from that:
//
//   • It cannot be drawn at an arbitrary time. Frame N depends on frame N-1, so
//     there is no drawing it at some elapsed time without having drawn the
//     moments before. Under reduced motion it is settled by running a fixed
//     number of steps up front, then left alone.
//   • A stalled tab must not resume with one enormous step, or the smoke would
//     lurch. Hence the fixed timestep: a slow frame makes the smoke drift
//     slower, never further.

import { COMMON_BACKGROUND_DEFAULTS, mountBackground, type CommonBackgroundOptions } from './background.js';
import { withDefaults } from './options.js';
import { type BackgroundHandle } from './render.js';
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
} from './smoke.js';

export interface SmokeBackgroundOptions extends CommonBackgroundOptions {
  /**
   * How much coarser the simulation grid is than the output, per axis.
   *
   * The solver touches every cell about a dozen times a frame - six passes plus
   * every Jacobi iteration - so its cost is far more sensitive to this than a
   * plain noise field's would be, and one step coarser is four times less work.
   * The dither hides the difference.
   */
  fieldScale: number;
  /**
   * Ceiling on simulation cells, which is a much harder limit than the pixel
   * one. Left uncapped, a 1440p window would simulate five times the cells of a
   * 1080p one and the whole thing would fall over on exactly the machines least
   * able to take it.
   */
  maxSimCells: number;
  /** Redraw rate. The timestep is `1 / fps`, fixed - see the note above. */
  fps: number;
  /**
   * Steps run before the first paint, so it opens as smoke rather than fog.
   * Only the first build pays this in full; a resize replaces smoke that was
   * already moving and settles in a handful of steps instead.
   */
  settleSteps: number;
  /** Solver parameters. Anything omitted falls back to `SMOKE_DEFAULTS`. */
  simulation: Partial<SmokeParams>;
  /** Let a cursor drag stir the fluid. */
  interactive: boolean;
}

export const SMOKE_BACKGROUND_DEFAULTS: SmokeBackgroundOptions = {
  ...COMMON_BACKGROUND_DEFAULTS,
  maxSimCells: 8_000,
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
  simulation: {},
};

/**
 * Steps a resize rebuild runs, against the ninety a first build does. Capped by
 * `settleSteps` too, so nobody who configures a short settle gets a longer one
 * on resize.
 */
const RESIZE_SETTLE_STEPS = 6;

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
  const config: SmokeBackgroundOptions = withDefaults(SMOKE_BACKGROUND_DEFAULTS, options);
  const params: SmokeParams = withDefaults(SMOKE_DEFAULTS, config.simulation);

  const state = randomizeSmoke(config.random);
  const dt = 1 / config.fps;

  let fluid: Fluid | null = null;
  let elapsed = 0;
  let settledOnce = false;

  // Jets fire on their own schedule rather than every N frames, so they do not
  // fall into step with anything else on the page.
  let jet: Jet | null = null;
  let jetEndsAt = 0;
  let nextJetAt = nextJetDelay(config.random, params);

  // Drags waiting to be applied. Pointer events fire faster than the simulation
  // steps, so they are collected and spent on the next frame rather than each
  // one poking the fluid on its own.
  const pending: Stroke[] = [];

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

  return mountBackground(canvas, config, {
    maxFieldCells: config.maxSimCells,
    gamma: config.gamma,
    timestep: 'fixed',

    rebuild(fieldW, fieldH) {
      fluid = createFluid(fieldW, fieldH);

      // Rebuilding throws the simulation away, so run the fresh one up to
      // speed rather than opening on still, unmoved source noise. The full
      // settle is only owed once, though: rebuild also fires on every size
      // change during a window drag, and ninety synchronous steps per resize
      // event is tens of milliseconds spent repeatedly while the browser is
      // already struggling to keep up. A resize replaces smoke that was
      // already moving, so a few steps to get the new field flowing is enough.
      computeSource(elapsed, params, state, fluid.source, fluid.w, fluid.h);
      fluid.density.set(fluid.source);
      const steps = settledOnce ? Math.min(config.settleSteps, RESIZE_SETTLE_STEPS) : config.settleSteps;
      for (let i = 0; i < steps; i++) step();
      settledOnce = true;
    },

    field: () => fluid?.density ?? null,

    // The timestep is fixed, so `step` takes its own `dt` and ignores the one it
    // is handed - they are the same number.
    step,

    /**
     * Dragging stirs the smoke.
     *
     * Only while a button is held, which is what `createDragSource` gives:
     * reacting to every idle mouse movement would mean permanently disturbing the
     * background for a reader who is only moving the cursor out of the way of the
     * text.
     *
     * The shove comes from the resampled step rather than from `movementX`. Two
     * things follow, and both are improvements: it works for a touch pointer,
     * where `movementX` is 0 or absent, and the impulse is proportional to the
     * distance dragged rather than to how often the browser delivered an event.
     */
    drag: {
      spacing: 0.01,
      maxPerMove: 8,
      onEmit(u, v, du, dv) {
        if (!fluid) return;
        // A long stall between events would otherwise arrive as one huge drag.
        if (pending.length > 16) return;

        pending.push({
          x: u * fluid.w,
          y: v * fluid.h,
          dx: du * fluid.w,
          dy: dv * fluid.h,
        });
      },
    },

    destroy() {
      pending.length = 0;
      fluid = null;
    },
  });
}
