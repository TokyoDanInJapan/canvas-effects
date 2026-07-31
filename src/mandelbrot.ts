// A Mandelbrot zoomer: magnify into the boundary of the set until double
// precision runs out, then pull back and go somewhere else.
//
// THE PICTURE IS ITS OWN DERIVATIVE
// --------------------------------
// Escape time alone does not survive this library's resolution. The bands
// crowd together without limit as you approach the boundary, so at a few
// thousand cells they alias into noise exactly where all the detail is, and
// posterising that to five greys makes it worse rather than better.
//
// The fix is the distance estimate, and here it is free. Write the smooth
// escape count as
//
//   mu = n + 1 - log2(log|z|)
//
// and note what that actually is. The exterior potential of the set is
// `G = log|z_n| / 2^n`, so `log2 G = log2 log|z_n| - n` and therefore
// `mu = 1 - log2 G` exactly - mu is the potential, on a log scale, and nothing
// else. The distance to the set is `d = G / |grad G|`, which in terms of mu is
//
//   d = 1 / (ln2 * |grad mu|)
//
// and `grad mu` is a finite difference over a field that has already been
// computed. No derivative to carry through the iteration, no second pass over
// the orbit: the picture's own gradient is the distance estimate.
//
// It antialiases itself, too, which is the part that makes this viable at 126
// cells across. A filament thinner than a cell is never sampled, so the finite
// difference under-reads the true gradient and returns a distance of about one
// cell rather than zero - and the filament comes out as a soft grey line
// instead of vanishing between two samples. Sub-cell structure fades rather
// than flickering.
//
// Brightness is then a function of distance in *cells*, so it means the same
// thing at every magnification: the picture cannot get busier or emptier as it
// zooms. That is the property a zoomer needs and escape-time shading does not
// have.
//
// WHY IT TURNS ROUND
// ------------------
// A double holds about 16 significant digits, and the coordinates here are of
// order 1, so the plane is resolvable down to roughly 1e-16 - and a *view* has
// to be much wider than that or neighbouring cells land on the same number and
// the picture goes blocky. `minSpan` is where that is called: past it, more
// zoom is not more detail.
//
// Coming back out is a pure function of the span rather than an animation of
// its own:
//
//   centre(span) = deep + (home - deep) * (span - minSpan) / (homeSpan - minSpan)
//
// It is exactly `deep` at the moment of the turn, so there is no jump, and
// exactly `home` when the span is home, so the pull-out lands framed on the
// whole set without anything having to steer it there. In between, the point
// it left sits at a fixed screen position for all but the last instant, so the
// view magnifies about it and never appears to pan.
//
// THE AUTOPILOT AIMS AT A FILAMENT, NOT AT A LAKE
// -----------------------------------------------
// Zooming towards a point picked in advance is how you end up magnifying empty
// space: whatever was interesting at 1x is a featureless interior or a
// featureless exterior twenty doublings later. So the target is re-chosen from
// the frame on screen, every `aimInterval` seconds, and it can never be
// anywhere the current picture has nothing.
//
// What it picks matters as much as that it re-picks, and the obvious score is
// wrong. "The cell closest to the set" walks straight to the edge of the
// nearest lake, and the edge of a lake is a smooth analytic curve: magnify it
// and you get a straight line dividing dark from light, for ever. Steering by
// it put the view 77% to 93% inside the set for stretches of ten seconds at a
// time - a black rectangle with a corner of interest in it.
//
// So a candidate is scored by the patch around it rather than by the cell
// itself, which is the right question: the autopilot is choosing what to
// magnify, not where to stand. A patch with nothing to contrast against is
// refused outright, and what wins among the rest is the most varied - which is
// filigree, and magnifying filigree gives filigree.
//
// There are three refusals rather than one, and that is not belt and braces. A
// frame can be worthless in three ways - a black lake, a flat grey wash of hair
// finer than the sampling, or empty exterior with the set out of shot - and
// taking out any one of them walks the autopilot into another. Each was
// measured, each is written down at the constants, and together they take the
// wasted frames of a descent from around half to about one in fifty.
//
// NOTHING IS SWITCHED, BECAUSE A ZOOM IS ONE COHERENT MOTION
// ----------------------------------------------------------
// The six effects beside this one move diffusely - a fluid churns, rain falls
// in independent lanes - and the eye does not track any of it. A zoom is a
// single motion of the entire frame, the eye locks onto it, and every
// discontinuity in it is visible. Measured as the frame-to-frame change in the
// picture's apparent speed, against the speed it is cruising at, over a full
// cycle on a 60Hz display: this started at 48% on average with single frames
// near 400%, and it is 1.7% and 45% now. Four things were wrong and each is
// noted where it is fixed:
//
//   • The timestep was the fixed one. That belongs to the effects whose
//     integration is only stable over a bounded step; here it just meant equal
//     steps of animation shown for unequal lengths of time. See the note in
//     mandelbrot-background.ts - it was 48% of the 48% on its own.
//   • The rate was switched. Reversing at the floor swapped half a doubling a
//     second inwards for two outwards in one frame. See `turnEase`.
//   • The aim jumped. A single lag chasing a target that moves in steps has a
//     continuous position and a discontinuous velocity, which is a corner every
//     time the autopilot re-aims. See `aimSmooth`.
//   • `frame` was measured from `minSpan` rather than from the span the descent
//     actually stopped at. Nothing in complex units, an eighth of a screen once
//     divided by a span of 1e-7. See `frame`.
//
// Kept DOM-free so it can be unit-tested; the canvas and the loop live in
// mandelbrot-background.ts.

