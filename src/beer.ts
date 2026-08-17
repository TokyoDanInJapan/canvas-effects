// Beer: a glass filled to a set level, fizzing.
//
// Four things stacked in one field, and the order is the whole picture: air at
// the top, a head of foam, the liquid line, and the beer itself with bubbles
// rising through it.
//
// THE BUBBLES ARE METABALLS
// -------------------------
// Each bubble adds Wyvill's falloff to a shared field, exactly as the metaballs
// do, and the field is thresholded. So two bubbles that pass close bulge towards
// each other and fuse into one blob with a smooth neck, and nothing here knows
// about necks - it is only what a sum does when two falloffs overlap. `falloff`
// is imported from `metaballs.ts` rather than copied for that reason: these are
// metaballs, and it should be the same kernel or the claim is not true.
//
// THE SURFACE IS A WAVE FIELD
// ---------------------------
// The liquid line is a one-dimensional wave equation: one height and one
// velocity per column, stepped every frame. Everything the surface does falls
// out of that single system. A bursting bubble splashes it, a drag ploughs a
// bow wave through it, and what reads as sloshing is the waves reflecting
// between the walls - the slosh is the field's fundamental mode, not a thing
// that is animated. An earlier version had a procedural ripple and a single
// tilted-cosine rock bolted together; the wave field replaced both with less
// state and the right behaviour, and the idle shimmer now stops when the fizz
// does, because the fizz is what was causing it.
//
// A LOOP, NOT A SET OF ANIMATIONS
// -------------------------------
// Bubbles nucleate at the bottom, rise and grow, fuse when they overlap enough,
// and pop when they reach the surface. A pop is what feeds the head: it hands
// over its own area as foam, and the head drains exponentially and levels
// sideways in the meantime. So the head's thickness is not animated anywhere. It
// is what the fizz rate and the drain rate settle at, which is why turning
// `rate` down thins it without any other dial being touched.
//
// STATEFUL IN TIME
// ----------------
// Every position accumulates, so this needs a fixed timestep like the rain and
// the smoke, and a settling run before the first paint - a glass with no bubbles
// in it and no head on it does not read as beer.
//
// Kept DOM-free so it can be unit-tested; the canvas and the loop live in
// beer-background.ts.

import { aspectOf, cellSpansOf, type Ageing } from './background.js';
import { falloff } from './metaballs.js';
import { valueNoise } from './noise.js';

export interface BeerParams {
  /**
   * How much of the height is liquid, 0 to 1, measured to the liquid line.
   *
   * The head sits *above* it, so the beer reaches a little higher than this -
   * `fill + headMax` is the top of the foam at its thickest.
   */
  fill: number;
  /** Brightness of the body of the liquid, 0 to 1. */
  liquid: number;
  /** How much darker the bottom of the glass is than the top, as a fraction. */
  depthFade: number;
  /**
   * Softness of the liquid line, in height units.
   *
   * Not zero. A hard line lands on one palette level and reads as a drawn edge;
   * a couple of cells of ramp lets the dither carry it.
   */
  surfaceWidth: number;

  /**
   * How fast surface waves travel, in height units a second.
   *
   * This also sets the slosh, because the surge after a stir is the wave
   * field's fundamental mode and its period is `2 * aspect / waveSpeed` -
   * about 1.8 seconds on a 16:9 window at the default, which is roughly what a
   * pint glass does. A wider window sloshes slower, which is true of real
   * glasses too.
   */
  waveSpeed: number;
  /** How fast the surface calms, as a proportion of its motion lost a second. */
  waveDamping: number;
  /** Ceiling on how far the surface can leave level, in height units. */
  waveMax: number;
  /**
   * The kick a bursting bubble gives the surface, in height units a second,
   * scaled by the bubble's size.
   *
   * This is where an idle surface's motion comes from - there is no procedural
   * ripple. Turn the fizz off and the glass goes glassy still, which is
   * correct: it is the fizz that keeps a real pint's surface alive.
   */
  splash: number;
  /**
   * How hard a stir pushes the surface, per second of pushing.
   *
   * The push is shaped like a bow wave - risen ahead of the drag, dipped
   * behind it - and the shape is antisymmetric, so a stir moves beer about
   * without adding any. See `stirBubbles`.
   */
  slosh: number;

  /** Bubbles nucleating a second, per unit width - so a wide window fizzes more. */
  rate: number;
  /** Ceiling on live bubbles. */
  maxBubbles: number;
  /** Mean bubble radius at nucleation, in height units. */
  radius: number;
  /** Spread on that, as a fraction either side. */
  radiusVariance: number;
  /**
   * Rise speed of a mean-radius bubble, in height units a second.
   *
   * Larger bubbles rise faster, as the square of their radius - see the note
   * in `driftBubbles` for the law and its cap.
   */
  rise: number;
  /**
   * How fast a bubble swells as it rises, as a proportion per second.
   *
   * Real: the pressure above it drops as it climbs. Cheap, and it is most of
   * what stops the fizz reading as a field of identical dots.
   */
  growth: number;
  /** Amplitude of a bubble's zigzag, in height units. */
  sway: number;
  /** How fast it zigzags. */
  swaySpeed: number;
  /**
   * How far two bubbles have to overlap to fuse into one, as a fraction of the
   * sum of their radii. Zero never fuses them.
   *
   * Well under 1, so the field has already drawn them as a single blob by the
   * time the physics agrees: the merge is seen before it happens, which is what
   * keeps it from reading as two dots being replaced by a third.
   */
  merge: number;
  /** How fast a stirred bubble loses the push, as a proportion per second. */
  drift: number;
  /** Field value taken as a bubble's surface. */
  iso: number;
  /** Width of the gradient across that surface, in field units. */
  shoulder: number;
  /** How much brightness a bubble adds to the liquid it is in. */
  bubble: number;

