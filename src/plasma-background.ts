// The plasma background. The warp it samples lives in plasma-warp.ts, the
// shading it hands the result to lives in render.ts, and the canvas, loop and
// listeners it shares with every other effect live in background.ts.
//
// Stateless in time, unlike the smoke: the field is a pure function of the
// elapsed animation time, so it can be drawn at any moment without having drawn
// the moments before it. That is what makes the reduced-motion path a single
// frame rather than a settling run, and why the timestep comes off the clock.
//
// The one piece of state is the motion blur, which mixes each frame towards the
// last. It smooths the underlying field between frames, so cells drift between
// palette levels rather than flicking between them.

import {
  COMMON_BACKGROUND_DEFAULTS,
  aspectOf,
  createAgeingList,
  mountBackground,
  type CommonBackgroundOptions,
} from './background.js';
import { withDefaults } from './options.js';
import { type BackgroundHandle } from './render.js';
import { darken } from './dither.js';
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
  type Ripple,
} from './plasma-warp.js';

export interface PlasmaBackgroundOptions extends CommonBackgroundOptions {
  /**
   * How much coarser the field is than the output, per axis. Two, by default,
   * so the field cell stays ~12 CSS pixels regardless of `pixelSize` - that is
   * a property of how smooth the plasma is, not of the dither grid.
   */
  fieldScale: number;
  /** Redraw rate. The warp drifts slowly; the refresh rate is wasted on it. */
  fps: number;
  /** A multiplier on animation time. Slow, by default: this is meant to go unnoticed. */
  speed: number;
  /**
   * Motion blur - the fraction of the previous frame each new one keeps, as
   * measured at 24fps, the rate the defaults were tuned at. The actual
   * per-frame factor is rescaled to the real frame interval, so the trail
   * lasts the same wall-clock time whatever `fps` is set to; existing configs
   * keep the look they were tuned for.
   */
  blend: number;
  /** Edge of the plasma tile, in samples. Wrapped on both axes. */
  tileSize: number;
  /** Warp parameters. Anything omitted falls back to `PLASMA_WARP_DEFAULTS`. */
  warp: Partial<PlasmaWarpConfig>;
  /**
   * Let a click or drag send ripples out from where the pointer is.
   *
   * Dragging leaves a wake of them. Spaced widely, because ripples are large and
   * overlapping rings quickly cancel into noise rather than reading as several
   * disturbances.
   */
  interactive: boolean;
  /** Most ripples alive at once. */
  maxRipples: number;
}

export const PLASMA_BACKGROUND_DEFAULTS: PlasmaBackgroundOptions = {
  ...COMMON_BACKGROUND_DEFAULTS,
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
  warp: {},
  // Room for a wake rather than a handful of clicks. A ripple costs one pass over
  // the 1,008-cell warp grid, so this is affordable.
  maxRipples: 18,
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

  const state = randomizePlasmaWarp(config.random);
  const tile = buildPlasmaTile(config.tileSize);
  const grid = new Float32Array(WARP_GRID_X * WARP_GRID_Y * 2);
  const uv = new Float32Array(2);

  // Live click ripples. Aged in real seconds, not animation time - see `Ripple`.
  const ripples = createAgeingList<Ripple>(config.maxRipples, params.rippleLifetime);

  // The low-resolution field, and the previous frame of it for the blur.
  let field = new Float32Array(0);
  let previous = new Float32Array(0);
  let width = 0;
  let height = 0;
  let aspect = 1;
  let elapsed = 0;

  /**
   * The expensive half: warp and sample the plasma, coarsely.
   *
   * `keep` is the fraction of the previous frame that survives into this one -
   * the blur, already rescaled by the caller to the frame interval it is
   * stepping by. Zero means no blur at all, which is what a rebuild needs: the
   * buffer it would blend against is freshly zeroed, and mixing towards black
   * washes out the first frame - visibly so under reduced motion, where that
   * first frame is the only one there will ever be.
   */
  function updateField(animTime: number, keep: number) {
    fillDisplacementGrid(animTime, params, state, grid, ripples.items, aspect);

    const sx = width > 1 ? 1 / (width - 1) : 0;
    const sy = height > 1 ? 1 / (height - 1) : 0;

    for (let j = 0; j < height; j++) {
      const t = j * sy;
      for (let i = 0; i < width; i++) {
        const index = j * width + i;
        sampleDisplacementGrid(grid, i * sx, t, uv);
        // Darkened here rather than at shade time, so the blur below carries
        // the biased value forward and successive frames agree with each other.
        const sampled = darken(samplePlasma(tile, config.tileSize, uv[0], uv[1]), config.gamma);
        const smoothed = sampled + (previous[index] - sampled) * keep;
        previous[index] = smoothed;
        field[index] = smoothed;
      }
    }
  }

  return mountBackground(canvas, config, {
    // Uncapped: this is a handful of multiply-adds a cell, not a solver.
    maxFieldCells: Infinity,
    // One, not `config.gamma`. The bias is already in the field - see
    // `updateField` - and applying it again at shade time would double it.
    gamma: 1,
    timestep: 'clock',

    rebuild(fieldW, fieldH) {
      width = fieldW;
      height = fieldH;
      // The real aspect of what is on screen, for the ripples: the warp domain
      // keeps its fixed 4:3, but a click ring has to be a circle on the actual
      // window, whatever shape that is.
      aspect = aspectOf({ w: fieldW, h: fieldH });
      field = new Float32Array(fieldW * fieldH);
      previous = new Float32Array(fieldW * fieldH);
      // Filled as well as allocated, so the frame painted straight after a resize
      // is this field rather than an empty one - and with the blur off, because
      // blending against the zeroed buffer would paint it at a fraction of its
      // contrast. See `updateField`.
      updateField(elapsed, 0);
    },

    field: () => field,

    step(dt) {
      // Accumulated rather than read off the clock, so pausing resumes where it
      // stopped.
      elapsed += dt * config.speed;
      // Real seconds, deliberately unscaled by `speed`: a splash should not
      // slow down because the field it is disturbing is drifting slowly.
      ripples.advance(dt);
      // `blend` is the per-frame keep factor at the 24fps the defaults were
      // tuned at; raising it to `dt * 24` makes the trail a length of wall-clock
      // time rather than a count of frames, so halving the frame rate no longer
      // doubles the blur.
      updateField(elapsed, Math.pow(config.blend, dt * 24));
    },

    drag: {
      spacing: 0.02,
      maxPerMove: 12,
      onEmit(u, v) {
        ripples.add({ x: u, y: v, age: 0, strength: 1 });
      },
    },

    destroy() {
      ripples.clear();
    },
  });
}