import { approach, aspectOf } from './background.js';

const TAU = Math.PI * 2;

/**
 * Bailout radius, squared.
 *
 * 256 rather than the textbook 2, and it is the smooth escape count that wants
 * it: `n + 1 - log2(log|z|)` is only continuous in the limit of a large
 * bailout, and at 2 the residual step between adjacent bands is a visible
 * fraction of a level. The cost is one or two extra iterations for the cells
 * that escape quickly, which are the cheap ones anyway.
 */
const BAILOUT2 = 65536;

export interface MandelbrotParams {
  /** Doublings of magnification per second on the way in. */
  speed: number;
  /** Multiplier on `speed` for the pull-out. Above 1 rewinds faster than it flew. */
  returnSpeed: number;
  /** Centre of the fully zoomed-out view. */
  homeX: number;
  homeY: number;
  /** Height of the fully zoomed-out view, in complex units. */
  homeSpan: number;
  /**
   * Height of the deepest view, where the zoom turns round.
   *
   * This is a precision limit, not a taste one - see the note above.
   */
  minSpan: number;
  /** Iteration budget at the home view. */
  iterations: number;
  /**
   * Extra iterations per doubling of magnification.
   *
   * Too few and the filigree fills in solid: cells that have not escaped yet
   * are indistinguishable from cells that never will, so the boundary thickens
   * into a blob as you descend. This is the dial that trades that against the
   * per-cell cost, which is linear in it.
   */
  iterationsPerDoubling: number;
  /** Ceiling on the budget, whatever the depth. */
  maxIterations: number;
  /**
   * Width of the glow along the boundary, in field cells.
   *
   * In cells rather than in complex units on purpose: the picture then looks
   * the same at every magnification.
   */
  glow: number;
  /** Strength of the escape-time contours in the open exterior, 0 for none. */
  bands: number;
  /** Iterations per contour. */
  bandWidth: number;
  /** Seconds between the autopilot re-aiming. */
  aimInterval: number;
  /**
   * Seconds of smoothing between the point the autopilot picks and the point
   * the view is drawn towards.
   *
   * A second lag, in front of `aimEase`, and it is there to make the *velocity*
   * continuous rather than just the position. The chosen point jumps - it is a
   * different cell every `aimInterval` - and a single lag chasing a jumping
   * target changes direction in one frame when the target does. Measured
   * against the cruise speed of the zoom, those frames moved the picture up to
   * 2.4 times as far as their neighbours, several times a cycle, which is the
   * wobble you actually see. Two lags in series make the position smooth in its
   * first derivative too, so a re-aim is a curve rather than a corner.
   */
  aimSmooth: number;
  /** Seconds for the view to reach where it is aimed, on its own. */
  aimEase: number;
  /** Seconds for the view to reach where a drag is aiming it. Shorter: it is being steered. */
  steerEase: number;
  /** How far from the preferred point the autopilot will look, in field heights. */
  aimReach: number;
  /** How far off centre the autopilot prefers to aim, in field heights. */
  aimBias: number;
  /**
   * Seconds for the magnification rate to build up or die away.
   *
   * The rate is eased rather than switched, and this is the time constant of
   * it. Every discontinuity this effect had was a switched rate: reversing at
   * the floor swapped half a doubling a second inwards for two outwards in a
   * single frame, which measured as a 2.7x jump in the picture's apparent
   * speed - a visible lurch, twice a cycle.
   *
   * Both turns are then taken *early*, by exactly the distance the
   * deceleration will coast through - `rate * turnEase` doublings - so the
   * descent still asymptotes onto `minSpan` and the pull-out onto `homeSpan`
   * rather than overshooting either. Zero restores the old switched behaviour,
   * and the turn distances collapse to the limits themselves.
   */
  turnEase: number;
  /** Seconds held at each end of the cycle, once the rate has died away. */
  dwell: number;
}