  /** Brightness of the foam. The brightest thing on the canvas. */
  head: number;
  /** Ceiling on the head's thickness, in height units. */
  headMax: number;
  /**
   * Foam made by a popping bubble, as a multiple of its own area.
   *
   * The head is fed in units of area rather than of thickness, so the same fizz
   * builds the same head whatever resolution the field settled at.
   */
  headGain: number;
  /** How fast the head collapses, as a proportion per second. */
  drain: number;
  /**
   * How fast the head levels sideways, as a diffusion coefficient in height
   * units squared a second - so foam travels about `sqrt(2 * spread)` across the
   * glass in a second.
   *
   * Not a blur radius. Pops land where the bubbles were, and without this the
   * head would be a comb of spikes over the busy columns.
   */
  spread: number;
  /** How mottled the foam is - its raggedness at the top and its holes inside. */
  foamTexture: number;
  /** Scale of that mottling, in cycles per height unit. */
  foamScale: number;
  /** How fast the mottling crawls, in lattice units a second. */
  foamDrift: number;

  /** How far a stir reaches, in height units. */
  stirReach: number;
  /** How quickly a bubble takes up the speed of a stir over it, per second. */
  stirStrength: number;
}

export const BEER_DEFAULTS: BeerParams = {
  // Two thirds. Enough liquid to sit behind a column of text, and enough air
  // above it that the head has somewhere to be.
  fill: 0.66,
  // Under half, because this is a background: the body of the beer is the large
  // flat area, and it is the one thing here that has to stay quiet.
  liquid: 0.42,
  depthFade: 0.35,
  surfaceWidth: 0.012,

  // Sets the slosh period as well as how fast a stir's wake crosses the glass;
  // see the note on the option. Doubling it halves the slosh period.
  waveSpeed: 2.0,
  // The surge from a good stir takes two or three swings to die away, and the
  // constant patter of splashes reads as a live surface rather than as chop.
  waveDamping: 1.1,
  waveMax: 0.05,
  // Tuned against the shimmer it produces: at the default fizz the line
  // wanders by a few thousandths of the height - about what the retired
  // procedural ripple faked, only now it has a cause and stops with it.
  splash: 0.02,
  // Sized against the swing it produces rather than reasoned about: a brisk
  // drag along the surface leaves it a few hundredths of the height out of
  // level and sloshing, and a slow sweep barely disturbs it.
  slosh: 20,

  rate: 26,
  maxBubbles: 220,
  // Small - two or three cells at the default resolution - because fizz is
  // fizz. The merging is what produces the occasional large one.
  radius: 0.022,
  radiusVariance: 0.5,
  rise: 0.34,
  growth: 0.16,
  sway: 0.012,
  swaySpeed: 2.6,
  merge: 0.55,
  drift: 2.2,
  iso: 0.5,
  // Wide relative to `iso`, so a bubble's rim crosses several palette levels
  // and dithers rather than showing as a flat disc.
  shoulder: 0.42,
  bubble: 0.5,

  head: 1,
  // A ceiling rather than a working depth. The head settles at about half this,
  // and the gap is what lets a busy patch pile up without the whole top edge
  // flattening against the limit - which is what a head at its ceiling looks
  // like, and it reads as a painted bar rather than as foam.
  headMax: 0.18,
  // A bubble makes rather more foam than its own area: it arrives at the surface
  // as a shell of liquid that stays up there with its neighbours. Tuned against
  // the head this settles at, which is what anyone would actually judge it by -
  // at the default fizz that is about 0.08 of the height, against a ceiling of
  // 0.18, with the busiest columns reaching two thirds of the way to it.
  headGain: 1.1,
  drain: 0.32,
  // Levels foam about seven percent of the height sideways in a second: fast
  // enough that a burst of pops reads as the head thickening rather than as a
  // spike, slow enough to leave the lumps that make it look like foam.
  spread: 0.0025,
  foamTexture: 0.85,
  foamScale: 26,
  foamDrift: 0.6,

  stirReach: 0.22,
  stirStrength: 7,
};

/** One bubble, positioned in field-height units. */
export interface Bubble {
  x: number;
  y: number;
  radius: number;
  /** Speed picked up from a stir, in height units a second. Damped back to nothing. */
  vx: number;
  vy: number;
  /** Where it is in its zigzag, and how fast it goes round. */
  phase: number;
  wobble: number;
}

/**
 * A pointer disturbance: where it is, how fast it was moving, and how long ago.
 *
 * The velocity is the part that matters. A stir is not a position the liquid is
 * pulled towards - it is the speed the pointer was going, handed to whatever is
 * near enough to feel it, which is why a slow drag pushes the fizz gently along
 * and a fast one throws it.
 */
