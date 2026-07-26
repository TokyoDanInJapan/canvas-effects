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

import { fbm, hash2 } from './noise';

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
  /**
   * Fill the space each profile hides, turning the stack from a pile of lines
   * into a pile of solid silhouettes.
   *
   * Costs nothing to work out where: the floating horizon already knows the
   * topmost point covered by nearer rows, so the fill runs from a row's own
   * curve down to that, which is exactly the region belonging to it.
   */
  fill: boolean;
  /**
   * Ceiling on fill brightness, as a fraction of what the fill would otherwise
   * be. Scales both kinds.
   *
   * Without `fillRandom`, the fill is a fraction of the row's own line
   * brightness, and this wants to stay below 1: at 1 the silhouettes are flat
   * and the ridgelines vanish into them.
   *
   * With `fillRandom`, it scales the whole random range, so lowering it darkens
   * every silhouette while leaving them as distinct from each other as before.
   * Near 1 is usually what you want there, since the point is for the fills to
   * spread across the palette.
   */
  fillLevel: number;
  /**
   * Give every profile its own fill value rather than a shade of its own line,
   * so each silhouette takes a different colour from the palette.
   *
   * The value is derived from the row's `worldZ` through the hash rather than
   * rolled per frame, which is the whole trick: a row keeps its colour for its
   * entire life as it slides down the screen. Rolling it per frame would make
   * the whole stack strobe.
   *
   * It deliberately ignores depth, unlike everything else here - the point is
   * that the fills differ from each other, and fading them by distance would
   * pull them all back towards each other. It does respect `fillLevel`, which
   * scales the whole range and so darkens the set without flattening it.
   *
   * Note what the dither does to this. A random value lands between two palette
   * entries, so each fill renders as a mix of two neighbouring colours. That
   * suits the rest of the library, but `dither: false` gives flat single colours
   * instead if that is what you are after.
   */
  fillRandom: boolean;
  /**
   * Fraction of the previous frame kept, 0 to 1 - a ghost trailing each profile.
   *
   * Zero leaves the field a pure function of `travel`, which is the default and
   * what everything else here assumes. Above zero it becomes stateful: each
   * frame starts from the last one faded, so a moving crest smears behind
   * itself.
   *
   * Faded and maxed rather than blended, like the rain's trails: a lerp towards
   * the new frame would dim the lines themselves, and full brightness has to
   * stay exactly 1 or one-cell line art stops surviving the dither.
   *
   * The profiles descend, so the ghost sits above the line - which is the side
   * the occlusion does not clip, so trails need no special handling against it.
   */
  trail: number;

  /** How fast a click wobble spreads, in screen widths per second. */
  wobbleSpeed: number;
  /** Wavelength of the ripple, in screen widths. Sets how many crests show. */
  wobbleWavelength: number;
  /** Peak vertical displacement, as a fraction of the field height. */
  wobbleAmplitude: number;
  /** Seconds a wobble lasts. */
  wobbleLifetime: number;
  /**
   * How far apart consecutive rows count as, in the same units as the
   * horizontal spread.
   *
   * This is the dial between a wobble that runs *along* the line it struck and
   * one that spreads *across* the stack. Small values put the rows close
   * together in the metric, so the disturbance reaches its neighbours almost as
   * fast as it travels sideways.
   */
  wobbleRowSpacing: number;
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
  // Both off, so the default is the line stack this started as.
  fill: false,
  fillLevel: 0.34,
  fillRandom: false,
  trail: 0,
  wobbleSpeed: 0.55,
  wobbleWavelength: 0.13,
  // About two thirds of a row gap at the defaults, so a crest is clearly a
  // displacement of the line rather than enough to shove it through its
  // neighbour.
  wobbleAmplitude: 0.045,
  wobbleLifetime: 2.2,
  // Crosses roughly 26 of the 34 rows over a wobble's life, so it visibly
  // travels through the stack rather than staying on the line that was hit.
  wobbleRowSpacing: 0.045,
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

/** A click disturbance travelling through the stack. */
export interface Wobble {
  /** The row that was struck, as a whole number of `travel`. */
  z: number;
  /** Where along it, as a fraction of the width. */
  x: number;
  /** Seconds since the click. */
  age: number;
  /** Multiplier on `wobbleAmplitude`. */
  strength: number;
}

/**
 * Which depth a screen row sits at - the inverse of `rowY`.
 *
 * Needed to work out *which* profile a click landed on, since the rows are
 * placed by a perspective curve rather than evenly. Returns a depth clamped to
 * 0..1; the caller turns that into a `worldZ`.
 */
export function depthAtY(y: number, h: number, params: RidgeParams): number {
  const near = params.bottomMargin * h;
  const far = params.topMargin * h;
  const span = near - far;
  if (span <= 0) return 0;

  const t = (y - far) / span;
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  return 1 - Math.pow(t, 1 / params.perspective);
}