/**
 * Cost is `cells * iterations`, and both ends of that are capped - see
 * `maxFieldCells` and `maxIterations` in mandelbrot-background.ts for the
 * measurements the numbers here were chosen against.
 */
export const MANDELBROT_DEFAULTS: MandelbrotParams = {
  // Half a doubling a second: about fifty seconds from the whole set to the
  // precision floor, which is slow enough to read over and fast enough to be
  // visibly going somewhere.
  speed: 0.5,
  returnSpeed: 4,
  // Not the origin. The set runs from about -2.1 to 0.55 on the real axis, so
  // this centres what is actually there rather than what is symmetric.
  homeX: -0.7,
  homeY: 0,
  homeSpan: 2.6,
  // ~24 doublings below home. Double precision would allow nine or ten more,
  // but each costs iterations on every cell of every frame, and the picture at
  // 24 doublings is the same picture as at 34 - the set is not more detailed
  // further down, only further down.
  minSpan: 1.5e-7,
  iterations: 90,
  iterationsPerDoubling: 12,
  maxIterations: 300,
  // Four cells, which is far wider than "enough to see the boundary" and is
  // chosen for what happens after this field is drawn rather than in it. The
  // output interpolates between field cells before it is dithered, so a rim one
  // cell wide is averaged against its neighbours and most of it is gone by the
  // time it reaches the screen. At 1.2 the set came out as a flat silhouette
  // with no light on it at all; at 4 it has a mantle that survives the
  // interpolation, and past about 6 neighbouring filaments' mantles merge into
  // a wash and the filigree stops reading as filigree.
  glow: 4,
  bands: 0.35,
  bandWidth: 9,
  aimInterval: 0.8,
  // Half the re-aim interval, so a jump is spread over most of the gap before
  // the next one without lagging far enough behind to stop tracking. `aimEase`
  // comes down to 0.9 to pay for the extra stage, which keeps the total
  // settling time about where it was.
  aimSmooth: 0.4,
  aimEase: 0.9,
  steerEase: 0.35,
  aimReach: 0.3,
  aimBias: 0.15,
  // Under half a second, which is a gentle second or so of visible
  // deceleration. Longer costs depth: the coast is `rate * turnEase`
  // doublings, and at the pull-out's two doublings a second every extra tenth
  // is another fifth of a doubling spent slowing down.
  turnEase: 0.45,
  dwell: 1.2,
};

/**
 * The cycle: descend, hold at the bottom, pull out, hold framed on the whole
 * set, descend somewhere else.
 *
 * The two holds are phases of their own rather than a flag on the other two,
 * because the rate is still dying away through them - the view is not
 * motionless, it is coasting to a stop, and it is the coast that lets the
 * descent land on `minSpan` and the pull-out land framed on home.
 */
export type MandelbrotPhase = 'in' | 'holdDeep' | 'out' | 'holdHome';

/** Where the view is, where it is going, and where in the cycle it is. */
export interface MandelbrotState {
  /** Centre of the view, in the complex plane. Doubles, and they have to be. */
  cx: number;
  cy: number;
  /** Height of the view, in complex units. */
  span: number;
  /** The point the autopilot last picked. Jumps; nothing follows it directly. */
  goalX: number;
  goalY: number;
  /** Where the view is being drawn towards - the goal, smoothed. */
  aimX: number;
  aimY: number;
  /** Which part of the cycle the view is in. */
  phase: MandelbrotPhase;
  /**
   * Magnification rate, in doublings per second, negative going in.
   *
   * State rather than a constant because it is eased towards whatever the
   * phase wants rather than set to it. See `turnEase`.
   */
  rate: number;
  /** Seconds until the next re-aim. */
  nextAim: number;
  /** Seconds left of the pause at the end of a run. */
  held: number;
  /**
   * Consecutive scans that found nothing to aim at.
   *
   * Counted rather than acted on at once, because one empty scan is a moment
   * and not a verdict: a frame can be briefly filled by a lake it is already
   * moving off. Turning round on the first would make a small canvas - where
   * the patch window is a large fraction of the frame and harder to satisfy -
   * descend for four seconds at a time and spend the rest of its life pulling
   * out again.
   */
  blind: number;
  /** Where the view had got to when it turned round, and at what span. */
  deepX: number;
  deepY: number;
  deepSpan: number;
  /**
   * Which way off centre the autopilot leans this run.
   *
   * Advanced by the golden angle at each turn rather than rerolled, so
   * successive runs head off in directions that never repeat and never need a
   * generator at step time.
   */
  biasAngle: number;
}