export interface Stir extends Ageing {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface Beer {
  w: number;
  h: number;
  /** Brightness per cell, 0 to 1, row-major. This is what gets shaded. */
  field: Float32Array;
  /** Summed bubble strength, before thresholding. Kept to avoid reallocating. */
  raw: Float32Array;
  /** Head thickness per column, in height units. */
  head: Float32Array;
  /** Scratch for the sideways levelling, which cannot be done in place. */
  headNext: Float32Array;
  /** The liquid line per column, in height units. Refilled every render. */
  line: Float32Array;
  /**
   * The surface: height deviation from the pour line per column, and how fast
   * each column is moving, both in height units. Positive is downward, to
   * match `y`. Together they are the wave field the liquid line is read from.
   */
  wave: Float32Array;
  waveV: Float32Array;
  bubbles: Bubble[];
  /** Elapsed seconds, for the foam's crawl. */
  time: number;
  /** Fractional bubbles owed by the nucleation rate, carried between steps. */
  owed: number;
  /** Seed for the foam's mottling, so a seeded background is repeatable. */
  seed: number;
}

export function createBeer(w: number, h: number, rand: () => number = Math.random, params = BEER_DEFAULTS): Beer {
  const beer: Beer = {
    w,
    h,
    field: new Float32Array(w * h),
    raw: new Float32Array(w * h),
    head: new Float32Array(w),
    headNext: new Float32Array(w),
    line: new Float32Array(w),
    wave: new Float32Array(w),
    waveV: new Float32Array(w),
    bubbles: [],
    time: 0,
    owed: 0,
    seed: Math.floor(rand() * 0x7fffffff),
  };

  seedBubbles(beer, params, rand);
  return beer;
}

/**
 * Fills the glass with the bubbles it would have had if it had been fizzing all
 * along, at random depths.
 *
 * The count is derived rather than guessed: a bubble takes `fill / rise` seconds
 * to climb, and `rate * aspect` of them nucleate a second, so that product is
 * the population the loop settles at anyway. Starting there means the settling
 * run before the first paint only has to build the head.
 */
export function seedBubbles(beer: Beer, params: BeerParams, rand: () => number = Math.random): void {
  const aspect = aspectOf(beer);
  const climb = params.rise > 0 ? params.fill / params.rise : 0;
  const population = Math.min(params.maxBubbles, Math.round(params.rate * aspect * climb));

  for (let i = 0; i < population; i++) {
    // Uniform through the liquid, not all at the bottom, or the first seconds
    // are a rising front rather than a fizz.
    const depth = rand();
    const bubble = addBubble(beer, params, rand, rand() * aspect, 1 - depth * params.fill);
    // Grown by however far up it already is, so the size gradient is there from
    // the first frame rather than developing over the first few seconds.
    if (bubble && params.rise > 0) bubble.radius *= Math.exp(params.growth * ((depth * params.fill) / params.rise));
  }
}

/** Adds one bubble at a point, or returns null if the glass is already full of them. */
export function addBubble(beer: Beer, params: BeerParams, rand: () => number, x: number, y: number): Bubble | null {
  if (beer.bubbles.length >= params.maxBubbles) return null;

  const bubble: Bubble = {
    x,
    y,
    radius: params.radius * (1 - params.radiusVariance + rand() * params.radiusVariance * 2),
    vx: 0,
    vy: 0,
    phase: rand() * Math.PI * 2,
    // Its own rate as well as its own phase, or a crowd of bubbles zigzags in
    // step and the whole field shimmers sideways together.
    wobble: 0.6 + rand() * 0.8,
  };

  beer.bubbles.push(bubble);
  return bubble;
}

/** Linear interpolation across a per-column array, clamped at the walls. */
function sampleColumn(values: Float32Array, spanX: number, x: number): number {
  const last = values.length - 1;
  if (last < 0) return 0;
  if (spanX <= 0 || last === 0) return values[0];

  const at = x / spanX;
  const i = Math.floor(at);
  if (i < 0) return values[0];
  if (i >= last) return values[last];
  return values[i] + (values[i + 1] - values[i]) * (at - i);
}

/**
 * The liquid line at `x`, in height units: the pour line plus whatever the
 * wave field is doing there, interpolated between columns.
 *
 * The waves live per column, so this is the one place their heights become a
 * continuous line - the renderer, the pop test and the drag's scrape check all
 * read the surface through it.
 */
export function surfaceAt(beer: Beer, params: BeerParams, x: number): number {
  const [spanX] = cellSpansOf(beer);
  return 1 - params.fill + sampleColumn(beer.wave, spanX, x);
}

/** The head's thickness at `x`, interpolated between columns. */
export function headAt(beer: Beer, x: number): number {
  const [spanX] = cellSpansOf(beer);
  return sampleColumn(beer.head, spanX, x);
}

/**
 * Ceiling on wave substeps in one frame, so a very fine field cannot make the
 * surface the expensive part of the frame. Past it the waves travel slower
 * than `waveSpeed` asks for, which is a great deal better than the field going
 * unstable - see the cap inside `stepWaves`.
 */
const MAX_WAVE_SUBSTEPS = 48;

/**
 * Advances the surface by `dt`: a one-dimensional wave equation over the
 * columns, with reflecting walls. The reflections are the slosh.
 *
 * Three decisions worth recording:
 *
 * - It is substepped to a CFL limit. An explicit wave step is only stable
 *   while a wave crosses less than a cell per step, and `waveSpeed` is in
 *   height units, so the finer the field the more substeps the same speed
 *   needs. Half a cell rather than the full cell the stability bound allows,
 *   because at the bound the scheme is maximally dispersive and a sharp splash
 *   audibly rings as it spreads. Damping is exponential per substep, so the
 *   decay over a frame is `exp(-waveDamping * dt)` however the frame is
 *   chopped.
 *
 * - The velocity is updated first and the position from the new velocity - the
 *   semi-implicit ordering, for the usual reason: the explicit form feeds
 *   energy into an oscillator, and the surface would slowly work itself rough
 *   rather than settling.
 *
 * - The mean height is subtracted every frame. Stirs and splashes push volume
 *   about and nothing guarantees their sum is zero, so without this the glass
 *   would slowly fill or drain. Subtracting the mean is exact rather than a
 *   fudge: every travelling wave and the slosh itself are zero-mean shapes, so
 *   removing the mean removes only the conjured beer, never the motion.
 */
export function stepWaves(beer: Beer, params: BeerParams, dt: number): void {
  if (dt <= 0 || beer.w < 2) return;
  const { w, wave, waveV } = beer;
  const [spanX] = cellSpansOf(beer);
  if (spanX <= 0 || params.waveSpeed <= 0) return;

  const crossings = (params.waveSpeed * dt) / spanX;
  const steps = Math.min(MAX_WAVE_SUBSTEPS, Math.max(1, Math.ceil(crossings / 0.5)));
  // If the cap bit, slow the wave to what the substeps can carry stably.
  const speed = Math.min(params.waveSpeed, (0.5 * steps * spanX) / dt);
  const sub = dt / steps;
  const pull = (speed * speed * sub) / (spanX * spanX);
  const keep = Math.exp(-params.waveDamping * sub);

  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < w; i++) {
      // Mirrored at the walls, so waves reflect rather than draining out - and
      // the reflection coming back is what a reader calls the slosh.
      const left = wave[i > 0 ? i - 1 : 0];
      const right = wave[i < w - 1 ? i + 1 : w - 1];
      waveV[i] = (waveV[i] + pull * (left - 2 * wave[i] + right)) * keep;
    }
    for (let i = 0; i < w; i++) wave[i] += waveV[i] * sub;
  }

  // Held inside the glass, and levelled to conserve the beer.
  let mean = 0;
  for (let i = 0; i < w; i++) {
    if (wave[i] > params.waveMax) {
      wave[i] = params.waveMax;
      if (waveV[i] > 0) waveV[i] = 0;
    } else if (wave[i] < -params.waveMax) {
      wave[i] = -params.waveMax;
      if (waveV[i] < 0) waveV[i] = 0;
    }
    mean += wave[i];
  }
  mean /= w;
  for (let i = 0; i < w; i++) wave[i] -= mean;
}

