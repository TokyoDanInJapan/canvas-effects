// The ridgeline background. The landscape it draws lives in ridges.ts, the
// shading it hands the result to lives in render.ts, and the canvas, loop and
// listeners it shares with every other effect live in background.ts.
//
// The field is a pure function of how far we have flown, so it could be drawn at
// any moment - but the timestep is fixed rather than taken from the clock,
// because two things here do carry history: `ridges.trail`, above zero, starts
// each frame from the last one faded, and a click leaves a wobble travelling
// through the stack for a second or two. Both are absent under reduced motion,
// where a single still frame is drawn - correct for a still in either case.

import {
  COMMON_BACKGROUND_DEFAULTS,
  createAgeingList,
  mountBackground,
  type CommonBackgroundOptions,
} from './background';
import { withDefaults } from './options';
import { type BackgroundHandle } from './render';
import {
  RIDGE_DEFAULTS,
  createRidges,
  depthAtY,
  renderRidges,
  stepRidges,
  type RidgeParams,
  type Ridges,
  type Wobble,
} from './ridges';

export interface RidgesBackgroundOptions extends CommonBackgroundOptions {
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
  /** Ceiling on field cells. Matched to `maxPixels`, so it never interpolates. */
  maxFieldCells: number;
  /** Palette size. Lines are drawn at full brightness; this shades the haze. */
  levels: number;
  /**
   * Weights the field towards its dark end. One by default: the field is
   * already mostly empty, and biasing it would only dim the distant rows the
   * depth fade has already dimmed.
   */
  gamma: number;
  /** Landscape parameters. Anything omitted falls back to `RIDGE_DEFAULTS`. */
  ridges: Partial<RidgeParams>;
  /**
   * Let a click or drag set wobbles running through the stack.
   *
   * Dragging strikes each profile it crosses in turn, so a stroke down the screen
   * reads as running a finger across a stack of strings.
   */
  interactive: boolean;
  /** Most wobbles at once. */
  maxWobbles: number;
}

export const RIDGES_BACKGROUND_DEFAULTS: RidgesBackgroundOptions = {
  ...COMMON_BACKGROUND_DEFAULTS,
  // Four, not the six the field effects use. This is line art, and a line is one
  // cell wide: at six the lines are thick relative to the gaps between rows and
  // the stack reads as static. Four still clears the pixel ceiling at 1080p
  // (480x270 = 129,600 against a 160,000 cap).
  pixelSize: 4,
  fieldScale: 1,
  maxFieldCells: 160_000,
  gamma: 1,
  ridges: {},
  maxWobbles: 16,
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

  let ridges: Ridges | null = null;

  // Live click wobbles, aged in real seconds.
  const wobbles = createAgeingList<Wobble>(config.maxWobbles, params.wobbleLifetime);

  return mountBackground(canvas, config, {
    maxFieldCells: config.maxFieldCells,
    gamma: config.gamma,
    timestep: 'fixed',

    rebuild(fieldW, fieldH) {
      // A resize changes the field, but not where we are: `travel` is carried
      // over so the flight does not jump back to the start on a window drag.
      const travel = ridges?.travel ?? 0;
      const state = ridges?.state;
      ridges = createRidges(fieldW, fieldH, config.random);
      ridges.travel = travel;
      // Same landscape, too - only the resolution it is drawn at has changed.
      if (state) ridges.state = state;
      renderRidges(ridges, params, wobbles.items);
    },

    field: () => ridges?.field ?? null,

    step(dt) {
      // Aged before the step, so a wobble that expires on this frame is gone from
      // the landscape on this frame rather than one frame late.
      wobbles.advance(dt);
      if (ridges) stepRidges(ridges, params, dt, wobbles.items);
    },

    /**
     * A click sets a wobble running from the profile it landed on.
     *
     * `depthAtY` is what turns a screen position into a row: the profiles are
     * placed by a perspective curve, so which one is under the cursor is not a
     * division. The wobble is then keyed to that row's `worldZ` rather than to
     * the screen point, so it travels with the terrain as it approaches instead
     * of sitting still while rows pass through it.
     */
    drag: {
      spacing: 0.02,
      maxPerMove: 12,
      onEmit(u, v) {
        if (!ridges) return;
        const depth = depthAtY(v * ridges.h, ridges.h, params);
        wobbles.add({
          z: Math.round(ridges.travel + depth * params.rows),
          x: u,
          age: 0,
          strength: 1,
        });
      },
    },

    destroy() {
      wobbles.clear();
      ridges = null;
    },
  });
}