/** The golden angle, in radians. Successive multiples never land near each other. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function randomizeMandelbrot(
  rand: () => number = Math.random,
  params: MandelbrotParams = MANDELBROT_DEFAULTS
): MandelbrotState {
  // Warmed before the one draw this effect makes, and it is not superstition.
  // Unlike the other six there is nothing here to randomise but the direction
  // the autopilot leans - the set is the set - so that single value is the only
  // thing separating one run from another. A weakly seeded generator's first
  // output is not spread over its range: `makeRandom` opens with 0.0002, 0.0004
  // and 0.0013 for seeds 3, 7 and 21, so three "different" runs leaned by less
  // than a fiftieth of a radian and flew identical paths. Found by rendering
  // them and getting the same picture three times.
  for (let i = 0; i < 4; i++) rand();

  return {
    cx: params.homeX,
    cy: params.homeY,
    span: params.homeSpan,
    goalX: params.homeX,
    goalY: params.homeY,
    aimX: params.homeX,
    aimY: params.homeY,
    phase: 'in',
    // From rest, so the opening descent accelerates in like every other one
    // rather than starting at full speed.
    rate: 0,
    nextAim: 0,
    held: 0,
    deepX: params.homeX,
    deepY: params.homeY,
    deepSpan: params.minSpan,
    blind: 0,
    biasAngle: rand() * TAU,
  };
}

/**
 * The smooth escape count at `c`, or `Infinity` if it never escaped.
 *
 * Smooth rather than integer because the whole picture is built on the
 * *gradient* of this: an integer count has a gradient of zero almost
 * everywhere and infinity on the band boundaries, which is no use at all.
 *
 * The two closed-form tests at the top are the main cardioid and the period-2
 * bulb. Between them they are most of the set by area at the home view, and
 * every cell inside them otherwise costs the entire iteration budget.
 */
export function escapeAt(cx: number, cy: number, maxIterations: number): number {
  const dx = cx - 0.25;
  const q = dx * dx + cy * cy;
  if (q * (q + dx) <= 0.25 * cy * cy) return Infinity;
  const bx = cx + 1;
  if (bx * bx + cy * cy <= 0.0625) return Infinity;

  let zx = 0;
  let zy = 0;
  let zx2 = 0;
  let zy2 = 0;
  let n = 0;

  while (n < maxIterations) {
    if (zx2 + zy2 > BAILOUT2) break;
    zy = 2 * zx * zy + cy;
    zx = zx2 - zy2 + cx;
    zx2 = zx * zx;
    zy2 = zy * zy;
    n++;
  }

  // Still inside the bailout with the budget spent. Not a proof that `c` is in
  // the set - only that this frame cannot tell the difference, which is what
  // `iterationsPerDoubling` exists to keep true for longer.
  if (zx2 + zy2 <= BAILOUT2) return Infinity;

  // `log|z|` from `log|z|^2`, so the sqrt goes away.
  return n + 1 - Math.log2(0.5 * Math.log(zx2 + zy2));
}

/**
 * The iteration budget for a view of a given span.
 *
 * Linear in the number of doublings below home, because the number of
 * iterations a point near the boundary survives grows about that fast. Capped,
 * because the per-frame cost is linear in it and a background has a budget.
 */
export function iterationsFor(span: number, params: MandelbrotParams): number {
  const doublings = span > 0 ? Math.log2(params.homeSpan / span) : 0;
  const budget = params.iterations + Math.max(0, doublings) * params.iterationsPerDoubling;
  return Math.min(params.maxIterations, Math.round(budget));
}

/**
 * Brightness for one cell, from its distance to the set in cells and its
 * smooth escape count.
 *
 * Bright at the boundary and dark away from it, so the set reads as a dark
 * silhouette with a luminous rim on a page-coloured field - which is what a
 * background wants, where the usual black-set-on-a-blaze-of-colour is a
 * picture.
 *
 * The contours are faded out by how resolvable they are rather than by taste.
 * They repeat every `bandWidth` iterations, mu changes by `1 / (ln2 * d)` per
 * cell, so they need `d` of at least `2 / (bandWidth * ln2)` cells to survive
 * sampling at all. Below that they are aliasing, and this takes them out
 * exactly where the glow is taking over anyway.
 */