/**
 * Vertical displacement the live wobbles apply to one point on one profile, in
 * cells. Negative is up.
 *
 * A wave packet rather than a single bump: an envelope around the travelling
 * front times an oscillation, so a struck line ripples through two or three
 * crests instead of simply heaving once. A lone Gaussian reads as a shockwave,
 * which is a different thing.
 *
 * Distance is measured in a space where a row counts as `wobbleRowSpacing`
 * across, so the same front spreads sideways along the line it struck *and*
 * outward through its neighbours. That is what makes it propagate across the
 * stack rather than staying on one line.
 */
export function wobbleOffset(
  u: number,
  worldZ: number,
  wobbles: readonly Wobble[],
  params: RidgeParams,
  h: number
): number {
  let offset = 0;

  for (let i = 0; i < wobbles.length; i++) {
    const wobble = wobbles[i];
    if (wobble.age < 0 || wobble.age >= params.wobbleLifetime) continue;

    const du = u - wobble.x;
    const dz = (worldZ - wobble.z) * params.wobbleRowSpacing;
    const distance = Math.sqrt(du * du + dz * dz);

    const front = wobble.age * params.wobbleSpeed;
    const phase = (distance - front) / params.wobbleWavelength;

    // Wide enough to show a couple of crests either side of the front.
    const envelope = Math.exp(-((phase / 1.5) * (phase / 1.5)));
    if (envelope < 1e-4) continue;

    const fade = 1 - wobble.age / params.wobbleLifetime;
    const swing = Math.cos(phase * Math.PI * 2);

    offset -= params.wobbleAmplitude * h * wobble.strength * envelope * swing * fade * fade;
  }

  return offset;
}

/**
 * The fill value for one profile, 0.2 to 1.
 *
 * Keyed on `worldZ`, so it is stable for the life of the row - a row identified
 * the same way on every frame gets the same answer, which is what stops the
 * stack strobing as it moves. Floored well above zero so no silhouette comes out
 * invisible against the page.
 */
export function fillShadeFor(worldZ: number, state: RidgeState): number {
  // Offset seed, so the colours are independent of the terrain they sit on.
  return 0.2 + hash2(worldZ, 0, state.seed + 104729) * 0.8;
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
  /** Last frame's field, for `trail`. Unused while it is zero. */
  previous: Float32Array;
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
    previous: new Float32Array(w * h),
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
export function renderRidges(ridges: Ridges, params: RidgeParams, wobbles: readonly Wobble[] = []): void {
  const { w, h, field, horizon, ys, previous, state, travel } = ridges;
  const { rows, trail } = params;

  if (trail > 0) {
    // Start from the last frame, faded. Everything below draws with a max, so
    // this frame's lines overwrite their own ghosts at full strength.
    for (let k = 0; k < field.length; k++) field[k] = previous[k] * trail;
  } else {
    field.fill(0);
  }
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
    // Resolved once per row rather than per column. `fillLevel` scales both
    // kinds, so the dial does something whichever is in use.
    const fillBase = params.fillRandom ? fillShadeFor(worldZ, state) : brightness;
    const fillShade = fillBase * params.fillLevel;

    for (let x = 0; x < w; x++) {
      const u = w > 1 ? x / (w - 1) : 0.5;
      ys[x] = base - ridgeHeight(u, worldZ, params, state) * amp;
      // Applied to the curve before anything is drawn, so the fill and the
      // occlusion follow the wobbled line rather than the flat one.
      if (wobbles.length > 0) ys[x] += wobbleOffset(u, worldZ, wobbles, params, h);
    }

    let previousY = ys[0];
    for (let x = 0; x < w; x++) {
      const y = ys[x];

      // Fill between this sample and the last, so a steep flank is a
      // continuous line rather than a column of dots.
      const lo = Math.floor(Math.min(previousY, y));
      const hi = Math.floor(Math.max(previousY, y));
      const limit = horizon[x];

      for (let iy = lo; iy <= hi; iy++) {
        if (iy < 0 || iy >= h) continue;
        // At or below a nearer row's silhouette: hidden.
        if (iy >= limit) continue;
        const index = iy * w + x;
        if (brightness > field[index]) field[index] = brightness;
      }

      // Everything from under this curve down to the nearer silhouette belongs
      // to this row, and is exactly what a filled stack shows.
      if (params.fill) {
        const shade = fillShade;
        for (let iy = Math.max(0, hi + 1); iy < h && iy < limit; iy++) {
          const index = iy * w + x;
          if (shade > field[index]) field[index] = shade;
        }
      }

      previousY = y;
    }

    // Only now, so the row could draw at its own height rather than clipping
    // against itself.
    for (let x = 0; x < w; x++) {
      if (ys[x] < horizon[x]) horizon[x] = ys[x];
    }
  }

  if (trail > 0) previous.set(field);
}

/** Flies forward and redraws. */
export function stepRidges(ridges: Ridges, params: RidgeParams, dt: number, wobbles: readonly Wobble[] = []): void {
  ridges.travel += params.speed * dt;
  renderRidges(ridges, params, wobbles);
}
