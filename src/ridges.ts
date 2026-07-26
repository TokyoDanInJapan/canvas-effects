// Stacked ridgelines flown over: a landscape drawn as a pile of horizontal
// profiles, each one hiding the ones behind it, sliding toward the viewer.
//
// The shape is the ridgeline plot - rows of a 2D field drawn as stacked 1D
// curves with hidden-line removal. Its famous instance is the cover of Joy
// Division's "Unknown Pleasures", which is Peter Saville's design of a plot
// from Harold Craft's 1970 thesis showing successive radio pulses from the
// pulsar CP 1919. That is the visual reference; the plot type itself is an
// ordinary statistical graphic that long predates it, and nothing here is
// derived from either the cover or the data.
//
// WHY THIS WORKS THROUGH A DITHER, WHEN GLYPHS WOULD NOT
// ------------------------------------------------------
// The renderer posterises to five greys through a Bayer matrix, which would
// normally shred one-cell-wide line art into dashes. It does not here, because
// 0 and 1 are fixed points of the ordered dither: a cell at full brightness
// lands on the top level for every Bayer position, so a line drawn at 1 comes
// through intact. Values *between* levels are the ones that break up - which is
// exactly what gives the far rows their haze, since they are drawn dimmer.
//
// HIDDEN LINES ARE THE EFFECT
// ---------------------------
// Without occlusion this is a tangle. With it, each row's silhouette blocks
// everything behind, which is what produces the depth and the characteristic
// bitten-out look where a near peak eats into the rows above.
//
// Done with a floating horizon: draw from nearest to farthest, keeping the
// highest point covered so far per column, and skip anything at or below it.
// One pass, no z-buffer, no sorting - `rows * width` work for the whole frame.
//
// Kept DOM-free so it can be unit-tested; the canvas and the loop live in
// ridges-background.ts.

import { fbm } from './noise';

export interface RidgeParams {
  /** How many profiles are on screen at once. */
  rows: number;
  /** Terrain frequency across the screen. Higher is busier left to right. */
  xScale: number;
  /** Terrain frequency into the screen - how fast the shape changes row to row. */
  zScale: number;
  /** fbm octaves for the terrain. */
  octaves: number;
  /**
   * Exponent on the ridged noise. Higher gives narrower, spikier peaks and
   * flatter ground between them.
   */
  sharpness: number;
  /**
   * Width of the Gaussian window that concentrates activity in the middle, in
   * screen widths. Small values pull everything to a central band and leave the
   * edges flat; a large value effectively switches the window off.
   */
  focus: number;
  /** Peak height of the nearest row, as a fraction of the field height. */
  amplitude: number;
  /** How fast peaks shrink with distance. */
  ampFalloff: number;
  /**
   * Perspective. Above 1 bunches the far rows toward the top and spreads the
   * near ones, which is what sells the flight; at 1 the stack is even, which is
   * closer to the flat plot the look comes from.
   */
  perspective: number;
  /** Where the farthest row sits, as a fraction of field height from the top. */
  topMargin: number;
  /** Where the nearest row sits. */
  bottomMargin: number;
  /**
   * Brightness of the farthest row, 0 to 1. Below 1 the distant rows fall
   * between palette levels and the dither breaks them into haze, which is the
   * atmospheric perspective.
   */
  depthFade: number;
  /** Rows crossed per second. This is the flying speed. */
  speed: number;
  /**
   * Extra rows kept alive past the near edge, so a profile rolls off the bottom
   * of the screen instead of being deleted when it gets there.
   *
   * Without this the nearest row creeps down to `bottomMargin` and then pops out
   * of existence the moment `travel` crosses the next whole number - and nothing
   * is ever drawn below `bottomMargin` at all. Rows below the edge still matter
   * on screen twice over: a crest can remain visible long after its baseline has
   * gone, and its silhouette must keep occluding the rows behind it.
   *
   * A row is skipped once it is entirely below the bottom edge, so this is a
   * bound rather than a cost - most of the extra rows do no work.
   */
  overscan: number;
}

