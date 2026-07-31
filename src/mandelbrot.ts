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
// zoom is not more detail. It is a precision limit and nothing else - the
// iteration budget a frame needs turns out not to grow with depth at all, which
// is measured at the default.
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
import { hash2 } from './noise.js';

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
  /**
   * Screen heights per second the aim walks along the boundary.
   *
   * The aim is not a point that gets replaced any more, it is a point that
   * *travels*, and this is how fast. Following the boundary rather than jumping
   * between targets is what makes the lateral motion smooth: a walked path is
   * continuous by construction, where a re-picked one is a corner however well
   * it is filtered afterwards.
   */
  traceSpeed: number;
  /**
   * Distance from the set, in cells, the walk tries to hold.
   *
   * Brightness here is a function of distance in cells, so a contour of equal
   * brightness *is* a curve at a fixed distance from the set - and the gradient
   * of the field, which is already computed, is normal to it. Walking along the
   * perpendicular traces the boundary at an offset; this is the offset.
   */
  traceDistance: number;
  /** Seconds of descending between pauses to look around. */
  exploreEvery: number;
  /** Seconds spent tracing sideways at one magnification. */
  exploreFor: number;
  /** How many of those pauses back out a little way instead, 0 to 1. */
  retreatChance: number;
  /** Doublings a partial back-out gives up before descending again. */
  retreatDoublings: number;
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
  // ~38 doublings below home, and this was 1.5e-7 - fourteen doublings and a
  // factor of fifteen thousand shallower - on the reasoning that more depth
  // costs iterations on every cell of every frame. That reasoning was wrong,
  // and measuring it is what showed so.
  //
  // The budget a frame needs does not grow with depth. It is set by how much
  // boundary is in shot, not by magnification: holding the false-solid
  // fraction under 5% took between 2,000 and 3,200 iterations at 24 doublings,
  // at 36 and at 48 alike. Flying the autopilot to each of those floors says
  // the same - cost 3.4-3.9 ms, false-solid 18-26%, contrast 0.30-0.35, flat
  // all the way down.
  //
  // What binds is precision, and the useful measure of it is how many
  // representable doubles fit across one field cell. A coordinate of order 1
  // has neighbours 2.2e-16 away, so at this span a cell is about 700 doubles
  // wide; at 44 doublings it is 9, and at 48 it is 1. The distance estimate is
  // a finite difference between cells, so it needs sub-cell room to work in -
  // and rendering the floor at 44 gives a soft-edged blob with no filigree in
  // it at all.
  //
  // Which the obvious metric missed. Counting adjacent cells that land on
  // bit-identical escape counts says 15% at 42 doublings and only reaches 79%
  // at 51, so it looked as though there were room down to the mid-forties. It
  // is far too blunt: exact equality is the last symptom, long after sub-cell
  // structure has gone. The field's contrast is no better - it reads 0.337 at
  // the 44-doubling floor, because a large dark region beside a large light one
  // has plenty of contrast and no structure whatever. Looking at the frame is
  // what settled it.
  //
  // The one real cost is time. A descent takes about 110 seconds now rather
  // than 72, so the cycle is about half again as long - which for a background
  // meant to go unnoticed is not obviously the wrong direction. Raise `speed`
  // for the old cadence at the new depth.
  minSpan: 1e-11,
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
  // How often the aim's surroundings are re-checked, not how often it moves -
  // it moves every frame now. A re-seat only happens if the check fails.
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
  // A twelfth of the screen a second. Fast enough to be going somewhere over
  // the seconds an explore lasts, slow enough that it reads as drift rather
  // than as a pan.
  traceSpeed: 0.085,
  // Just outside the glow, so the walk runs along the lit edge of the filigree
  // rather than through the dark of the set or out in the open.
  traceDistance: 1.6,
  exploreEvery: 9,
  exploreFor: 5,
  // A third of them. Often enough to break the descent up, rare enough that the
  // zoom still feels like it is going somewhere.
  retreatChance: 0.34,
  retreatDoublings: 2.5,
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
export type MandelbrotPhase = 'in' | 'cruise' | 'retreat' | 'holdDeep' | 'out' | 'holdHome';