export function brightnessAt(distance: number, escape: number, params: MandelbrotParams): number {
  const halo = params.glow / (distance + params.glow);
  if (params.bands <= 0) return halo;

  const resolvable = 2 / (params.bandWidth * Math.LN2);
  const fade = distance / (distance + resolvable);
  const ripple = 0.5 - 0.5 * Math.cos((TAU * escape) / params.bandWidth);

  // Bands fill what the halo leaves, so the sum cannot leave 0..1.
  const value = halo + params.bands * (1 - halo) * fade * ripple;
  return value > 1 ? 1 : value < 0 ? 0 : value;
}

export interface Mandelbrot {
  w: number;
  h: number;
  /** Brightness per cell, 0 to 1, row-major. This is what gets shaded. */
  field: Float32Array;
  /** Smooth escape count per cell; the budget itself where the cell is interior. */
  escape: Float32Array;
  /** 1 where the cell never escaped. */
  inside: Uint8Array;
  /** Distance to the set per cell, in cells. */
  distance: Float32Array;
  state: MandelbrotState;
  /**
   * Scratch for one complex coordinate. A Float64Array, not a Float32Array: at
   * the deep end the span is 1e-7 about a coordinate of order 1, and a float32
   * cannot hold the difference at all.
   */
  aim: Float64Array;
  /** Scratch for one candidate patch, so the aim scan allocates nothing. */
  patch: Float64Array;
}

export function createMandelbrot(
  w: number,
  h: number,
  rand: () => number = Math.random,
  params: MandelbrotParams = MANDELBROT_DEFAULTS
): Mandelbrot {
  return {
    w,
    h,
    field: new Float32Array(w * h),
    escape: new Float32Array(w * h),
    inside: new Uint8Array(w * h),
    distance: new Float32Array(w * h),
    state: randomizeMandelbrot(rand, params),
    aim: new Float64Array(2),
    patch: new Float64Array(3),
  };
}

/** The complex coordinate a cell samples, written into `out`. */
export function cellToComplex(m: Mandelbrot, i: number, j: number, out: Float64Array): void {
  const { w, h, state } = m;
  const spanY = state.span;
  const spanX = spanY * aspectOf(m);
  out[0] = state.cx + (w > 1 ? i / (w - 1) - 0.5 : 0) * spanX;
  out[1] = state.cy + (h > 1 ? j / (h - 1) - 0.5 : 0) * spanY;
}

/**
 * Radius, in cells, of the patch the autopilot judges a candidate by.
 *
 * Not a dial. It is a stand-in for "what will fill the frame a few seconds from
 * now", and a few seconds of zoom at any sane speed is a patch a handful of
 * cells across.
 */
const AIM_WINDOW = 3;

/**
 * The window a candidate patch has to fall in: interior fraction between
 * `AIM_SOLID_MIN` and `AIM_SOLID_MAX`, mean brightness no more than
 * `AIM_BRIGHT`.
 *
 * Three rejections, and the honest reason there are three is that a picture can
 * be worthless in three different ways and taking out one of them walks the
 * autopilot straight into another. Each is a measured failure, over five seeded
 * runs of a full descent, sampled twice a second:
 *
 * - **Too solid** is the edge of a lake, and the edge of a lake is a smooth
 *   analytic curve: magnify it and you have a straight line dividing dark from
 *   light, for ever. Scoring by nearness to the set alone - the obvious thing -
 *   put the view 77% to 93% interior for stretches of ten seconds.
 * - **Too bright** is dense hair. Brightness runs with nearness to the set, so
 *   a patch bright nearly everywhere is one where every filament is thinner
 *   than a cell: the distance estimate quite correctly reports "within a cell
 *   of the set" for the whole neighbourhood, and the frame comes out flat
 *   mid-grey with stray dark cells where a filament happened to land on a
 *   sample. Those stray cells are the trap - they sit at the far end of the
 *   range from everything around them, so the patch holding one scores a *high*
 *   spread, and arriving there is more of the same. Without this: 36% of frames.
 * - **Too empty** is open exterior, and it is what taking out only the first
 *   two leaves. With no floor on the interior fraction the safest patch is
 *   always the one furthest from the set, and 85% of frames had the set
 *   entirely out of shot - soft grey blobs, no filigree, nothing to recognise.
 *
 * All three together: 2% of frames in any of those states, and the aim search
 * comes up empty twice in five runs rather than seventy-three times, which is
 * what a tighter window costs. It is a window on *this* frame predicting what
 * the next twenty seconds of magnification will look like, so it cannot be
 * exact - and it does not have to be, because it is re-asked every
 * `aimInterval` seconds.
 */