export const RIDGE_DEFAULTS: RidgeParams = {
  // Enough to read as a stack without the rows merging into static. The usable
  // band is about 80% of the field height - at 1080p and the default 4px cell
  // that is ~220 cells - so this leaves six or seven cells between rows before
  // perspective compresses the far end. Tried at 40 over a 6px cell first,
  // which left barely two and looked like noise rather than a plot.
  rows: 34,
  xScale: 3.1,
  // Small on purpose. Consecutive rows have to be *correlated* or the stack
  // reads as noise rather than as one landscape seen in slices.
  zScale: 0.32,
  octaves: 4,
  sharpness: 3.2,
  // The central band is the signature of the reference: activity concentrated
  // in the middle with the edges lying flat.
  focus: 0.2,
  // Peaks span five or six row gaps. Much more and a near crest swallows half
  // the stack behind it; much less and there is nothing for the occlusion to do.
  amplitude: 0.18,
  ampFalloff: 1.5,
  // Gentle. This is the dial between the flat plot the look comes from (1) and
  // an obvious flight; too much and the far rows crush into a solid band.
  perspective: 1.35,
  topMargin: 0.12,
  bottomMargin: 0.94,
  depthFade: 0.45,
  speed: 1.6,
  // Enough that the nearest simulated row is always fully off screen at the
  // default perspective and amplitude. Baselines grow faster than peaks as
  // rows pass the edge, so this does not need to be large.
  overscan: 8,
};

/** Seeds and offsets that give one run its landscape. */
export interface RidgeState {
  seed: number;
  offsetX: number;
  offsetZ: number;
}

export function randomizeRidges(rand: () => number = Math.random): RidgeState {
  return {
    seed: Math.floor(rand() * 100000) + 1,
    offsetX: rand() * 64,
    offsetZ: rand() * 64,
  };
}

/**
 * Terrain height at `u` across the screen and `worldZ` into it, 0 to 1.
 *
 * Ridged rather than plain noise: folding fbm about its midpoint with
 * `1 - |2n - 1|` turns smooth hills into sharp crests, which is what the
 * reference looks like. Plain fbm gives rolling dunes and reads as a landscape
 * rather than as a signal.
 */
export function ridgeHeight(u: number, worldZ: number, params: RidgeParams, state: RidgeState): number {
  const { xScale, zScale, octaves, sharpness, focus } = params;

  const n = fbm(u * xScale + state.offsetX, worldZ * zScale + state.offsetZ, state.seed, octaves);
  const ridged = 1 - Math.abs(2 * n - 1);

  // Concentrates the activity centrally and lets the edges lie flat.
  const offset = (u - 0.5) / focus;
  const window = Math.exp(-offset * offset);

  return Math.pow(ridged, sharpness) * window;
}

/**
 * Baseline row position, in cells from the top.
 *
 * `depth` is 0 at the nearest row and 1 at the farthest. The exponent is the
 * perspective: at 1 the rows are evenly spaced, above 1 they crowd together as
 * they recede.
 */
export function rowY(depth: number, h: number, params: RidgeParams): number {
  const near = params.bottomMargin * h;
  const far = params.topMargin * h;
  return far + (near - far) * Math.pow(1 - depth, params.perspective);
}

/**
 * Peak height for a row, in cells. Distant rows are shorter.
 *
 * Held flat once a row passes the near edge rather than continuing to grow.
 * Strict perspective would keep enlarging it - you are flying into it, after
 * all - and a row only slightly past the edge would loom several screen heights
 * tall, throw a silhouette across the whole field and occlude everything behind
 * it. Worse, that growth outruns the baseline's, so such a row never qualifies
 * as fully below the screen and never leaves at all. Freezing the size at the
 * near edge lets a row simply slide out of frame, which is what rolling off the
 * bottom should look like.
 */
