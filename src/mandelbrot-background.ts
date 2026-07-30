// The Mandelbrot background. The set, the distance estimate and the camera that
// flies it live in mandelbrot.ts, the shading it hands the result to lives in
// render.ts, and the canvas, loop and listeners it shares with every other
// effect live in background.ts.
//
// Stateful in time, like the smoke and unlike the plasma: the view integrates
// its own position and span, so frame N is built from frame N-1 and the
// timestep is the fixed one. A stalled tab that came back with a two-second
// step would otherwise jump several doublings deeper in a single frame.
//
// Reduced motion is the home view - the whole set, still. That is the one frame
// of this effect that needs no settling to be worth looking at.

import { COMMON_BACKGROUND_DEFAULTS, mountBackground, type CommonBackgroundOptions } from './background.js';
import { withDefaults } from './options.js';
import { type BackgroundHandle } from './render.js';
import {
  MANDELBROT_DEFAULTS,
  createMandelbrot,
  renderMandelbrot,
  stepMandelbrot,
  type Mandelbrot,
  type MandelbrotParams,
} from './mandelbrot.js';

export interface MandelbrotBackgroundOptions extends CommonBackgroundOptions {
  /**
   * How much coarser the field is than the output, per axis. Two, by default -
   * with `pixelSize: 4` that puts a field cell at 8 CSS pixels, which is the
   * resolution the whole effect is budgeted around.
   */
  fieldScale: number;
  /**
   * CSS pixels per rendered pixel. Four, not six: this is the one effect here
   * whose subject has detail at every scale, so the dither grid is worth
   * spending on.
   */
  pixelSize: number;
  /** Ceiling on field cells. The hard one - see the note on the defaults. */
  maxFieldCells: number;
  /** Set and camera parameters. Anything omitted falls back to `MANDELBROT_DEFAULTS`. */
  mandelbrot: Partial<MandelbrotParams>;
  /**
   * Let a press or drag aim the zoom, pulling the view towards whatever is
   * nearest the pointer worth looking at, and handing it back to the autopilot
   * on release.
   *
   * Only on the way in. The pull-out is a function of the span rather than
   * something being steered, so there is nothing for a pointer to hold on to
   * while it is happening.
   */
  interactive: boolean;
}

/**
 * Cost is cells times iterations, and it is the one effect here where that
 * product is large enough to have to be capped at both ends.
 *
 * Measured at the ceilings below - a 133x75 field and a budget rising from 90
 * iterations at home to 300 at the floor - a frame is 0.4 ms at the home view
 * and 4.3 ms at the deepest: 1% and 10% of one core at 24fps, which is the
 * tunnel's range and for the same reason. Nearly all of the deep figure is
 * interior cells, which are the ones that spend the whole budget.
 *
 * The two ceilings pull against each other and the trade is a real one. Half
 * the cells buys twice the iterations, which is a thinner, truer boundary -
 * below about 300 the filigree visibly fills in solid - in a coarser picture.
 * 10,000 cells is where both are still just about right, and it is a third of
 * the tunnel's ceiling rather than matched to `maxPixels` because this touches
 * each cell a couple of hundred times where the tunnel touches it once.
 */
export const MANDELBROT_BACKGROUND_DEFAULTS: MandelbrotBackgroundOptions = {
  ...COMMON_BACKGROUND_DEFAULTS,
  pixelSize: 4,
  fieldScale: 2,
  maxFieldCells: 10_000,
  // 1, and this one is not a judgement call. Brightness here is a function of
  // distance measured *in cells*, so biasing the field afterwards would break
  // the property the whole effect is built on - that the picture looks the same
  // at every magnification. `glow` and `bands` are the tone dials instead.
  gamma: 1,
  mandelbrot: {},
};

/**
 * Mounts the Mandelbrot zoomer on a canvas. The canvas keeps whatever size CSS
 * gives it; this only ever sets its backing-store dimensions.
 *
 * Returns null if the browser will not give up a 2D context, which is the one
 * failure worth handling: the page should carry on without a background rather
 * than throw.
 */
export function createMandelbrotBackground(
  canvas: HTMLCanvasElement,
  options: Partial<MandelbrotBackgroundOptions> = {}
): BackgroundHandle | null {
  const config: MandelbrotBackgroundOptions = withDefaults(MANDELBROT_BACKGROUND_DEFAULTS, options);
  const params: MandelbrotParams = withDefaults(MANDELBROT_DEFAULTS, config.mandelbrot);

  let mandelbrot: Mandelbrot | null = null;

  // Where the pointer last was, and whether it still has hold. Read once a
  // frame rather than acted on per emission: re-aiming scans the whole field,
  // and a fast drag delivers a dozen emissions between two frames.
  let steering = false;
  const pointer: [number, number] = [0, 0];

  return mountBackground(canvas, config, {
    maxFieldCells: config.maxFieldCells,
    gamma: config.gamma,
    timestep: 'fixed',

    rebuild(fieldW, fieldH) {
      // A resize rebuilds the field but carries the camera over: where the view
      // is and how deep it has got are resolution-independent, and rerolling
      // them would throw the visitor back to the top of the zoom every time
      // they dragged a window edge.
      const state = mandelbrot?.state;
      mandelbrot = createMandelbrot(fieldW, fieldH, config.random, params);
      if (state) mandelbrot.state = state;
      renderMandelbrot(mandelbrot, params);
    },

    field: () => mandelbrot?.field ?? null,

    step(dt) {
      if (!mandelbrot) return;
      stepMandelbrot(mandelbrot, params, dt, steering ? pointer : null);
      renderMandelbrot(mandelbrot, params);
    },

    drag: {
      // Fine, because nothing is emitted - the aim simply is wherever the
      // pointer last was, so this is only how often that is refreshed.
      spacing: 0.004,
      maxPerMove: 4,
      onEmit(u, v) {
        pointer[0] = u;
        pointer[1] = v;
        steering = true;
      },

      onRelease() {
        steering = false;
      },
    },

    destroy() {
      mandelbrot = null;
    },
  });
}