const AIM_SOLID_MIN = 0.1;
const AIM_SOLID_MAX = 0.3;
const AIM_BRIGHT = 0.65;

/** Empty scans in a row before the descent is abandoned. See `blind`. */
const BLIND_LIMIT = 3;

/**
 * What a cell's patch looks like, written into `out` as
 * `[spread, solid, mean]` - the standard deviation of its brightness, the
 * fraction of it that is interior, and its mean brightness.
 *
 * `spread` is the thing worth maximising: the autopilot is choosing what to
 * magnify, so the question is not what the cell is but what its neighbourhood
 * will look like once it fills the screen. The other two are what it has to
 * clear first, and the reasoning is at the constants above.
 */
export function patchAt(m: Mandelbrot, i: number, j: number, out: Float64Array): void {
  const { w, h, field, inside } = m;
  let sum = 0;
  let sumSq = 0;
  let solid = 0;
  let count = 0;

  for (let dj = -AIM_WINDOW; dj <= AIM_WINDOW; dj++) {
    const y = j + dj;
    if (y < 0 || y >= h) continue;
    for (let di = -AIM_WINDOW; di <= AIM_WINDOW; di++) {
      const x = i + di;
      if (x < 0 || x >= w) continue;
      const value = field[y * w + x];
      sum += value;
      sumSq += value * value;
      solid += inside[y * w + x];
      count++;
    }
  }

  if (count === 0) {
    out[0] = 0;
    out[1] = 1;
    out[2] = 1;
    return;
  }

  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  out[0] = variance > 0 ? Math.sqrt(variance) : 0;
  out[1] = solid / count;
  out[2] = mean;
}

/**
 * Draws one frame: escape counts, then distances, then brightness.
 *
 * Two passes rather than one, because the second needs the first's neighbours -
 * which is the whole trick, and the reason there is no derivative being carried
 * through the iteration.
 */
export function renderMandelbrot(m: Mandelbrot, params: MandelbrotParams = MANDELBROT_DEFAULTS): void {
  const { w, h, field, escape, inside, distance, state } = m;
  const budget = iterationsFor(state.span, params);

  const spanY = state.span;
  const spanX = spanY * aspectOf(m);
  const stepX = w > 1 ? spanX / (w - 1) : 0;
  const stepY = h > 1 ? spanY / (h - 1) : 0;
  const x0 = state.cx - (w > 1 ? spanX / 2 : 0);
  const y0 = state.cy - (h > 1 ? spanY / 2 : 0);

  for (let j = 0; j < h; j++) {
    const cy = y0 + j * stepY;
    const row = j * w;
    for (let i = 0; i < w; i++) {
      const mu = escapeAt(x0 + i * stepX, cy, budget);
      const interior = mu === Infinity;
      inside[row + i] = interior ? 1 : 0;
      // The budget, not infinity: this is about to be differenced against its
      // neighbours, and it has to be a number for that to mean anything. It is
      // also the right number - an interior cell is one whose count ran out.
      escape[row + i] = interior ? budget : mu;
    }
  }

  for (let j = 0; j < h; j++) {
    // One-sided at the edges, central everywhere else, and the divisor is the
    // number of cells actually spanned either way.
    const jm = j > 0 ? j - 1 : j;
    const jp = j < h - 1 ? j + 1 : j;
    const dj = jp - jm || 1;
    const row = j * w;

    for (let i = 0; i < w; i++) {
      const k = row + i;
      if (inside[k]) {
        distance[k] = 0;
        field[k] = 0;
        continue;
      }

      const im = i > 0 ? i - 1 : i;
      const ip = i < w - 1 ? i + 1 : i;
      const gx = (escape[row + ip] - escape[row + im]) / (ip - im || 1);
      const gy = (escape[jp * w + i] - escape[jm * w + i]) / dj;
      const gradient = Math.sqrt(gx * gx + gy * gy);

      // A flat neighbourhood means the set is further away than this frame can
      // measure, which is the same thing as very far indeed.
      const d = gradient > 1e-9 ? 1 / (Math.LN2 * gradient) : 1e9;
      distance[k] = d;
      field[k] = brightnessAt(d, escape[k], params);
    }
  }
}

/**
 * Picks somewhere on the current frame worth zooming into, near the cell
 * `(prefI, prefJ)`, and writes its complex coordinate into `m.aim`.
 *
 * Returns false when nothing in the frame clears the window at the constants
 * above - a lake, a wash of unresolvable hair, or open exterior. The caller's
 * cue to give up on this descent, though not on the strength of one scan; see
 * `blind`.
 */