export function rowAmplitude(depth: number, h: number, params: RidgeParams): number {
  const clamped = depth < 0 ? 0 : depth;
  return params.amplitude * h * Math.pow(1 - clamped, params.ampFalloff);
}

/**
 * Line brightness for a row, 0 to 1. Distant rows are dimmer, and so hazier.
 *
 * Clamped at the top because `depth` goes negative for rows that have passed the
 * near edge, and full brightness has to stay exactly 1 - it is a fixed point of
 * the ordered dither, which is the only reason one-cell lines survive it.
 */
export function rowBrightness(depth: number, params: RidgeParams): number {
  const value = 1 - depth * (1 - params.depthFade);
  return value > 1 ? 1 : value;
}

export interface Ridges {
  w: number;
  h: number;
  /** Brightness per cell, 0 to 1, row-major. This is what gets shaded. */
  field: Float32Array;
  /** Highest point covered so far, per column. Scratch, rebuilt every frame. */
  horizon: Float32Array;
  /** This row's curve, per column. Scratch. */
  ys: Float32Array;
  state: RidgeState;
  /** How far we have flown, in rows. */
  travel: number;
}

export function createRidges(w: number, h: number, rand: () => number = Math.random): Ridges {
  return {
    w,
    h,
    field: new Float32Array(w * h),
    horizon: new Float32Array(w),
    ys: new Float32Array(w),
    state: randomizeRidges(rand),
    travel: 0,
  };
}

/**
 * Draws one frame.
 *
 * Rows are indexed by whole numbers of `travel`, not by screen position, which
 * is what makes the flight seamless: a given row keeps its own profile for its
 * whole life and simply slides down as `travel` passes it, and a new one enters
 * at the top each time `travel` crosses an integer. Tying profiles to screen
 * slots instead would make the terrain morph in place rather than approach.
 */
export function renderRidges(ridges: Ridges, params: RidgeParams): void {
  const { w, h, field, horizon, ys, state, travel } = ridges;
  const { rows } = params;

  field.fill(0);
  // Nothing drawn yet, so the horizon starts below the bottom of the screen.
  horizon.fill(h);

  const first = Math.ceil(travel);

  // Nearest first, starting below the bottom edge. The floating horizon only
  // works front to back, and `depth` is negative for the overscan rows.
  for (let k = -params.overscan; k < rows; k++) {
    const worldZ = first + k;
    const depth = (worldZ - travel) / rows;
    if (depth > 1) break;

    const base = rowY(depth, h, params);
    const amp = rowAmplitude(depth, h, params);

    // Entirely below the bottom edge: it can draw nothing, and anything it
    // would occlude is off screen too, so the horizon does not need it either.
    if (base - amp >= h) continue;

    const brightness = rowBrightness(depth, params);

    for (let x = 0; x < w; x++) {
      const u = w > 1 ? x / (w - 1) : 0.5;
      ys[x] = base - ridgeHeight(u, worldZ, params, state) * amp;
    }

    let previous = ys[0];
    for (let x = 0; x < w; x++) {
      const y = ys[x];

      // Fill between this sample and the last, so a steep flank is a
      // continuous line rather than a column of dots.
      const lo = Math.floor(Math.min(previous, y));
      const hi = Math.floor(Math.max(previous, y));
      const limit = horizon[x];

      for (let iy = lo; iy <= hi; iy++) {
        if (iy < 0 || iy >= h) continue;
        // At or below a nearer row's silhouette: hidden.
        if (iy >= limit) continue;
        const index = iy * w + x;
        if (brightness > field[index]) field[index] = brightness;
      }

      previous = y;
    }

    // Only now, so the row could draw at its own height rather than clipping
    // against itself.
    for (let x = 0; x < w; x++) {
      if (ys[x] < horizon[x]) horizon[x] = ys[x];
    }
  }
}

/** Flies forward and redraws. */
export function stepRidges(ridges: Ridges, params: RidgeParams, dt: number): void {
  ridges.travel += params.speed * dt;
  renderRidges(ridges, params);
}