/** Where the view is, where it is going, and where in the cycle it is. */
export interface MandelbrotState {
  /** Centre of the view, in the complex plane. Doubles, and they have to be. */
  cx: number;
  cy: number;
  /** Height of the view, in complex units. */
  span: number;
  /**
   * The point the view is drawn towards, walked along the boundary each frame.
   *
   * Re-seated by `aimAt` only when the walk runs out of boundary to follow, so
   * the jumps that used to happen every `aimInterval` are now rare events
   * rather than the normal case.
   */
  goalX: number;
  goalY: number;
  /** Which way along the boundary the walk is going. */
  traceSign: number;
  /**
   * The cell `aimAt` would choose right now, refreshed on the `aimInterval`.
   *
   * The walk is drawn towards it rather than being replaced by it, and that
   * blend is what buys both properties at once. Following a contour alone is
   * perfectly continuous and drifts into the glow: measured over four descents,
   * the field's standard deviation - which is what tells a crisp frame from a
   * soft one - sat at 0.237 against 0.334 for views seated the way `aimAt`
   * seats them. Being re-seated outright is the opposite trade, a jump every
   * time. A pull is continuous and still goes where the picker points.
   */
  pickX: number;
  pickY: number;
  /**
   * How hard the walk is currently trying to get out into open exterior, 0 to 1.
   *
   * Positive when the frame has washed out - every cell within a cell of the
   * set, the flat mid-grey of hair below the sampling - and negative when the
   * set has left the picture altogether and what is left is soft exterior glow
   * with no filigree in it. Decays back to nothing in between.
   *
   * Both are invisible from where the walk is standing and obvious from the
   * frame, and neither can be fixed by re-seating: `aimAt` refuses bright
   * patches, so when the *whole frame* is bright it finds nowhere to go at all.
   * One wash measured 22.7 seconds before this.
   */
  openUp: number;
  /** Where the view is being drawn towards - the goal, smoothed. */
  aimX: number;
  aimY: number;
  /**
   * How fast the view is moving, in screen heights per second.
   *
   * Screen units rather than complex ones, and it has to be: the same momentum
   * has to mean the same thing at every magnification, and a velocity in
   * complex units would be a hundred-thousand-fold faster by the bottom of a
   * descent. It is the state that makes the camera a mass rather than a lag -
   * when the aim moves, this is what carries the view through the corner.
   */
  vx: number;
  vy: number;
  /** Which part of the cycle the view is in. */
  phase: MandelbrotPhase;
  /**
   * Magnification rate, in doublings per second, negative going in.
   *
   * State rather than a constant because it is eased towards whatever the
   * phase wants rather than set to it. See `turnEase`.
   */
  rate: number;
  /** Seconds until the aim's surroundings are next checked. */
  nextAim: number;
  /** Seconds of descending left before the next pause to look around. */
  nextExplore: number;
  /** Seconds this descent has been going, for the bias to fade over. */
  descended: number;
  /** The span a partial back-out is climbing to. */
  retreatTo: number;
  /** Which decision the schedule is on, and the seed it draws them from. */
  events: number;
  seed: number;
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
  // Warmed before the draws this effect makes, and it is not superstition.
  // Unlike the other six there is nothing here to randomise but the direction
  // the autopilot leans - the set is the set - so that single value is the only
  // thing separating one run from another. A weakly seeded generator's first
  // output is not spread over its range: `makeRandom` opens with 0.0002, 0.0004
  // and 0.0013 for seeds 3, 7 and 21, so three "different" runs leaned by less
  // than a fiftieth of a radian and flew identical paths. Found by rendering
  // them and getting the same picture three times.
  for (let i = 0; i < 4; i++) rand();

  // A whole number for `hash2`, which is where the schedule's variety comes
  // from - the alternative is threading a generator through every call of
  // `stepMandelbrot` for the sake of two decisions a minute.
  const seed = Math.floor(rand() * 0x7fffffff);

