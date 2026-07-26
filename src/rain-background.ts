// The digital-rain background. The falling-streak field it draws lives in
// rain.ts, the shading it hands the result to lives in render.ts, and the canvas,
// loop and listeners it shares with every other effect live in background.ts.
//
// Stateful, so its timestep is fixed: each frame's trails are the previous
// frame's, faded. Reduced motion is served by settling it once in `rebuild` and
// then leaving it alone, which is what makes a still frame of this look like rain
// rather than like a dry screen.

import {
  COMMON_BACKGROUND_DEFAULTS,
  createAgeingList,
  mountBackground,
  type CommonBackgroundOptions,
} from './background';
import { withDefaults } from './options';
import { type BackgroundHandle } from './render';
import { RAIN_DEFAULTS, createRain, distortField, stepRain, type Distortion, type Rain, type RainParams } from './rain';

export interface RainBackgroundOptions extends CommonBackgroundOptions {
  /**
   * How much coarser the field is than the output, per axis.
   *
   * **One here, where the field effects use two, and that is deliberate.**
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
  /** Ceiling on field cells, which is also a ceiling on lanes. */
  maxFieldCells: number;
  /**
   * Weights the field towards its dark end. See `darken` in dither.ts.
   *
   * One by default, unlike the field effects. They fill the screen and need
   * biasing dark to stay behind text; rain is mostly empty already, and
   * darkening it further just eats the streaks.
   */
  gamma: number;
  /** Steps run before the first paint, so it opens mid-storm rather than dry. */
  settleSteps: number;
  /** Rain parameters. Anything omitted falls back to `RAIN_DEFAULTS`. */
  rain: Partial<RainParams>;
  /**
   * Let a click or drag send distortions through the rain - rings that bend the
   * streaks as they pass, like droplets on glass acting as lenses.
   *
   * Dragging leaves a line of them, which is more visible than a single one: the
   * rain is sparse, so more rings mean more chance of catching a streak.
   */
  interactive: boolean;
  /**
   * Most distortions at once.
   *
   * Held lower than the other effects' equivalents on purpose: `distortField`
   * sums every live distortion at every cell inside their combined bounding box,
   * so this one is the only interaction here whose cost grows with the count.
   */
  maxDistortions: number;
}

export const RAIN_BACKGROUND_DEFAULTS: RainBackgroundOptions = {
  ...COMMON_BACKGROUND_DEFAULTS,
  // See the note on the option. One, not two, and it matters.
  fieldScale: 1,
  // Matched to `maxPixels`, which at `fieldScale: 1` means never capped - and
  // that is the point, because capping the field would reintroduce exactly the
  // horizontal interpolation the scale of one exists to avoid. Affordable
  // because a cell costs one multiply for the fade, against the dozen or more
  // the fluid solver spends.
  maxFieldCells: 160_000,
  gamma: 1,
  // Long enough for the staggered opening lanes to have laid down trails.
  settleSteps: 48,
  rain: {},
  maxDistortions: 12,
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
  const dt = 1 / config.fps;

  let rain: Rain | null = null;

  // Live droplet distortions, aged in real seconds.
  const distortions = createAgeingList<Distortion>(config.maxDistortions, params.distortLifetime);

  return mountBackground(canvas, config, {
    maxFieldCells: config.maxFieldCells,
    gamma: config.gamma,
    timestep: 'fixed',

    rebuild(fieldW, fieldH) {
      // A resize changes the lane count, so the storm is rebuilt rather than
      // stretched - and settled, so it does not restart as a dry screen.
      rain = createRain(fieldW, fieldH, config.random, params);
      for (let i = 0; i < config.settleSteps; i++) stepRain(rain, params, config.random, dt);
    },

    // `distortField` hands back the plain field when there is nothing to apply,
    // so an idle page pays nothing for this - not even a copy.
    field: () => (rain ? distortField(rain, distortions.items, params) : null),

    step(elapsed) {
      if (rain) stepRain(rain, params, config.random, elapsed);
      distortions.advance(elapsed);
    },

    drag: {
      spacing: 0.025,
      maxPerMove: 10,
      onEmit(u, v) {
        if (!rain) return;
        distortions.add({ x: u * rain.w, y: v * rain.h, age: 0, strength: 1 });
      },
    },

    destroy() {
      distortions.clear();
      rain = null;
    },
  });
}