/**
 * The bow wave a stir ploughs into the surface: risen ahead of the motion,
 * dipped behind it, which is what a finger pulled through liquid does. The
 * shape is antisymmetric about the stir, so a drag moves beer about without
 * adding any; a vertical pull is a plain push, because dragging up towards the
 * surface lifts it.
 *
 * Attenuated by depth, over twice `stirReach` - the pressure a moving hand
 * makes carries further than its grip does. A stir well below the surface
 * hardly moves it, and one above it - in the air, or in the foam - not at all.
 */
function plough(beer: Beer, params: BeerParams, stir: Stir, fade: number, dt: number): void {
  const { w, wave, waveV } = beer;
  const [spanX] = cellSpansOf(beer);
  const reach = params.stirReach;
  if (spanX <= 0 || reach <= 0) return;

  const base = 1 - params.fill;
  const carry = reach * 2;
  const i0 = Math.max(0, Math.ceil((stir.x - reach) / spanX));
  const i1 = Math.min(w - 1, Math.floor((stir.x + reach) / spanX));

  for (let i = i0; i <= i1; i++) {
    const dx = i * spanX - stir.x;
    const shape = falloff(dx * dx, reach);
    if (shape <= 0) continue;

    const below = stir.y - (base + wave[i]);
    if (below < 0) continue;
    const depth = falloff(below * below, carry);
    if (depth <= 0) continue;

    // `y` grows downward, so a negative contribution raises the surface: the
    // antisymmetric term is negative ahead of the motion, and an upward drag -
    // negative `vy` - lifts the whole reach.
    waveV[i] += (stir.vy - stir.vx * (dx / reach)) * shape * params.slosh * depth * fade * dt;
  }
}

/**
 * Applies the live stirs: bubbles near one are carried along with it, and the
 * surface takes a bow wave from it.
 *
 * A bubble is eased *towards* the stir's speed rather than shoved by it. A shove
 * accumulates - hold the pointer still over a bubble and it accelerates without
 * limit, or to whatever the damping happens to allow - whereas easing towards a
 * speed means the fizz can be carried at the speed of the drag and never faster,
 * however long it is held there.
 *
 * The surface is ploughed by the newest sample only. Every live stir is a
 * sample of the same pointer, so letting each of them push would have a fast
 * drag plough twice over - once through its speed, and once through the extra
 * samples that speed produced. One sample pushing per frame makes the impulse
 * what it should be: the speed of the drag times how long it lasted.
 */
export function stirBubbles(beer: Beer, params: BeerParams, stirs: readonly Stir[], dt: number, lifetime = 1): void {
  if (dt <= 0 || stirs.length === 0) return;

  const newest = stirs[stirs.length - 1];

  for (const stir of stirs) {
    // Squared, so a stir loses its grip gently at first and then lets go.
    const fade = lifetime > 0 ? Math.max(0, 1 - stir.age / lifetime) ** 2 : 0;
    if (fade <= 0) continue;

    if (stir === newest) plough(beer, params, stir, fade, dt);

    for (const bubble of beer.bubbles) {
      const dx = bubble.x - stir.x;
      const dy = bubble.y - stir.y;
      const weight = falloff(dx * dx + dy * dy, params.stirReach) * fade;
      if (weight <= 0) continue;

      // Clamped at 1, so a large `dt` or a strong stir cannot overshoot the
      // pointer's speed and set the bubble ringing.
      const take = Math.min(1, weight * params.stirStrength * dt);
      bubble.vx += (stir.vx - bubble.vx) * take;
      bubble.vy += (stir.vy - bubble.vy) * take;
    }
  }
}