export function aimAt(m: Mandelbrot, params: MandelbrotParams, prefI: number, prefJ: number): boolean {
  const { w, h, inside, distance } = m;
  const patch = m.patch;

  let bestI = -1;
  let bestJ = -1;
  let best = 0;

  /** Scans for the best candidate within `radius` cells of the preference. */
  function search(radius: number): boolean {
    bestI = -1;
    best = 0;
    const limit = radius * radius;

    for (let j = 0; j < h; j++) {
      const dy = j - prefJ;
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (inside[k]) continue;

        const dx = i - prefI;
        const r2 = dx * dx + dy * dy;
        if (r2 > limit) continue;

        patchAt(m, i, j, patch);
        // Filigree, and none of the three ways of having nothing to look at:
        // not the edge of a lake, not open exterior, not hair too fine for the
        // sampling to see. See the constants - each one is a failure that was
        // measured rather than imagined.
        if (patch[1] > AIM_SOLID_MAX || patch[1] < AIM_SOLID_MIN || patch[2] > AIM_BRIGHT) continue;

        // Most to look at once it fills the screen, nearest the set, nearest
        // the preference. The 1 keeps a cell that happens to sit exactly on the
        // boundary from swamping the distance term entirely.
        const score = (patch[0] / (1 + distance[k])) * (1 / (1 + Math.sqrt(r2) / radius));
        if (score > best) {
          best = score;
          bestI = i;
          bestJ = j;
        }
      }
    }

    return bestI >= 0;
  }

  const reach = Math.max(2, params.aimReach * h);
  // Widened rather than given up on: a frame with all its filigree off to one
  // side is still a frame worth steering across.
  if (!search(reach) && !search(w + h)) return false;

  cellToComplex(m, bestI, bestJ, m.aim);
  return true;
}

/**
 * Advances the view by `dt` seconds.
 *
 * `pointer` is where a drag is aiming, normalised to the canvas, or null to
 * leave it on the autopilot. Passing one re-aims this frame rather than waiting
 * for the timer, so steering answers immediately; what it re-aims *at* still
 * goes through `aimAt`, so a pointer parked over the middle of a lake picks the
 * nearest filigree to it rather than taking the view into the dark.
 */
export function stepMandelbrot(
  m: Mandelbrot,
  params: MandelbrotParams,
  dt: number,
  pointer: readonly [number, number] | null = null
): void {
  const s = m.state;

  // The rate is eased towards what the phase wants, never switched to it. See
  // `turnEase` - this one line is most of what makes the cycle smooth.
  const wanted = s.phase === 'in' ? -params.speed : s.phase === 'out' ? params.speed * params.returnSpeed : 0;
  s.rate = approach(s.rate, wanted, dt, params.turnEase);
  if (s.held > 0) s.held -= dt;

  s.span *= Math.pow(2, s.rate * dt);
  // Belt and braces on the precision floor and the framing. The turns are taken
  // early by exactly what the coast covers, so neither of these should ever
  // bite; if `turnEase` is raised past what the cycle has room for, they do.
  if (s.span < params.minSpan) s.span = params.minSpan;
  else if (s.span > params.homeSpan) s.span = params.homeSpan;

  switch (s.phase) {
    case 'in':
      if (s.span <= turnSpan(params, -params.speed) * params.minSpan) {
        endDescent(s, params);
        break;
      }
      steer(m, params, dt, pointer);
      break;

    case 'holdDeep':
      // The span is still falling here, onto `minSpan`. `frame` is a function of
      // it and reads as `deep` throughout, so this looks like a view coming to
      // rest rather than one being held by force.
      frame(s, params);
      if (s.held <= 0) s.phase = 'out';
      break;

    case 'out':
      frame(s, params);
      if (s.span >= params.homeSpan / turnSpan(params, params.speed * params.returnSpeed)) {
        s.phase = 'holdHome';
        s.held = params.dwell;
      }
      break;

    case 'holdHome':
      frame(s, params);
      // Stopped, and actually framed on the whole set rather than merely out of
      // time: the coast is asymptotic, so waiting on the clock alone would
      // start the next descent from a view still visibly cropped.
      if (s.held <= 0 && s.span >= params.homeSpan * HOME_ENOUGH) {
        s.phase = 'in';
        s.goalX = s.cx;
        s.goalY = s.cy;
        s.aimX = s.cx;
        s.aimY = s.cy;
        s.nextAim = 0;
        s.blind = 0;
        s.biasAngle += GOLDEN_ANGLE;
      }
      break;
  }
}