  return {
    cx: params.homeX,
    cy: params.homeY,
    span: params.homeSpan,
    goalX: params.homeX,
    goalY: params.homeY,
    pickX: params.homeX,
    pickY: params.homeY,
    traceSign: 1,
    openUp: 0,
    aimX: params.homeX,
    aimY: params.homeY,
    vx: 0,
    vy: 0,
    phase: 'in',
    // From rest, so the opening descent accelerates in like every other one
    // rather than starting at full speed.
    rate: 0,
    nextAim: 0,
    // Jittered like every later one. Left at the flat `exploreEvery` it was the
    // one moment of the cycle every seed shared, and three runs side by side
    // paused together.
    nextExplore: params.exploreEvery * (0.6 + hash2(0, 2, seed) * 0.8),
    descended: 0,
    retreatTo: params.homeSpan,
    events: 0,
    seed,
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
  /** Scratch for one axis of the camera spring, one cell coordinate, one lean. */
  spring: Float64Array;
  cell: Float64Array;
  push: Float64Array;
  /** Scratch for the frame's lit fraction, mean brightness and interior share. */
  tone: Float64Array;
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
    spring: new Float64Array(2),
    cell: new Float64Array(2),
    push: new Float64Array(2),
    tone: new Float64Array(3),
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
      // Interior counted as dark, whatever the picture does with it. The
      // rendering lights the inside of the boundary as well as the outside -
      // that is what stopped it flickering - but every threshold these numbers
      // are compared against was measured on "how much lit *exterior* is
      // there", and interior brightness is a rendering choice rather than
      // anything about the structure. See the note in `renderMandelbrot`.
      const dark = inside[y * w + x];
      const value = dark ? 0 : field[y * w + x];
      sum += value;
      sumSq += value * value;
      solid += dark;
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
      const im = i > 0 ? i - 1 : i;
      const ip = i < w - 1 ? i + 1 : i;
      const gx = (escape[row + ip] - escape[row + im]) / (ip - im || 1);
      const gy = (escape[jp * w + i] - escape[jm * w + i]) / dj;
      const gradient = Math.sqrt(gx * gx + gy * gy);

      // A flat neighbourhood means the set is further away than this frame can
      // measure, which is the same thing as very far indeed.
      let d = gradient > 1e-9 ? 1 / (Math.LN2 * gradient) : 1e9;

      // A central difference cannot see a feature one cell wide: with exterior
      // on both sides of a single interior cell the two halves cancel and the
      // estimate comes back saying the set is nowhere near - so a one-cell
      // filament got a dark speck down the middle of its own glow. The
      // classification knows what the difference cannot, and a cell with a
      // neighbour on the other side of the line is on the boundary by
      // definition, whatever the arithmetic makes of its surroundings.
      if (
        (i > 0 && inside[k - 1] !== inside[k]) ||
        (i < w - 1 && inside[k + 1] !== inside[k]) ||
        (j > 0 && inside[k - w] !== inside[k]) ||
        (j < h - 1 && inside[k + w] !== inside[k])
      ) {
        if (d > TOUCHING) d = TOUCHING;
      }

      distance[k] = d;
      // The interior goes through the same estimate as everything else, and
      // that is what stops the picture flickering. It used to be forced to
      // zero - the darkest the palette goes - while the cell beside it, being
      // right against the boundary, came out at one. A cell on the line
      // between them flips classification whenever the view shifts by less
      // than its own width, so it was alternating between the two ends of the
      // palette from frame to frame: 9.25% of cells doing that every frame.
      //
      // Nothing had to be added to fix it, only taken away. An interior cell
      // already carries the budget as its escape count, so the difference
      // against its neighbours means something: flat in the deep interior, so
      // the distance comes out enormous and it is dark, and steep next to the
      // boundary, so it is bright - which is what its exterior neighbour is
      // too. The classification stops being a cliff and the flip stops
      // mattering.
      //
      // The contours are the exception. An interior escape count is the same
      // synthetic number everywhere, so banding it would lay a flat tone over
      // the whole set and shift it every time the budget ticks up. They fade
      // out as the distance goes to nothing anyway, so leaving them off inside
      // costs no continuity at the boundary.
      field[k] = inside[k] ? params.glow / (d + params.glow) : brightnessAt(d, escape[k], params);
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
  const wanted = rateFor(s.phase, params);
  const was = s.rate;
  s.rate = approach(s.rate, wanted, dt, params.turnEase);
  if (s.held > 0) s.held -= dt;

  // The mean of the rate across the step, not the rate at the end of it. The
  // end-of-step value under-integrates a decaying rate by about `dt / 2` of it,
  // which is a twentieth of a doubling a frame at 24fps - and the coast is
  // *aimed* at the limits, so a systematic shortfall means it lands short every
  // time. It did: a pull-out asked to arrive at the home span stopped at 97.4%
  // of it, under the 98% the next descent waits for, and the cycle deadlocked
  // there with nothing left to move it.
  const before = s.span;
  s.span *= Math.pow(2, ((was + s.rate) / 2) * dt);
  // Belt and braces on the precision floor and the framing. The turns are taken
  // early by exactly what the coast covers, so neither of these should ever
  // bite; if `turnEase` is raised past what the cycle has room for, they do.
  if (s.span < params.minSpan) s.span = params.minSpan;
  else if (s.span > params.homeSpan) s.span = params.homeSpan;

  // Magnify about the aim, not about the middle of the screen, and this is the
  // difference between a target the view reaches and one it never does.
  //
  // Zooming about the centre multiplies any screen offset by the zoom factor,
  // so a target that is not already dead centre is being pushed outwards at
  // 2^speed a second - 1.41 at the default - while the spring closes on it at
  // about 1/aimEase, which is 1.11. The zoom wins. Measured over four descents
  // the view sat a median of 0.21 screen heights from its target and a 95th
  // percentile of 0.46, which is most of the way to the edge: it was not
  // lagging behind on the way to arriving, it was never going to arrive.
  //
  // Holding the aim still under the zoom takes the exponential out of the
  // problem entirely, and the spring converges on what is left. It also *is*
  // the smoother motion: the picture then magnifies about a fixed point rather
  // than magnifying and translating at once.
  if (s.phase === 'in' || s.phase === 'cruise' || s.phase === 'retreat') {
    const k = before > 0 ? s.span / before : 1;
    s.cx = s.aimX - (s.aimX - s.cx) * k;
    s.cy = s.aimY - (s.aimY - s.cy) * k;
  }

  switch (s.phase) {
    case 'in':
      if (s.span <= turnSpan(params, -params.speed) * params.minSpan) {
        endDescent(s, params);
        break;
      }
      s.descended += dt;
      steer(m, params, dt, pointer);
      // Only descending counts down to the next pause: an explore should be
      // separated from the next one by a stretch of actual descending, not by
      // wall-clock time it spent not descending.
      if (!pointer && (s.nextExplore -= dt) <= 0) beginExplore(m, params);
      break;

    case 'cruise':
      // The rate is on its way to nothing and then back, so this is not a
      // freeze - it is the zoom easing off while the walk carries on sideways,
      // which is the whole point of it.
      steer(m, params, dt, pointer);
      if ((s.held -= dt) <= 0) resumeDescent(m, params);
      break;

    case 'retreat':
      steer(m, params, dt, pointer);
      // Far enough back out. Not a hard stop: `rateFor` has already begun
      // easing towards the descent by the time this fires.
      if (s.span >= s.retreatTo) resumeDescent(m, params);
      break;

    case 'holdDeep':
      // The span is still falling here, onto `minSpan`. `frame` is a function of
      // it and reads as `deep` throughout, so this looks like a view coming to
      // rest rather than one being held by force.
      frame(m, params, dt);
      if (s.held <= 0) s.phase = 'out';
      break;

    case 'out':
      frame(m, params, dt);
      if (s.span >= params.homeSpan / turnSpan(params, params.speed * params.returnSpeed)) {
        s.phase = 'holdHome';
        s.held = params.dwell;
      }
      break;

    case 'holdHome':
      frame(m, params, dt);
      // Stopped, and actually framed on the whole set rather than merely out of
      // time: the coast is asymptotic, so waiting on the clock alone would
      // start the next descent from a view still visibly cropped.
      // Framed on the whole set, or as framed as it is ever going to be. The
      // second half is not belt and braces: the coast is asymptotic, so a
      // threshold it happens to fall short of is a cycle that never restarts.
      if (s.held <= 0 && (s.span >= params.homeSpan * HOME_ENOUGH || Math.abs(s.rate) < RATE_DEAD)) {
        s.phase = 'in';
        s.goalX = s.cx;
        s.goalY = s.cy;
        s.aimX = s.cx;
        s.aimY = s.cy;
        s.nextAim = 0;
        s.blind = 0;
        s.vx = 0;
        s.vy = 0;
        s.descended = 0;
        s.biasAngle += GOLDEN_ANGLE;
        resumeDescent(m, params);
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

/** What the rate is easing towards in each phase, in doublings a second. */
function rateFor(phase: MandelbrotPhase, params: MandelbrotParams): number {
  switch (phase) {
    case 'in':
      return -params.speed;
    case 'retreat':
      // Gentler than the full pull-out. A partial back-out is meant to read as
      // the view drawing back for a wider look, not as the run being abandoned.
      return params.speed * RETREAT_SPEED;
    case 'out':
      return params.speed * params.returnSpeed;
    default:
      return 0;
  }
}

/** How much faster than the descent a partial back-out climbs. */
const RETREAT_SPEED = 1.6;

/**
 * Starts a pause in the descent - either tracing sideways at this magnification
 * for a few seconds, or giving up a couple of doublings for a wider look.
 *
 * Which, and how long, come from `hash2` over a counter rather than from a
 * generator: two decisions a minute is not worth threading `random` through
 * every call of `stepMandelbrot`, and the counter and seed live in the state,
 * so a seeded background still replays exactly.
 */
function beginExplore(m: Mandelbrot, params: MandelbrotParams): void {
  const s = m.state;
  const roll = hash2(s.events, 0, s.seed);
  const jitter = hash2(s.events, 1, s.seed);
  s.events++;

  // Not near the floor: there is no room to back out into and nothing to be
  // gained by hovering just above the precision limit.
  const headroom = Math.log2(s.span / params.minSpan);

  if (roll < params.retreatChance && headroom > params.retreatDoublings * 2) {
    s.phase = 'retreat';
    s.retreatTo = s.span * Math.pow(2, params.retreatDoublings * (0.6 + jitter * 0.8));
    if (s.retreatTo > params.homeSpan) s.retreatTo = params.homeSpan;
    return;
  }

  s.phase = 'cruise';
  s.held = params.exploreFor * (0.6 + jitter * 0.8);
}

/** Back to descending, with the next pause scheduled. */
function resumeDescent(m: Mandelbrot, params: MandelbrotParams): void {
  const s = m.state;
  s.phase = 'in';
  s.held = 0;
  s.nextExplore = params.exploreEvery * (0.6 + hash2(s.events, 2, s.seed) * 0.8);
}

/** How close to the home span counts as framed on the whole set. */
const HOME_ENOUGH = 0.98;

/** A rate below which nothing further is going to happen, in doublings a second. */
const RATE_DEAD = 0.004;

/**
 * One axis of a critically damped spring, written into `out` as
 * `[position, velocity]`.
 *
 * The standard closed-form damper rather than an integrator, because it is
 * stable for any step - `mountBackground` clamps a returning tab to 100ms, and
 * a spring integrated explicitly at that step size with a one-second time
 * constant is not something to rely on.
 *
 * Critically damped on purpose: it is the fastest approach that never
 * overshoots, and an overshoot in a background reads as a wobble rather than as
 * weight. `smoothTime` is roughly how long it takes to arrive, and is the dial
 * for how heavy the view feels.
 */
export function damp(
  current: number,
  target: number,
  velocity: number,
  smoothTime: number,
  dt: number,
  out: Float64Array
): void {
  if (smoothTime <= 0 || dt <= 0) {
    out[0] = smoothTime <= 0 ? target : current;
    out[1] = smoothTime <= 0 ? 0 : velocity;
    return;
  }

  const omega = 2 / smoothTime;
  const x = omega * dt;
  // A Padé-style fit to `exp(-x)`, which is what makes this exact enough at any
  // step without calling `Math.exp` per axis per frame.
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velocity + omega * change) * dt;
  out[1] = (velocity - omega * temp) * decay;
  out[0] = target + (change + temp) * decay;
}

/** The cell a complex coordinate falls on, fractional, written into `out`. */
function cellOf(m: Mandelbrot, x: number, y: number, out: Float64Array): void {
  const { w, h, state } = m;
  const spanX = state.span * aspectOf(m);
  out[0] = w > 1 ? ((x - state.cx) / spanX + 0.5) * (w - 1) : 0;
  out[1] = h > 1 ? ((y - state.cy) / state.span + 0.5) * (h - 1) : 0;
}

/** How hard the walk pulls back onto its contour, against how hard it runs along it. */
const TRACE_HOLD = 1.5;

/**
 * Seconds for the goal to close on the cell the picker likes.
 *
 * This is the half of the goal's motion that keeps the picture good, and the
 * contour walk is the half that makes it explore. Easing rather than jumping is
 * the whole point: `aimAt` chooses well and chooses discontinuously, and a lag
 * in front of it keeps the choice and loses the jump.
 */
const PICK_EASE = 1.2;

/**
 * How far in or out the walk will move from `traceDistance`, as a multiplier
 * either way, and how long it takes to give the offset back.
 *
 * `openUp` runs from -1 to 1 and is a slow feedback loop on the one number the
 * walk controls - how far from the set it holds - driven by what the whole
 * frame looks like rather than by anything local. Positive climbs out of a
 * wash; negative closes back in when the set has left the picture entirely.
 * Both failures are invisible from where the walk is standing, and obvious from
 * the frame.
 */
const OPEN_UP = 4;
const CLOSE_IN = 0.75;
const OPEN_EASE = 3;

/** The distance from the set the walk is currently holding, in cells. */
function holdingAt(s: MandelbrotState, params: MandelbrotParams): number {
  const scale = s.openUp >= 0 ? 1 + OPEN_UP * s.openUp : 1 + CLOSE_IN * s.openUp;
  return params.traceDistance * scale;
}

/**
 * How far the walk looks for interior to steer away from, in cells, and how
 * hard it leans off it.
 *
 * Following a contour at a fixed distance from the set is not enough on its
 * own, because the shore of a lake is a contour too - and a perfectly good one,
 * seven cells wide, on the edge of something that fills the screen. Left to the
 * contour alone the walk found one about seventeen times a descent, against
 * three or four for the schedule; almost all the cruising the effect did was
 * rescues.
 *
 * So the walk also leans away from wherever the interior around it is, weighted
 * by how much of it there is. The radius has to be well past the patch the
 * quality checks use - a lake that matters is bigger than seven cells - and it
 * is sampled every other cell, which is a couple of hundred reads a frame
 * against the ten thousand cells the render just did.
 */
const LAKE_RADIUS = 9;
const LAKE_PUSH = 2.5;

/**
 * Which way to lean to get away from the interior nearby, written into `out` as
 * a unit vector, and returning how much interior there was to lean off.
 */
function lakePush(m: Mandelbrot, i: number, j: number, out: Float64Array): number {
  const { w, h, inside } = m;
  let sx = 0;
  let sy = 0;
  let solid = 0;
  let count = 0;

  for (let dj = -LAKE_RADIUS; dj <= LAKE_RADIUS; dj += 2) {
    const y = j + dj;
    if (y < 0 || y >= h) continue;
    for (let di = -LAKE_RADIUS; di <= LAKE_RADIUS; di += 2) {
      const x = i + di;
      if (x < 0 || x >= w) continue;
      if (di * di + dj * dj > LAKE_RADIUS * LAKE_RADIUS) continue;
      count++;
      if (!inside[y * w + x]) continue;
      solid++;
      sx += di;
      sy += dj;
    }
  }

  out[0] = 0;
  out[1] = 0;
  if (!count || !solid) return 0;

  // Away from where the interior sits, not towards it.
  const len = Math.sqrt(sx * sx + sy * sy);
  if (len > 1e-6) {
    out[0] = -sx / len;
    out[1] = -sy / len;
  }
  return solid / count;
}

/**
 * Walks the goal one step along the boundary, and says whether it managed to.
 *
 * The field's gradient points towards the set - brightness runs with nearness -
 * so its perpendicular is the contour, and a contour of equal brightness is a
 * curve at a fixed distance from the set. Running along that traces the
 * filigree; leaning towards or away from the set by however far the local
 * distance is off `traceDistance` holds the walk on it.
 *
 * Returns false when there is nothing to follow - off the frame, or a
 * neighbourhood flat enough that the gradient says nothing - which is the
 * caller's cue to have `aimAt` seat the goal somewhere else.
 */
export function traceStep(m: Mandelbrot, params: MandelbrotParams, dt: number): boolean {
  const { w, h, escape, distance, state: s } = m;
  cellOf(m, s.goalX, s.goalY, m.cell);
  const i = Math.round(m.cell[0]);
  const j = Math.round(m.cell[1]);
  if (i < 1 || i > w - 2 || j < 1 || j > h - 2) return false;

  const k = j * w + i;
  // The escape count, not the brightness. Both rise towards the set, so either
  // gives the contour - but the escape count is the potential itself and is
  // untouched by how the picture chooses to shade the interior, where the
  // brightness now turns over and would send the walk back on itself.
  const gx = (escape[k + 1] - escape[k - 1]) / 2;
  const gy = (escape[k + w] - escape[k - w]) / 2;
  const g = Math.sqrt(gx * gx + gy * gy);
  // Flat: either open exterior or the middle of a lake, and in both the
  // direction to walk is undefined rather than merely uninteresting.
  if (g < 1e-4) return false;

  // Towards the set, and the contour at right angles to it.
  const nx = gx / g;
  const ny = gy / g;
  const tx = -ny * s.traceSign;
  const ty = nx * s.traceSign;

  // Positive when the walk has drifted too far out, and the correction is
  // towards the set. Clamped so a walk that strays into the middle of a lake
  // turns round rather than accelerating away.
  const holding = holdingAt(s, params);
  const off = (distance[k] - holding) / holding;
  const lean = off > 1 ? 1 : off < -1 ? -1 : off;

  const weight = lakePush(m, i, j, m.push);
  let dx = tx + nx * lean * TRACE_HOLD + m.push[0] * weight * LAKE_PUSH;
  let dy = ty + ny * lean * TRACE_HOLD + m.push[1] * weight * LAKE_PUSH;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  dx /= len;
  dy /= len;

  // In screen heights, so the walk covers the same fraction of the picture a
  // second whatever the magnification.
  const step = params.traceSpeed * s.span * dt;
  s.goalX += dx * step;
  s.goalY += dy * step;
  return true;
}

/**
 * Seats the goal somewhere worth looking at, and says whether it found
 * anywhere. Reverses the walk's handedness each time, so two re-seats in a row
 * do not send it back along the path it has just come down.
 */
function reseat(m: Mandelbrot, params: MandelbrotParams, pointer: readonly [number, number] | null): boolean {
  const s = m.state;
  const bias = pointer ? 0 : params.aimBias * m.h;
  const prefI = pointer ? pointer[0] * (m.w - 1) : (m.w - 1) / 2 + Math.cos(s.biasAngle) * bias;
  const prefJ = pointer ? pointer[1] * (m.h - 1) : (m.h - 1) / 2 + Math.sin(s.biasAngle) * bias;

  if (!aimAt(m, params, prefI, prefJ)) return false;
  s.pickX = m.aim[0];
  s.pickY = m.aim[1];
  s.goalX = m.aim[0];
  s.goalY = m.aim[1];
  s.traceSign = -s.traceSign;
  return true;
}

/**
 * How much of the preference is where the picker last pointed, against where it
 * would point with no history.
 *
 * Hysteresis, and it is for the aim what `KEEP_SLACK` is for the goal. Nothing
 * stopped the picker hopping between two candidates it scored almost equally,
 * and each hop is both a jolt in the motion and a target that was never
 * arrived at. Preferring where it already pointed settles that without ever
 * refusing a better cell - the preference only breaks ties.
 */
const PICK_HOLD = 0.5;

/**
 * Seconds of descending over which the lean off centre fades.
 *
 * `aimBias` is what sends one run somewhere different from the last, and it
 * does that by preferring a target off to one side. That is right at the start
 * of a descent and wrong for the rest of it: a target held off centre is a
 * target the zoom is permanently pulling away from, since magnification moves
 * anything off centre outwards. So it decides the heading and then gets out of
 * the way.
 */
const BIAS_FADE = 6;

/** Refreshes where the picker is pointing, without moving the goal to it. */
function repick(m: Mandelbrot, params: MandelbrotParams): boolean {
  const s = m.state;

  const lean = Math.exp(-s.descended / BIAS_FADE) * params.aimBias * m.h;
  let prefI = (m.w - 1) / 2 + Math.cos(s.biasAngle) * lean;
  let prefJ = (m.h - 1) / 2 + Math.sin(s.biasAngle) * lean;

  // Towards where it last pointed, if that is still on the frame.
  cellOf(m, s.pickX, s.pickY, m.cell);
  if (m.cell[0] >= 0 && m.cell[0] <= m.w - 1 && m.cell[1] >= 0 && m.cell[1] <= m.h - 1) {
    prefI += (m.cell[0] - prefI) * PICK_HOLD;
    prefJ += (m.cell[1] - prefJ) * PICK_HOLD;
  }

  if (!aimAt(m, params, prefI, prefJ)) return false;
  s.pickX = m.aim[0];
  s.pickY = m.aim[1];
  return true;
}

/**
 * How much of the frame is lit, how bright it is on average, and how much of it
 * is interior, written into `out` as `[lit, mean, solid]`. All three in one
 * pass, because all three are wanted at once and the pass is over every cell of
 * the field.
 *
 * The lit fraction is what "there is something to look at" means here.
 *
 * Not the interior fraction, and that distinction cost a day. The obvious
 * reading of a frame that is 85% interior is a black rectangle, and it is
 * wrong: the set is drawn dark and only its boundary glows, so a frame full of
 * set is a frame full of *silhouette*, and what decides whether it is worth
 * looking at is how much lit edge is in it. Steering on the interior fraction
 * pulled the view off pictures like a lit spike of exterior driven into a dark
 * mass - which is one of the better things this draws - and spent a third of
 * the cycle rescuing frames that needed no rescue.
 *
 * Measured over 1,276 frames of eight full descents: the lit fraction never
 * once fell below 0.107, and averaged 0.15 even in the frames that were more
 * than 80% interior. There is no blank frame in there to find.
 *
 * The mean is for the other end - the wash of hair finer than the sampling,
 * where every cell is correctly within a cell of the set and the picture is a
 * flat mid-grey. The lit fraction cannot tell that from a good frame, since
 * both reach 1.0; the mean separates them cleanly, at 0.75 and above against a
 * 95th percentile of 0.72 for everything else.
 *
 * And the interior fraction is not a quality measure - a frame can be 85%
 * interior and be one of the better things this draws - but zero of it is:
 * that is the set out of shot altogether, and what is left is the soft blur of
 * the exterior glow with no filigree in it anywhere.
 */
export function frameTone(m: Mandelbrot, out: Float64Array): void {
  const { field, inside } = m;
  let lit = 0;
  let sum = 0;
  let solid = 0;
  for (let k = 0; k < field.length; k++) {
    // Exterior only, for the same reason `patchAt` does it - see there.
    const value = inside[k] ? 0 : field[k];
    sum += value;
    if (value > LIT_LEVEL) lit++;
    solid += inside[k];
  }
  out[0] = lit / field.length;
  out[1] = sum / field.length;
  out[2] = solid / field.length;
}

/**
 * The furthest a cell that touches the other side of the classification line
 * can be from the set, in cells. Half of one, because that is where the
 * boundary between two neighbours is.
 */
const TOUCHING = 0.5;

/** Brightness at which a cell counts as lit rather than as background. */
const LIT_LEVEL = 0.25;

/**
 * How little of the frame may be lit, and how bright its mean may be, before
 * the goal is re-seated - and how little lit before the descent stops
 * altogether to let the view get somewhere better.
 *
 * Both are well under anything measured - the floor over eight full descents
 * was 0.107 - so neither fires in normal running. They are here for the
 * configurations nobody has measured: a much smaller field, a much lower
 * iteration budget, a `traceSpeed` turned up past what the walk can follow.
 *
 * Stopping rather than backing out is deliberate. A rescue that gives up two
 * and a half doublings re-descends into the same place: when that was tried,
 * four of eight seeded runs spent 62% of their time retreating and never got
 * more than five doublings down at all. Pausing costs nothing already gained.
 */
const FRAME_DIM = 0.09;
const FRAME_BLANK = 0.06;
const FRAME_WASHED = 0.78;

/** How little of the frame may be set before the walk closes back in on it. */
const FRAME_BARE = 0.04;

/** Seconds the zoom holds off while the view finds something to look at. */
const RESCUE_HOLD = 2.5;

/** Doublings given back to resolve a frame that has washed out. */
const WASH_RETREAT = 1.5;

/**
 * How far off `traceDistance` the walk may drift before the goal is thrown away,
 * as a multiple of it.
 *
 * The keep test asks a different question from the pick test, and asking
 * `aimAt`'s question was wrong twice over. `aimAt` rejects a patch with little
 * interior in it, and a patch that is mostly bright, because both are ways of
 * having nothing to look at *when choosing between whole frames*. But the walk
 * deliberately sits a cell and a half off the boundary, so its patch is bright
 * and nearly empty of interior by construction: 24% of the time it fell under
 * the interior floor and 25% over the brightness ceiling, and the goal was
 * being thrown away about once a second. Every one of those is the jump the
 * walk exists to avoid.
 *
 * What actually matters once a goal has been chosen is whether it is still
 * near the boundary and still on screen. The walk's own contour-holding keeps
 * it there; this is the check that it has not lost the thread.
 */
const KEEP_DRIFT = 4;

/** True if the goal is still on screen and still near the boundary. */
function goalStillGood(m: Mandelbrot, params: MandelbrotParams): boolean {
  const { w, h, inside, distance } = m;
  cellOf(m, m.state.goalX, m.state.goalY, m.cell);
  const i = Math.round(m.cell[0]);
  const j = Math.round(m.cell[1]);

  // Well inside the frame, not merely on it: a goal in the last few cells is
  // about to leave, and the view is still travelling towards it.
  const margin = Math.max(2, Math.round(h * 0.08));
  if (i < margin || i > w - 1 - margin || j < margin || j > h - 1 - margin) return false;

  const k = j * w + i;
  if (inside[k]) return false;
  return distance[k] <= holdingAt(m.state, params) * KEEP_DRIFT;
}

/**
 * Walks the goal, re-seating it when the walk has nowhere to go, and draws the
 * view after it.
 */
function steer(m: Mandelbrot, params: MandelbrotParams, dt: number, pointer: readonly [number, number] | null): void {
  const s = m.state;

  if (pointer) {
    // A drag replaces the walk outright. The pointer chooses roughly and
    // `aimAt` chooses exactly, so it still cannot be steered into the dark.
    if (reseat(m, params, pointer)) s.blind = 0;
  } else {
    // Towards what the picker last liked, then along the boundary from there.
    // The first keeps the frame worth looking at, the second is the exploring;
    // both are continuous, which is why neither shows as a jump.
    s.goalX = approach(s.goalX, s.pickX, dt, PICK_EASE);
    s.goalY = approach(s.goalY, s.pickY, dt, PICK_EASE);

    const walked = traceStep(m, params, dt);
    s.nextAim -= dt;

    // Re-seated when the walk has run out of boundary, or when the periodic
    // check finds it somewhere `aimAt` would not have put it. Both are rare,
    // which is the point: every re-seat is a jump in the aim, and jumps are
    // what the walk exists to avoid.
    const due = s.nextAim <= 0;
    if (due || !walked) frameTone(m, m.tone);
    const lit = due || !walked ? m.tone[0] : 1;
    const tone = due || !walked ? m.tone[1] : 0;

    const bare = due || !walked ? m.tone[2] : 1;

    if (
      !walked ||
      (due && (!goalStillGood(m, params) || lit < FRAME_DIM || tone > FRAME_WASHED || bare < FRAME_BARE))
    ) {
      s.nextAim = params.aimInterval;
      if (reseat(m, params, null)) {
        s.blind = 0;
      } else if (!walked && ++s.blind >= BLIND_LIMIT) {
        // Genuinely nowhere to go: no contour to follow *and* nowhere to seat a
        // new goal. Only that abandons a descent. A frame that merely looks bad
        // while the walk still has a thread to follow is handled below, by
        // stopping rather than by giving up - counting that as blindness cut
        // two of eight runs off after five doublings of a twenty-four doubling
        // descent.
        endDescent(s, params);
        return;
      }
    } else if (due) {
      s.nextAim = params.aimInterval;
      // Not a re-seat: the walk keeps its position and is drawn towards this.
      repick(m, params);
    }

    // Which way the walk is erring, judged from the frame rather than from
    // under its own feet. Out of a wash, back in when the set has left shot.
    if (tone > FRAME_WASHED) s.openUp = 1;
    else if (bare < FRAME_BARE) s.openUp = -1;
    else s.openUp = approach(s.openUp, 0, dt, OPEN_EASE);

    // Nothing worth magnifying, and the two ends of that want opposite things.
    //
    // A washed frame is *under-resolved* - the filaments in it are finer than
    // the cells - and the one move that fixes under-resolution is to back out,
    // which is the same partial retreat the schedule uses. Sending the walk
    // outwards helps and is not enough on its own: in dense hair there is
    // often nowhere within the frame that is far from the set to walk *to*,
    // and the longest wash only came down from 22.7s to 13.3s.
    //
    // A dim frame is the opposite - nothing near enough to be lit - and there
    // backing out would only make it emptier. Stopping lets the walk carry the
    // view to something while the magnification holds.
    if (s.phase === 'in') {
      if (tone > FRAME_WASHED) {
        s.phase = 'retreat';
        s.retreatTo = Math.min(s.span * Math.pow(2, WASH_RETREAT), params.homeSpan);
      } else if (lit < FRAME_BLANK) {
        s.phase = 'cruise';
        s.held = RESCUE_HOLD;
      }
    }
  }

  // The goal moves continuously now, so this is only smoothing the re-seats.
  const smooth = pointer ? params.aimSmooth * 0.25 : params.aimSmooth;
  s.aimX = approach(s.aimX, s.goalX, dt, smooth);
  s.aimY = approach(s.aimY, s.goalY, dt, smooth);

  follow(m, params, dt, pointer ? params.steerEase : params.aimEase);
}

/**
 * Moves the view towards the aim, carrying its momentum.
 *
 * Worked in screen units throughout - the offset is divided by the span going
 * in and multiplied by it coming out - so both the spring and the velocity
 * behind it mean the same thing at every magnification.
 */
function follow(m: Mandelbrot, _params: MandelbrotParams, dt: number, ease: number): void {
  const s = m.state;
  const span = s.span;

  damp((s.cx - s.aimX) / span, 0, s.vx, ease, dt, m.spring);
  const ox = m.spring[0];
  s.vx = m.spring[1];

  damp((s.cy - s.aimY) / span, 0, s.vy, ease, dt, m.spring);
  const oy = m.spring[0];
  s.vy = m.spring[1];

  s.cx = s.aimX + ox * span;
  s.cy = s.aimY + oy * span;
}

/**
 * Where the view sits for a given span once it has stopped descending, which is
 * a function of the span and not something being eased - see the note at the
 * top. Effectively `deep` at the bottom and exactly `home` at the top, with the
 * point it left holding a fixed screen position in between.
 */
function frame(m: Mandelbrot, params: MandelbrotParams, dt: number): void {
  const s = m.state;
  // Measured from the span the descent actually stopped at, not from `minSpan`,
  // and the difference is not a nicety. The two differ by whatever the coast
  // covered, and while that is nothing in complex units it is divided by a span
  // of about 1e-7 to reach the screen: parameterising from `minSpan` put the
  // view an eighth of a screen away from where the descent left it, in one
  // frame, which measured as a ten-fold jump in apparent speed. From here it is
  // exactly `deep` at the turn and exactly `home` at the top.
  const range = params.homeSpan - s.deepSpan;
  const t = range > 0 ? (s.span - s.deepSpan) / range : 0;

  // Sprung onto rather than assigned, so the view carries its momentum across
  // the turn. Assigning it dropped whatever lateral velocity the descent had in
  // a single frame, and every one of the worst frames for smoothness over a
  // whole cycle was one of these transitions.
  //
  // The lag this introduces is a lag onto a target that is itself a smooth
  // function of the span, and `FRAME_EASE` is short against the twelve seconds
  // a pull-out takes - so the framing arrives well before the top, which is
  // where it has to be right.
  s.aimX = s.deepX + (params.homeX - s.deepX) * t;
  s.aimY = s.deepY + (params.homeY - s.deepY) * t;
  follow(m, params, dt, FRAME_EASE);
}

/** Seconds for the view to settle onto the framing the pull-out asks for. */
const FRAME_EASE = 0.5;

/** Ends a descent: remembers where it got to and starts coasting to a stop. */
function endDescent(s: MandelbrotState, params: MandelbrotParams): void {
  s.deepX = s.cx;
  s.deepY = s.cy;
  s.deepSpan = s.span;
  s.phase = 'holdDeep';
  s.held = params.dwell;
  s.blind = 0;
}