/**
 * Ceiling on how much faster than `rise` a swollen or fused bubble may climb.
 *
 * Area-conserving merges compound: each doubling of area is another 2x on an
 * r-squared law, and a lucky chain of them would hand a bubble the whole glass
 * in a couple of frames without this.
 */
const MAX_RISE_FACTOR = 4;

/**
 * Moves every bubble on by `dt`: buoyancy, zigzag, whatever a stir left it with,
 * and the swelling as the pressure above it drops.
 */
export function driftBubbles(beer: Beer, params: BeerParams, dt: number): void {
  if (dt <= 0) return;

  const aspect = aspectOf(beer);
  // Exponential, so it is frame-rate independent: two half-steps leave the same
  // speed as one whole one.
  const keep = Math.exp(-params.drift * dt);
  const swell = Math.exp(params.growth * dt);
  const meanRadius = params.radius;

  for (const bubble of beer.bubbles) {
    bubble.phase += params.swaySpeed * bubble.wobble * dt;

    // The zigzag is a velocity rather than an offset added to a remembered
    // centre, because a stirred bubble has no centre to return to. Amplitude is
    // held at `sway` whatever the rate, which is why the rate appears here.
    const zigzag = params.sway * params.swaySpeed * bubble.wobble * Math.cos(bubble.phase);

    // Stokes drag: a bubble's terminal speed grows with the *square* of its
    // radius. That is what makes a fresh merge visibly pull away from the crowd
    // it came from, and what leaves the smallest fizz hanging almost still.
    const ratio = meanRadius > 0 ? bubble.radius / meanRadius : 1;
    const lift = ratio * ratio;
    const rise = params.rise * (lift > MAX_RISE_FACTOR ? MAX_RISE_FACTOR : lift);

    bubble.x += (zigzag + bubble.vx) * dt;
    bubble.y += (bubble.vy - rise) * dt;

    bubble.vx *= keep;
    bubble.vy *= keep;
    bubble.radius *= swell;

    // The walls of the glass. Held rather than wrapped: a bubble that reappears
    // on the other side is the one thing here that would look like a bug.
    if (bubble.x < 0) bubble.x = 0;
    else if (bubble.x > aspect) bubble.x = aspect;
  }
}

/**
 * Fuses bubbles that have run into each other, and returns how many pairs went.
 *
 * Area is conserved - `r = sqrt(ra^2 + rb^2)` - and so is momentum, weighted by
 * area, so a fast small bubble catching a slow large one nudges it rather than
 * stopping dead.
 *
 * The pairing walks a sort rather than every pair. The bubbles are kept in x
 * order - an insertion sort, because between frames they barely move, so it is
 * one pass over an already-sorted list and allocates nothing - and each bubble
 * then looks rightward only until the gap is wider than anything left could
 * bridge. Near-linear in practice, where the old every-pair check grew as the
 * square and was the one cost here that would not have survived a much larger
 * `maxBubbles`.
 */
export function fuseBubbles(beer: Beer, params: BeerParams): number {
  if (params.merge <= 0) return 0;
  const bubbles = beer.bubbles;
  if (bubbles.length < 2) return 0;

  for (let i = 1; i < bubbles.length; i++) {
    const bubble = bubbles[i];
    let j = i - 1;
    while (j >= 0 && bubbles[j].x > bubble.x) {
      bubbles[j + 1] = bubbles[j];
      j--;
    }
    bubbles[j + 1] = bubble;
  }

  // The widest reach any pair could have, for the scan's stopping rule.
  let largest = 0;
  for (const bubble of bubbles) if (bubble.radius > largest) largest = bubble.radius;

  let fused = 0;

  for (let i = 0; i < bubbles.length; i++) {
    const a = bubbles[i];
    if (a.radius <= 0) continue;

    for (let j = i + 1; j < bubbles.length; j++) {
      const b = bubbles[j];
      // Sorted, so the first neighbour too far right ends the scan.
      if (b.x - a.x > params.merge * (a.radius + largest)) break;
      if (b.radius <= 0) continue;

      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const reach = params.merge * (a.radius + b.radius);
      if (dx * dx + dy * dy > reach * reach) continue;

      const areaA = a.radius * a.radius;
      const areaB = b.radius * b.radius;
      const total = areaA + areaB;

      a.x = (a.x * areaA + b.x * areaB) / total;
      a.y = (a.y * areaA + b.y * areaB) / total;
      a.vx = (a.vx * areaA + b.vx * areaB) / total;
      a.vy = (a.vy * areaA + b.vy * areaB) / total;
      a.radius = Math.sqrt(total);

      // Marked dead and compacted after the sweep rather than swapped out from
      // under it - a swap would tear the ordering the scan rests on.
      b.radius = 0;
      fused++;
    }
  }

  if (fused > 0) {
    let alive = 0;
    for (let i = 0; i < bubbles.length; i++) {
      if (bubbles[i].radius > 0) bubbles[alive++] = bubbles[i];
    }
    bubbles.length = alive;
  }

  return fused;
}