/**
 * The factor a turn is taken early by: what the deceleration from `rate` will
 * coast through, in span.
 *
 * A first-order ease from `rate` to nothing covers exactly `rate * turnEase`
 * doublings, however long it takes to get there - so turning this far out lands
 * the coast on the limit instead of past it.
 *
 * Capped at a third of the cycle's whole range, which is not tidiness. The
 * uncapped distance grows with `speed`, and past about a third of the range the
 * two turns meet in the middle: the pull-out reaches its own turn before it has
 * built up any rate, its target goes to nothing, and the cycle stalls at the
 * bottom for ever. At the defaults the coast is a fifth of a doubling going in
 * and nine tenths coming out, against a range of twenty-four, so this only
 * comes into play for a caller who has turned `speed` or `turnEase` well up -
 * and there it costs a clamped, slightly abrupt turn rather than a dead one.
 */
function turnSpan(params: MandelbrotParams, rate: number): number {
  const range = Math.log2(params.homeSpan / params.minSpan);
  return Math.pow(2, Math.min(Math.abs(rate) * params.turnEase, range / 3));
}

/** How close to the home span counts as framed on the whole set. */
const HOME_ENOUGH = 0.98;

/** Re-aims if it is time to, and draws the view towards wherever it is aimed. */
function steer(m: Mandelbrot, params: MandelbrotParams, dt: number, pointer: readonly [number, number] | null): void {
  const s = m.state;
  s.nextAim -= dt;

  if (pointer || s.nextAim <= 0) {
    s.nextAim = params.aimInterval;

    const bias = pointer ? 0 : params.aimBias * m.h;
    const prefI = pointer ? pointer[0] * (m.w - 1) : (m.w - 1) / 2 + Math.cos(s.biasAngle) * bias;
    const prefJ = pointer ? pointer[1] * (m.h - 1) : (m.h - 1) / 2 + Math.sin(s.biasAngle) * bias;

    if (aimAt(m, params, prefI, prefJ)) {
      s.blind = 0;
      s.goalX = m.aim[0];
      s.goalY = m.aim[1];
    } else if (pointer) {
      // Not counted while a drag has hold. A pointer re-aims every frame rather
      // than every `aimInterval`, so counting here would abandon a descent an
      // eighth of a second after a drag crossed a lake - and yanking the view
      // into a pull-out mid-drag is the last thing wanted. The last aim stands
      // until the pointer finds something.
      s.blind = 0;
    } else if (++s.blind >= BLIND_LIMIT) {
      // Nothing left to look at, and not just for a moment.
      endDescent(s, params);
      return;
    }
  }

  // Two lags in series: the goal jumps, the aim smooths it, the view follows
  // the aim. A drag skips most of the smoothing - a pointer moves continuously,
  // so there is little to smooth and every bit of it is lag you can feel.
  const smooth = pointer ? params.aimSmooth * 0.25 : params.aimSmooth;
  s.aimX = approach(s.aimX, s.goalX, dt, smooth);
  s.aimY = approach(s.aimY, s.goalY, dt, smooth);

  const ease = pointer ? params.steerEase : params.aimEase;
  s.cx = approach(s.cx, s.aimX, dt, ease);
  s.cy = approach(s.cy, s.aimY, dt, ease);
}

/**
 * Where the view sits for a given span once it has stopped descending, which is
 * a function of the span and not something being eased - see the note at the
 * top. Effectively `deep` at the bottom and exactly `home` at the top, with the
 * point it left holding a fixed screen position in between.
 */
function frame(s: MandelbrotState, params: MandelbrotParams): void {
  // Measured from the span the descent actually stopped at, not from `minSpan`,
  // and the difference is not a nicety. The two differ by whatever the coast
  // covered, and while that is nothing in complex units it is divided by a span
  // of about 1e-7 to reach the screen: parameterising from `minSpan` put the
  // view an eighth of a screen away from where the descent left it, in one
  // frame, which measured as a ten-fold jump in apparent speed. From here it is
  // exactly `deep` at the turn and exactly `home` at the top.
  const range = params.homeSpan - s.deepSpan;
  const t = range > 0 ? (s.span - s.deepSpan) / range : 0;
  s.cx = s.deepX + (params.homeX - s.deepX) * t;
  s.cy = s.deepY + (params.homeY - s.deepY) * t;
}

/** Ends a descent: remembers where it got to and starts coasting to a stop. */
function endDescent(s: MandelbrotState, params: MandelbrotParams): void {
  s.deepX = s.cx;
  s.deepY = s.cy;
  s.deepSpan = s.span;
  s.phase = 'holdDeep';
  s.held = params.dwell;
  s.blind = 0;
}