/**
 * Pops the bubbles that have reached the surface, handing their area to the
 * head and their arrival to the wave field. Returns how many went.
 *
 * The foam lands over the bubble's own footprint rather than in the one column
 * under its centre, and that is not a refinement - it is what makes the head the
 * same thickness at any resolution. A pop carries an *area*, so dropping it into
 * a single column means a thickness of that area divided by the column's width:
 * on a fine field the column is narrow, the thickness is enormous, and almost
 * all of it is lost to `headMax` before the levelling can spread it. Spread over
 * the columns the bubble covers it is the same foam either way, and nothing is
 * clipped.
 */
export function popBubbles(beer: Beer, params: BeerParams): number {
  const bubbles = beer.bubbles;
  const [spanX] = cellSpansOf(beer);
  const aspect = aspectOf(beer);
  const column = spanX > 0 ? spanX : aspect > 0 ? aspect : 1;
  let popped = 0;

  for (let i = 0; i < bubbles.length;) {
    const bubble = bubbles[i];
    const line = surfaceAt(beer, params, bubble.x);

    // Its top edge, not its centre: a bubble bursts when it breaks the surface,
    // not when it has climbed halfway out of the beer.
    if (bubble.y - bubble.radius > line && bubble.y > 0) {
      i++;
      continue;
    }

    const from = spanX > 0 ? Math.round((bubble.x - bubble.radius) / spanX) : 0;
    const to = spanX > 0 ? Math.round((bubble.x + bubble.radius) / spanX) : beer.w - 1;
    const i0 = from < 0 ? 0 : from > beer.w - 1 ? beer.w - 1 : from;
    const i1 = to < 0 ? 0 : to > beer.w - 1 ? beer.w - 1 : to;

    // Divided by the width of the columns it actually lands on rather than by
    // the footprint it ideally covers. On a coarse field those differ by a whole
    // column, which is most of a small bubble's footprint - and rounding it the
    // other way would hand a coarse field half again as much foam per pop.
    const width = (i1 - i0 + 1) * column;
    const thickness = (params.headGain * bubble.radius * bubble.radius) / width;

    // The burst splashes the surface it broke: the bubble leaves a cavity, and
    // the dip and rebound that spread from it are what keep an idle pint's
    // surface moving. There is no other ambient motion anywhere.
    const kick = params.splash * (params.radius > 0 ? bubble.radius / params.radius : 1);

    for (let c = i0; c <= i1; c++) {
      beer.head[c] = Math.min(params.headMax, beer.head[c] + thickness);
      beer.waveV[c] += kick;
    }

    bubbles[i] = bubbles[bubbles.length - 1];
    bubbles.pop();
    popped++;
  }

  return popped;
}

/**
 * Ceiling on the levelling passes in one step, so that a very fine field cannot
 * turn the head into the expensive part of the frame. Past it the head levels
 * more slowly than `spread` asks for, which is a great deal better than the
 * frame rate quietly halving.
 */
const MAX_LEVELLING_PASSES = 24;

/**
 * Drains and levels the head by `dt`.
 *
 * The drain is exponential, so it is frame-rate independent and a head left
 * alone thins away rather than stopping at some floor.
 *
 * The levelling is a diffusion step, with its coefficient converted from height
 * units into columns so that it moves foam the same distance across the glass
 * whatever resolution the field settled at. On a fine field that is more than
 * one explicit step can carry, so it is taken in several small ones rather than
 * clamped down to a single large one - clamping would quietly make `spread` mean
 * something different on every window size.
 */
export function settleHead(beer: Beer, params: BeerParams, dt: number): void {
  if (dt <= 0) return;

  const { w, head, headNext } = beer;
  const [spanX] = cellSpansOf(beer);

  // How much levelling this step asks for, in columns squared. On a fine field
  // it is far more than one explicit step can carry, so it is taken in several -
  // which is what keeps `spread` a physical rate rather than a number whose
  // meaning changes with the window size.
  const wanted = spanX > 0 ? (params.spread * dt) / (spanX * spanX) : 0;

  if (wanted > 0) {
    // A quarter, not the half an explicit diffusion is stable up to. At exactly
    // a half the step degenerates into "replace each column by the mean of its
    // neighbours", which decouples the odd columns from the even ones: a spike
    // then spreads into every other column and leaves a comb along the top of
    // the head that never fills in.
    const passes = Math.min(MAX_LEVELLING_PASSES, Math.max(1, Math.ceil(wanted / 0.25)));
    const k = Math.min(0.25, wanted / passes);

    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i < w; i++) {
        // Reflected at the walls, so foam pushed against the side of the glass
        // piles up there instead of draining out of the array.
        const left = head[i > 0 ? i - 1 : 0];
        const right = head[i < w - 1 ? i + 1 : w - 1];
        headNext[i] = head[i] + k * (left - 2 * head[i] + right);
      }
      head.set(headNext);
    }
  }

  const drained = Math.exp(-params.drain * dt);
  for (let i = 0; i < w; i++) head[i] *= drained;
}

/**
 * One frame of the loop: waves, stir, rise, fuse, pop, settle, nucleate.
 *
 * The order matters in two places. Popping comes after rising, or a bubble
 * spends a frame sticking out of the surface. And the stir comes after the
 * waves, so a drag's push lands on this frame's surface rather than last
 * frame's - one frame of lag on a 24fps effect is visible on a fast flick.
 */
export function stepBeer(
  beer: Beer,
  params: BeerParams,
  rand: () => number,
  dt: number,
  stirs: readonly Stir[] = [],
  stirLifetime = 1
): void {
  if (dt <= 0) return;

  beer.time += dt;

  stepWaves(beer, params, dt);
  stirBubbles(beer, params, stirs, dt, stirLifetime);
  driftBubbles(beer, params, dt);
  fuseBubbles(beer, params);
  popBubbles(beer, params);
  settleHead(beer, params, dt);

  // Nucleation. The debt is carried between steps rather than rounded, so a rate
  // that works out at less than one bubble a frame still produces bubbles at the
  // right rate instead of none at all.
  const aspect = aspectOf(beer);
  beer.owed += params.rate * aspect * dt;
  while (beer.owed >= 1) {
    beer.owed -= 1;
    // Off the floor of the glass, and a radius *below* the bottom edge rather
    // than on it. Nucleating exactly on the last row draws every new bubble at
    // half strength along the bottom of the canvas, which reads as a dotted
    // line rather than as fizz coming up off the base.
    if (!addBubble(beer, params, rand, rand() * aspect, 1 + params.radius)) {
      // Full. The debt is dropped rather than banked, or the moment a bubble
      // pops the backlog fires as a burst.
      beer.owed = 0;
      break;
    }
  }
}

/**
 * Carries a glass over to a resized one: the bubbles and the clock as they are,
 * the per-column state resampled.
 *
 * The bubbles are in height units and so mean the same thing at any resolution,
 * which is why a window drag does not have to empty the glass. The head and the
 * wave field are per column - a column means a different place at a new width -
 * so they are resampled rather than dropped: losing the head on every resize is
 * a visible flash of flat beer, and losing the waves mid-slosh is a surface
 * snapping level for no reason a viewer can see.
 */
export function carryBeer(from: Beer, to: Beer): void {
  to.bubbles = from.bubbles;
  to.time = from.time;
  to.owed = from.owed;
  to.seed = from.seed;

  const [toSpan] = cellSpansOf(to);
  const [fromSpan] = cellSpansOf(from);
  for (let i = 0; i < to.w; i++) {
    const x = i * toSpan;
    to.head[i] = sampleColumn(from.head, fromSpan, x);
    to.wave[i] = sampleColumn(from.wave, fromSpan, x);
    to.waveV[i] = sampleColumn(from.waveV, fromSpan, x);
  }
}

/** How much foam there is, as an area in height units. Exported for tuning and tests. */
export function headVolume(beer: Beer): number {
  const [spanX] = cellSpansOf(beer);
  let total = 0;
  for (const thickness of beer.head) total += thickness;
  return total * (spanX > 0 ? spanX : 1);
}

/** A smoothstep from 0 to 1 across `low` to `high`, flat-tangent at both ends. */
function ramp(value: number, low: number, high: number): number {
  if (high <= low) return value >= high ? 1 : 0;
  const t = (value - low) / (high - low);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/**
 * How much foam is at a point, 0 to 1, given the head's thickness and the liquid
 * line in that column.
 *
 * Density falls off from the liquid line to the top of the head, and the noise
 * is added *before* the threshold rather than multiplied in afterwards. That is
 * what gives the head a ragged top edge rather than a fading one: near the top,
 * density and threshold are close enough that the noise decides which side of it
 * a cell lands on, so the edge breaks into lumps. Deeper in, density wins
 * outright and the noise only mottles the brightness.
 */
export function foamAt(beer: Beer, params: BeerParams, x: number, y: number, thickness: number, line: number): number {
  if (thickness <= 0) return 0;

  // 0 at the liquid line, 1 at the top of the head. Slightly negative is
  // allowed: foam floats a little way into the beer, and letting it do so is
  // what hides the join.
  const depth = (line - y) / thickness;
  if (depth < -0.2 || depth > 1.3) return 0;

  const noise = valueNoise(x * params.foamScale + beer.time * params.foamDrift, y * params.foamScale, beer.seed);
  const density = (1 - depth) * 1.35 + (noise - 0.5) * params.foamTexture;

  const cover = ramp(density, 0.35, 0.65);
  if (cover <= 0) return 0;

  // Mottled rather than flat, so the head reads as packed bubbles instead of as
  // a white bar. A third of the range, which at five greys keeps the foam on the
  // top two levels and lets the dither break it up between them - any less and
  // it quantises to a solid block, any more and the head reads as grey.
  return cover * params.head * (1 - 0.35 * (1 - noise));
}

/**
 * Draws one frame.
 *
 * The renderer only pays full price where the picture is. Three lanes:
 *
 * - Rows above the surface band are air: one `fill(0)` for the whole block.
 * - Rows below it are wet in every column, so a row is its depth shade - one
 *   number - written with a fill, plus the bubbles, applied over their own
 *   bounding boxes only.
 * - The band itself - the foam, the liquid line and the ramp between them, a
 *   tenth or so of the height - walks its cells one by one, exactly as the
 *   whole field used to.
 *
 * That split is most of a millisecond a frame at 1080p: the loop this replaced
 * touched every cell and spent nearly all of its time on cells that were plain
 * liquid or plain air.
 *
 * `raw` never gets a full-field clear. The second pass over the bubble boxes
 * zeroes each cell as it consumes it, so the array is all-zero again by the end
 * of the frame, and cells no bubble touched were never written at all.
 *
 * One approximation makes the fast lane possible: the depth shading is measured
 * from the pour line rather than the wavy instantaneous surface, so a row's
 * shade is one number rather than per-column. The error is the wave height
 * times `depthFade` - under two hundredths of full scale at the defaults, a
 * fraction of one palette level.
 */
export function renderBeer(beer: Beer, params: BeerParams): void {
  const { w, h, field, raw, head, line, bubbles, wave } = beer;
  const [spanX, spanY] = cellSpansOf(beer);
  const base = 1 - params.fill;
  const halfEdge = params.surfaceWidth / 2;

  for (let i = 0; i < w; i++) line[i] = base + wave[i];

  // The surface band: the rows in which anything other than plain liquid or
  // plain air can appear, across all columns - from the top of the tallest
  // foam to the bottom of the deepest surface ramp.
  let top = Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < w; i++) {
    const above = Math.max(1.3 * head[i], halfEdge);
    const below = Math.max(0.2 * head[i], halfEdge);
    if (line[i] - above < top) top = line[i] - above;
    if (line[i] + below > bottom) bottom = line[i] + below;
  }

  let bandFrom = 0;
  let bandTo = h - 1;
  if (spanY > 0) {
    bandFrom = Math.min(h, Math.max(0, Math.floor(top / spanY)));
    bandTo = Math.min(h - 1, Math.max(bandFrom - 1, Math.ceil(bottom / spanY)));
  }

  // Scatter each bubble over its own bounding box - possible because the
  // falloff has compact support - so the accumulation costs the sum of the
  // bubble areas rather than cells times bubbles.
  for (const bubble of bubbles) {
    const i0 = spanX > 0 ? Math.max(0, Math.ceil((bubble.x - bubble.radius) / spanX)) : 0;
    const i1 = spanX > 0 ? Math.min(w - 1, Math.floor((bubble.x + bubble.radius) / spanX)) : w - 1;
    const j0 = spanY > 0 ? Math.max(0, Math.ceil((bubble.y - bubble.radius) / spanY)) : 0;
    const j1 = spanY > 0 ? Math.min(h - 1, Math.floor((bubble.y + bubble.radius) / spanY)) : h - 1;

    for (let j = j0; j <= j1; j++) {
      const dy = j * spanY - bubble.y;
      const dy2 = dy * dy;
      const row = j * w;

      for (let i = i0; i <= i1; i++) {
        const dx = i * spanX - bubble.x;
        raw[row + i] += falloff(dx * dx + dy2, bubble.radius);
      }
    }
  }

  const low = params.iso - params.shoulder;
  const high = params.iso + params.shoulder;
  const denominator = base < 1 ? 1 - base : 1;

  // Air, in one go.
  field.fill(0, 0, bandFrom * w);

  // The band, cell by cell.
  for (let j = bandFrom; j <= bandTo; j++) {
    const y = j * spanY;
    const row = j * w;
    // Held at zero above the pour line, which the foam reaches over. It needs
    // no ceiling: `y` cannot exceed 1 and the denominator is what is left of
    // the glass below the line, so the ratio arrives at 1 at the very bottom
    // and no further.
    const drop = (y - base) / denominator;
    const shade = params.liquid * (1 - params.depthFade * (drop < 0 ? 0 : drop));

    for (let i = 0; i < w; i++) {
      const k = row + i;
      const surface = line[i];

      // 0 in the air, 1 in the beer, and a couple of cells of ramp between
      // them centred on the line itself.
      const wet = ramp(y - surface, -halfEdge, halfEdge);

      let value = 0;
      if (wet > 0) {
        value = wet * shade;

        // Bubbles only count where there is beer around them. One above the
        // line has burst; drawing it would be a light in mid-air.
        const strength = raw[k];
        if (strength > low) value += ramp(strength, low, high) * params.bubble * wet;
      }

      const foam = foamAt(beer, params, i * spanX, y, head[i], surface);
      // Over the top rather than added to it: the head sits on the beer, and
      // adding the two would blow the brightest bubbles out to white.
      if (foam > value) value = foam;

      field[k] = value > 1 ? 1 : value;
    }
  }

  // Below the band every column is wet and foamless, so a row is one number.
  // The depth needs no clamping at either end down here: the band reaches at
  // least to the deepest column's liquid line, and the waves are zero-mean so
  // the deepest line is never above the pour line, which puts every row below
  // the band between the line and the bottom of the glass.
  for (let j = bandTo + 1; j < h; j++) {
    const depth = (j * spanY - base) / denominator;
    const row = j * w;
    field.fill(params.liquid * (1 - params.depthFade * depth), row, row + w);
  }

  // Second visit to the bubble boxes: light the bubbles below the band, and
  // clear `raw` behind them. Consuming a cell zeroes it, so where two boxes
  // overlap the second visit reads zero and adds nothing - which is also what
  // makes the full-field clear unnecessary.
  for (const bubble of bubbles) {
    const i0 = spanX > 0 ? Math.max(0, Math.ceil((bubble.x - bubble.radius) / spanX)) : 0;
    const i1 = spanX > 0 ? Math.min(w - 1, Math.floor((bubble.x + bubble.radius) / spanX)) : w - 1;
    const j0 = spanY > 0 ? Math.max(0, Math.ceil((bubble.y - bubble.radius) / spanY)) : 0;
    const j1 = spanY > 0 ? Math.min(h - 1, Math.floor((bubble.y + bubble.radius) / spanY)) : h - 1;

    for (let j = j0; j <= j1; j++) {
      const row = j * w;

      // Band rows already spent this strength; air rows must not draw it.
      if (j <= bandTo) {
        for (let i = i0; i <= i1; i++) raw[row + i] = 0;
        continue;
      }

      for (let i = i0; i <= i1; i++) {
        const k = row + i;
        const strength = raw[k];
        if (strength === 0) continue;
        raw[k] = 0;
        if (strength > low) {
          const value = field[k] + ramp(strength, low, high) * params.bubble;
          field[k] = value > 1 ? 1 : value;
        }
      }
    }
  }
}
