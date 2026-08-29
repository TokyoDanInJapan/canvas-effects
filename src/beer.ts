// Beer: a glass that pours itself, fizzes, and sloshes like a liquid.
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
// THE SURFACE IS SHALLOW WATER
// ----------------------------
// The liquid line is a one-dimensional shallow-water solve: a height per column
// and a depth-averaged flow on the faces between them, stepped every frame.
// The first version was a plucked string - one wave speed everywhere and a
// restoring force pulling every column back to the same line - and it had no
// notion of how much beer any of it stood for. Shallow water does: waves cross
// a full glass faster than the dregs, a sideways stir drives the *flow* and the
// beer piles against the leading wall on its own, and volume is conserved
// because every drop that leaves a column arrives in the next one. The slosh is
// still the field's fundamental mode, not a thing that is animated - it is just
// a better field now.
//
// A LOOP, NOT A SET OF ANIMATIONS
// -------------------------------
// Bubbles stream up from fixed nucleation sites, rise and grow, fuse when they
// overlap enough, and pop when they reach the surface. A pop is what feeds the
// head: it hands over its own area as foam, and the head drains exponentially
// and levels sideways in the meantime. So the head's thickness is not animated
// anywhere. It is what the fizz rate and the drain rate settle at, which is why
// turning `rate` down thins it without any other dial being touched. A crest
// driven too steep breaks, and a breaking crest is where foam comes from in the
// first place - which is why stirring the glass hard thickens the head.
//
// STATEFUL IN TIME
// ----------------
// Every position accumulates, so this needs a fixed timestep like the rain and
// the smoke, and either a settling run before the first paint or a pour - a
// glass with no bubbles in it and no head on it does not read as beer.
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
   * This is the level the glass is poured to, not the level it necessarily
   * holds this frame: `Beer.level` is the live reading, and it climbs to
   * `fill` at `pourRate` when the glass starts short. The head sits *above*
   * the line, so the beer reaches a little higher than this - `fill + headMax`
   * is the top of the foam at its thickest.
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
   * How fast surface waves travel *at the poured line*, in height units a
   * second.
   *
   * Gravity is derived from it - `waveSpeed^2 / fill` - because in shallow
   * water there is no such thing as a wave speed of its own: how fast a wave
   * crosses the glass is settled by gravity and by how deep the beer is. So a
   * glass poured to `fill` sloshes with a period of `2 * aspect / waveSpeed`,
   * about 1.8 seconds on a 16:9 window at the default, and a glass still
   * pouring carries its waves slower - the shallow-water result the old
   * plucked string could not give.
   */
  waveSpeed: number;
  /** How fast the flow calms, as a proportion of its motion lost a second. */
  waveDamping: number;
  /**
   * Viscosity proper, in height units squared a second: the flow smoothing
   * sideways into itself.
   *
   * Drag alone holds every wavelength back by the same amount, which is not
   * how a liquid loses a ripple: a short wave shears itself far harder than a
   * long one and dies in a fraction of the time. This falls on a wave by the
   * square of its wavenumber, so the patter of bursting bubbles fades in a
   * shake while the slosh across the whole glass is barely touched.
   */
  shear: number;
  /**
   * The push a bursting bubble gives the surface, in height units a second,
   * scaled by the bubble's size.
   *
   * The push sets the beer *moving* rather than moving it - it lands on the
   * flow and has to travel before it shows, which is what keeps two dozen
   * arrivals a second reading as a live surface rather than a tremor. This is
   * where an idle surface's motion comes from; there is no procedural ripple.
   * Turn the fizz off and the glass goes glassy still, which is correct: it is
   * the fizz that keeps a real pint's surface alive.
   */
  splash: number;
  /**
   * How hard a stir grips the body of the beer, per second of stirring.
   *
   * A sideways drag accelerates the flow under it rather than raking the
   * surface into a shape: the beer piles against the leading wall because it
   * was set moving towards it, and the bow wave - risen ahead of the drag,
   * dipped behind it - emerges from the flow instead of being drawn. The old
   * code pushed the surface directly, which is the answer rather than the
   * cause, and made the beer lean without ever moving.
   */
  slosh: number;

  /** Bubbles nucleating a second, per unit width - so a wide window fizzes more. */
  rate: number;
  /**
   * Nucleation sites per unit width - the fixed rough spots the fizz streams
   * up from, each with its own pace and bubble size.
   *
   * Real: a bubble needs somewhere to start, and in a real glass those
   * somewheres are scratches that do not move. The standing columns of fizz
   * they produce are most of what makes a glass read as carbonated rather
   * than as static.
   */
  sites: number;
  /**
   * The share of the fizz that rises from the sites, 0 to 1; the rest
   * nucleates anywhere. With no sites at all, everything is anywhere.
   */
  streaming: number;
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
  /**
   * How readily the glass throws droplets, 0 to disable.
   *
   * Three things throw them: a crest breaking hard, a big bubble bursting, and
   * a press on the surface. A droplet is ballistic under the same gravity the
   * waves answer to, and it splashes the surface it lands on - so a hard stir
   * is followed by its own spray coming back down.
   */
  spray: number;
  /**
   * How fast an unfilled glass fills, in height units a second. The pour: the
   * level climbs to `fill` at this rate, fizzing harder on the way - a glass
   * being poured is when the carbonation is liveliest. Zero or less fills it
   * at once.
   */
  pourRate: number;

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
  // A pronounced fade: the bottom of the pour at under half the brightness of
  // the top. At the old five-grey palette this had a band or two to show
  // itself in and read as subtle; at the 64-level default it is a gradient,
  // and it is what gives the glass a bottom.
  depthFade: 0.55,
  surfaceWidth: 0.012,

  // The wave speed at the poured line, which fixes gravity; see the note on
  // the option. Doubling it halves the slosh period.
  waveSpeed: 2.0,
  // Lower than the old blanket damping, because the shear now takes the
  // ripples: the drag only has to bring the slosh to rest over a few swings,
  // and holding it higher deadened exactly the motion worth keeping.
  waveDamping: 0.9,
  shear: 0.0012,
  // Tuned against the shimmer it produces, like its predecessor - only the
  // push now lands on the flow and spreads before it shows, so the same
  // wander of a few thousandths of the height needs a larger figure here.
  splash: 0.05,
  // Sized against the swing it produces rather than reasoned about: a brisk
  // drag along the surface sets the beer piling up the leading wall and
  // sloshing back, and a slow sweep barely disturbs it.
  slosh: 14,

  rate: 26,
  // Half a dozen streams per unit width: enough that a wide window reads as
  // several standing columns of fizz, few enough that each one is its own.
  sites: 6,
  // Most of the fizz through the streams, with enough scattered anywhere that
  // the beer between them still sparkles.
  streaming: 0.65,
  maxBubbles: 220,
  // Small - a few cells at the default resolution - because fizz is fizz. The
  // merging is what produces the occasional large one.
  radius: 0.01,
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
  spray: 1,
  // A brisk first pour: two seconds or so to the default fill line, which is
  // the pace a pint arrives at rather than the pace a tap fills one.
  pourRate: 0.35,

  head: 1,
  // A ceiling rather than a working depth. The head settles at about half this,
  // and the gap is what lets a busy patch pile up without the whole top edge
  // flattening against the limit - which is what a head at its ceiling looks
  // like, and it reads as a painted bar rather than as foam.
  headMax: 0.18,
  // A bubble makes far more foam than its own area: it arrives at the surface
  // as a shell of liquid that stays up there with its neighbours, and at a
  // hundredth-of-the-height radius the shell is most of what the head is made
  // of. Tuned against the head this settles at, which is what anyone would
  // actually judge it by - at the default fizz that is about 0.09 of the
  // height, against a ceiling of 0.18, with the busiest columns reaching two
  // thirds of the way to it.
  headGain: 5.2,
  drain: 0.32,
  // Levels foam about a sixth of the height sideways in a second - six times
  // what it was when pops landed anywhere. The fizz arrives up standing
  // streams now, and at the old rate the head was a range of hills over the
  // busy streams with bare glass between them. Fast enough to join the hills
  // into a band, still slow enough to leave the lumps that make it foam.
  spread: 0.015,
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

/** A fixed rough spot on the glass that fizz streams up from. */
export interface Site {
  x: number;
  /** Its share of the streamed rate. The shares sum to one across the sites. */
  weight: number;
  /** The size character of its bubbles, as a multiple of the mean radius. */
  size: number;
  /** Fractional bubbles owed by its rate, carried between steps. */
  owed: number;
}

/** A droplet in flight above the surface, in field-height units. */
export interface Drop {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
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
  /** Scratch for the sideways levelling and the splash profile. */
  headNext: Float32Array;
  /** The liquid line per column, in height units. Refilled every render. */
  line: Float32Array;
  /**
   * The surface: height deviation from the pour line per column, in height
   * units, positive downward to match `y`.
   */
  wave: Float32Array;
  /**
   * The depth-averaged sideways flow of the beer, in height units a second, on
   * the faces *between* the columns - `flow[k]` sits between columns `k` and
   * `k + 1`. Staggering it against the heights is what keeps a shallow-water
   * solve from ringing: pressure is read across a face, and the flux it drives
   * is carried through that same face, so neighbouring columns cannot drift
   * into the sawtooth a collocated grid allows.
   */
  flow: Float32Array;
  /** Scratch for the face fluxes, kept to avoid reallocating. */
  flux: Float32Array;
  /**
   * The surface the foam rides, as a deviation like `wave`. The head is a raft
   * a finger thick, not a skin: it follows the swell and ignores the pricking
   * of the bubbles under it. See `stepRaft`.
   */
  raft: Float32Array;
  /** The raft's smoothing kernel, normalised. Built once per width. */
  raftKernel: Float32Array;
  /**
   * How much of the height is liquid right now, 0 to 1. Starts at `fill`;
   * a poured glass starts at nothing and climbs there.
   */
  level: number;
  bubbles: Bubble[];
  drops: Drop[];
  sites: Site[];
  /** Elapsed seconds, for the foam's crawl. */
  time: number;
  /** Fractional bubbles owed by the anywhere-rate, carried between steps. */
  owed: number;
  /** Seed for the foam's mottling, so a seeded background is repeatable. */
  seed: number;
}

/**
 * The shallowest beer the waves run in, in height units. Below it there is
 * nothing to represent - a film on the bottom of a glass does not slosh - and
 * the arithmetic would be dividing by the film's depth.
 */
const MIN_DEPTH = 0.02;

/**
 * Gravity, in height units a second squared, derived so that a glass poured to
 * `fill` carries its waves at exactly `waveSpeed` - see the note on the option.
 */
function gravityOf(params: BeerParams): number {
  const depth = Math.max(params.fill, MIN_DEPTH);
  return (params.waveSpeed * params.waveSpeed) / depth;
}

/** The raft's smoothing radius for a glass this wide. */
function raftRadius(w: number): number {
  // About an eighth of the glass either side: several times a pop's dimple,
  // and a small part of a slosh's width.
  return Math.min(12, Math.max(2, Math.round(w * 0.12)));
}

export function createBeer(w: number, h: number, rand: () => number = Math.random, params = BEER_DEFAULTS): Beer {
  const faces = Math.max(1, w - 1);
  const r = raftRadius(w);
  const kernel = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let k = -r; k <= r; k++) sum += kernel[k + r] = Math.exp(-2 * (k / r) * (k / r));
  for (let k = 0; k < kernel.length; k++) kernel[k] /= sum;

  const beer: Beer = {
    w,
    h,
    field: new Float32Array(w * h),
    raw: new Float32Array(w * h),
    head: new Float32Array(w),
    headNext: new Float32Array(w),
    line: new Float32Array(w),
    wave: new Float32Array(w),
    flow: new Float32Array(faces),
    flux: new Float32Array(faces),
    raft: new Float32Array(w),
    raftKernel: kernel,
    level: params.fill,
    bubbles: [],
    drops: [],
    sites: [],
    time: 0,
    owed: 0,
    seed: Math.floor(rand() * 0x7fffffff),
  };

  rollSites(beer, params, rand);
  seedBubbles(beer, params, rand);
  return beer;
}

/**
 * Rolls the glass's nucleation sites: where they are, how briskly each one
 * streams, and the size of bubble it makes.
 *
 * The weights are normalised to sum to one, so `rate` stays the total fizz and
 * the sites only decide where it comes up - adding sites never adds bubbles.
 */
export function rollSites(beer: Beer, params: BeerParams, rand: () => number): void {
  const aspect = aspectOf(beer);
  const count = Math.max(0, Math.round(params.sites * aspect));
  beer.sites.length = 0;

  let total = 0;
  for (let i = 0; i < count; i++) {
    // A spread of paces, so the streams read as individuals - but held within
    // a factor of three, because the head is fed where the streams run and
    // the levelling can only carry foam so far: wider odds than this left the
    // head a range of hills over the lucky sites.
    const weight = 0.5 + rand();
    total += weight;
    // Jittered within its own slot rather than dropped anywhere. Placed at
    // uniform random, a third of the glass routinely came up siteless, and
    // the head - fed where the streams run - was bare over the gap. A real
    // glass is scratched all over.
    beer.sites.push({ x: ((i + rand()) / count) * aspect, weight, size: 0.7 + rand() * 0.6, owed: 0 });
  }
  for (const site of beer.sites) site.weight /= total;
}

/**
 * Where the next bubble starts across the glass: usually over a site, with its
 * size character, and sometimes anywhere.
 *
 * Shared by the seeding and the loop, so the streams are standing there from
 * the first frame rather than developing over the first climb.
 */
function nucleate(beer: Beer, params: BeerParams, rand: () => number): { x: number; scale: number } {
  const aspect = aspectOf(beer);
  if (beer.sites.length > 0 && rand() < params.streaming) {
    // Weighted pick, walked rather than tabulated: there are a handful of
    // sites, and the weights sum to one by construction.
    let at = rand();
    let site = beer.sites[beer.sites.length - 1];
    for (const s of beer.sites) {
      at -= s.weight;
      if (at <= 0) {
        site = s;
        break;
      }
    }
    // A couple of radii of jitter, or the stream is a bead chain rather than
    // a column of fizz.
    const x = site.x + (rand() - 0.5) * 4 * params.radius;
    return { x: x < 0 ? 0 : x > aspect ? aspect : x, scale: site.size };
  }
  return { x: rand() * aspect, scale: 1 };
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
    const start = nucleate(beer, params, rand);
    const bubble = addBubble(beer, params, rand, start.x, 1 - depth * params.fill, start.scale);
    // Grown by however far up it already is, so the size gradient is there from
    // the first frame rather than developing over the first few seconds.
    if (bubble && params.rise > 0) bubble.radius *= Math.exp(params.growth * ((depth * params.fill) / params.rise));
  }
}

/**
 * Adds one bubble at a point, or returns null if the glass is already full of
 * them. `scale` is the site's size character - the mean this bubble varies
 * about, as a multiple of `radius`.
 */
export function addBubble(
  beer: Beer,
  params: BeerParams,
  rand: () => number,
  x: number,
  y: number,
  scale = 1
): Bubble | null {
  if (beer.bubbles.length >= params.maxBubbles) return null;

  const bubble: Bubble = {
    x,
    y,
    radius: params.radius * scale * (1 - params.radiusVariance + rand() * params.radiusVariance * 2),
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
 * The liquid line at `x`, in height units: the level the glass currently holds
 * plus whatever the wave field is doing there, interpolated between columns.
 *
 * The waves live per column, so this is the one place their heights become a
 * continuous line - the renderer, the pop test and the drag's scrape check all
 * read the surface through it.
 */
export function surfaceAt(beer: Beer, x: number): number {
  const [spanX] = cellSpansOf(beer);
  return 1 - beer.level + sampleColumn(beer.wave, spanX, x);
}

/** The head's thickness at `x`, interpolated between columns. */
export function headAt(beer: Beer, x: number): number {
  const [spanX] = cellSpansOf(beer);
  return sampleColumn(beer.head, spanX, x);
}

/**
 * Ceiling on wave substeps in one frame, so a very fine field cannot make the
 * surface the expensive part of the frame. When it bites, the flow is clamped
 * and gravity eased until the substeps can carry both stably - the waves run
 * slower than `waveSpeed` asks for, which is a great deal better than the
 * field going unstable. See the budget arithmetic in `stepWaves`.
 *
 * Raised from 48 when the budget became honest: at 48 a 1080p field could not
 * carry the default `waveSpeed` and a stir's flow inside the stability bound
 * at once. The count only runs to the ceiling when the motion demands it, so
 * a quiet glass does not pay for the headroom.
 */
const MAX_WAVE_SUBSTEPS = 96;

/**
 * The fraction of a cell a wave may cross per substep. Under the half-cell
 * the old plucked string ran at, because the momentum term steepens fronts
 * and needs headroom - and no lower, because every hundredth here is another
 * substep on a fine field.
 */
const CFL = 0.45;

/**
 * The steepest face the surface may stand in, as a slope in height units per
 * height unit - about fifty degrees. A slosh across the whole glass runs at a
 * small fraction of this at its steepest, so the limit only ever meets the
 * front of a wave being driven hard, and holding it there keeps nearly all of
 * the swing. See `breakCrests`.
 */
const MAX_FACE = 1.2;

/** How much of the beer a breaking crest lets down comes off as foam. */
const BREAK_FOAM = 0.8;

/** The gentlest break that leaves foam behind, in height units let down. */
const BREAK_FOAM_LEAST = 0.004;

/** The gentlest break that can throw a droplet, in height units let down. */
const BREAK_SPRAY_LEAST = 0.012;

/**
 * Lets a too-steep face down, handing beer from the crest to the trough below
 * it - which is what breaking is.
 *
 * The surface is one height per column, so it can lean at any angle up to
 * vertical and nothing past it. Beer driven hard at a wall does not stop there
 * - it climbs, curls and comes apart - but the height field has no way to say
 * so, and the steepening the flow does on its own would carry the front over
 * in a single column instead: a hard edge standing off the glass. So the front
 * is held to a slope beer can actually stand in, the exchange is symmetric so
 * it moves beer about without inventing any, and what comes over the top is
 * thrown as foam and the odd droplet, since a breaking crest is where both
 * come from in the first place.
 */
export function breakCrests(beer: Beer, params: BeerParams, rand: () => number = Math.random): void {
  const { w, wave, head, flow } = beer;
  if (w < 2) return;
  const [spanX] = cellSpansOf(beer);
  const limit = MAX_FACE * spanX;

  // A front steep over several columns has to be let down one column at a
  // time, so the sweep is repeated until it finds nothing left to do.
  for (let pass = 0; pass < 4; pass++) {
    let quiet = true;
    for (let k = 0; k < w - 1; k++) {
      const d = wave[k + 1] - wave[k];
      const over = Math.abs(d) - limit;
      if (over <= 0) continue;
      quiet = false;

      // Enough beer to bring the face back to the limit, and no more. The
      // crest is the column standing higher, which is the *smaller* height -
      // `wave` is positive downward.
      const move = over / 2;
      const crest = d > 0 ? k : k + 1;
      const trough = d > 0 ? k + 1 : k;
      wave[crest] += move;
      wave[trough] -= move;

      // Only on the first pass, or a front let down over several sweeps pays
      // for the same beer more than once.
      if (pass === 0 && over > BREAK_FOAM_LEAST) {
        const fed = head[crest] + over * BREAK_FOAM;
        head[crest] = fed > params.headMax ? params.headMax : fed;

        if (params.spray > 0 && over > BREAK_SPRAY_LEAST && rand() < 0.5) {
          // Thrown with the flow that broke it, and up by roughly the height
          // it was let down from.
          const g = gravityOf(params);
          addDrop(beer, {
            x: crest * spanX,
            y: 1 - beer.level + wave[crest] - params.radius,
            vx: flow[k] * 0.7,
            vy: -Math.sqrt(2 * g * over) * (0.7 + rand() * 0.6),
            radius: params.radius * (0.5 + rand() * 0.7),
          });
        }
      }
    }
    if (quiet) break;
  }
}

/**
 * Advances the surface by `dt`: one-dimensional shallow water over the
 * columns, with reflecting walls. The reflections are the slosh.
 *
 * `wave` holds the surface as a depression below the level, positive downward
 * to match the screen; `flow` holds the depth-averaged sideways speed of the
 * beer on the faces between the columns. Each substep does momentum first -
 * the surface slope drives the flow, the flow carries itself along, shear
 * smooths it and drag holds it back - and then continuity: what each face
 * carries is the depth on whichever side the flow is coming from, and the
 * upwind choice is what keeps a steep crest steep instead of smearing it into
 * a hump. Volume is conserved because every drop that leaves a column through
 * a face arrives in its neighbour: there is nothing to fudge.
 *
 * Substepped to a CFL limit sized on the wave's speed *and* the flow's,
 * because beer already moving carries the disturbance with it - sized on the
 * wave alone, a hard enough flick sets the pour outrunning the step and the
 * momentum term doubles every substep until the whole surface is NaN.
 *
 * The frame has a speed budget - the most the capped substeps can carry at
 * the scheme's stability edge - and it is split in a fixed order. The flow is
 * clamped first, because it is the one input a pointer can make arbitrarily
 * large, to a few times the wave speed and never more than half the budget;
 * gravity is then eased to whatever the flow left, which is always at least
 * the other half. The order is the fix for a real failure: easing gravity
 * alone let a savage swirl carry flow the substeps could not represent, the
 * advection shredded the surface into a grid-scale sawtooth, and the sawtooth's
 * own slopes pumped the flow straight back up whenever gravity returned - a
 * boil that never settled, held together but never let go by the clamps and
 * the breaker. With both halves budgeted, the arithmetic always fits inside
 * the substeps, and if it is ever ruined anyway the surface is started over
 * rather than handed to the renderer, because a surface of NaN draws as
 * nothing and poisons every frame after it.
 */
export function stepWaves(beer: Beer, params: BeerParams, dt: number, rand: () => number = Math.random): void {
  if (dt <= 0 || beer.w < 2) return;
  if (params.waveSpeed <= 0 || beer.level <= MIN_DEPTH) return;
  const { w, wave, flow, flux } = beer;
  const [spanX] = cellSpansOf(beer);

  const depth = beer.level;
  let g = gravityOf(params);
  let speed = Math.sqrt(g * depth);

  // The frame's speed budget: the most the capped substeps can carry without
  // the arithmetic outrunning them. Nine tenths of a cell per substep - the
  // scheme's real stability edge - rather than the CFL target below, which is
  // an accuracy choice the step count aims for when it has the room.
  const budget = (0.9 * MAX_WAVE_SUBSTEPS * spanX) / dt;

  // The flow's share comes off the top, because the flow is the one input a
  // pointer can make arbitrarily large: a few times the wave speed - beer
  // does not go faster however it is hit - and never more than half the
  // budget. Clamped here, before the substeps are sized, so a wild stir
  // cannot poison the sizing it is about to be stepped with.
  const uCap = Math.min(2.5 * speed, budget * 0.5);
  let uMax = 0;
  for (let k = 0; k < w - 1; k++) {
    const u = flow[k] > uCap ? uCap : flow[k] < -uCap ? -uCap : flow[k];
    flow[k] = u;
    const a = u < 0 ? -u : u;
    if (a > uMax) uMax = a;
  }

  // Gravity is eased to what the flow left - never to nothing, because the
  // flow may never take more than half.
  if (speed > budget - uMax) {
    speed = budget - uMax;
    g = (speed * speed) / depth;
  }

  const steps = Math.min(MAX_WAVE_SUBSTEPS, Math.max(1, Math.ceil((dt * (speed + uMax)) / (spanX * CFL))));
  const sub = dt / steps;
  const fric = params.waveDamping;
  const nu = params.shear;
  // The only bounds on the swing are the glass's own: a crest may climb to
  // the very top of the frame and a trough may fall to a film on the base.
  // There used to be an amplitude ceiling here, and it was the one thing
  // holding a hard swirl back that a real glass would not.
  const most = depth - MIN_DEPTH;
  const least = -(1 - depth);

  for (let s = 0; s < steps; s++) {
    for (let k = 0; k < w - 1; k++) {
      const u = flow[k];
      const slope = (wave[k + 1] - wave[k]) / spanX;
      // The slope of the flow is read from whichever side the flow is arriving
      // from - downstream of itself it has no say in where it is going.
      const du = u > 0 ? u - (k > 0 ? flow[k - 1] : 0) : (k < w - 2 ? flow[k + 1] : 0) - u;
      const adv = (u * du) / spanX;
      // No slip through the walls: the mirror is what reflects a wave back
      // into the glass instead of draining it out of the array.
      const uL = k > 0 ? flow[k - 1] : -u;
      const uR = k < w - 2 ? flow[k + 1] : -u;
      const smooth = (nu * (uL - 2 * u + uR)) / (spanX * spanX);
      const pushed = (u + sub * (g * slope - adv + smooth)) / (1 + fric * sub);
      flow[k] = pushed > uCap ? uCap : pushed < -uCap ? -uCap : pushed;
    }

    for (let k = 0; k < w - 1; k++) {
      const u = flow[k];
      const carried = depth - (u > 0 ? wave[k] : wave[k + 1]);
      flux[k] = u * (carried > 0 ? carried : 0);
    }
    let steepest = 0;
    for (let i = 0; i < w; i++) {
      const fR = i <= w - 2 ? flux[i] : 0;
      const fL = i >= 1 ? flux[i - 1] : 0;
      const moved = wave[i] + (sub * (fR - fL)) / spanX;
      const held = moved > most ? most : moved < least ? least : moved;
      wave[i] = held;
      if (i > 0) {
        const gap = held > wave[i - 1] ? held - wave[i - 1] : wave[i - 1] - held;
        if (gap > steepest) steepest = gap;
      }
    }

    // Let the face down every substep rather than once a frame. Left to the
    // end of the frame the flow has already carried the front past vertical,
    // and the limiter is pulling it back from somewhere it should never have
    // reached. Skipped outright while no face is steep - which is nearly
    // every substep of a quiet glass, and the steepness was measured for
    // nothing above - because a sweep that finds nothing to do still costs a
    // pass over the columns.
    if (steepest > MAX_FACE * spanX) breakCrests(beer, params, rand);
  }

  for (let i = 0; i < w; i++) {
    if (Number.isFinite(wave[i])) continue;
    wave.fill(0);
    flow.fill(0);
    return;
  }

  // The flux form conserves volume exactly; the clamps and the limiter above
  // are what can cost or conjure a hair of it. Levelling the mean hands that
  // hair back, and removes nothing else: every travelling wave and the slosh
  // itself are zero-mean shapes.
  let mean = 0;
  for (let i = 0; i < w; i++) mean += wave[i];
  mean /= w;
  for (let i = 0; i < w; i++) wave[i] -= mean;
}

/**
 * Presses the surface at `x`: down for a positive `force`, up for a negative
 * one, over a Gaussian about `radius` wide. `force` is the rate the surface is
 * pressed at, in height units a second.
 *
 * The push is given to the flow, not the surface. Pressed straight into the
 * heights, every one of the two dozen bubbles bursting each second shows up
 * the same instant and the pour carries a tremor at the rate they arrive - the
 * glass answering the bubbles rather than the beer. A push on the flow has to
 * travel before it shows, and the surface adds the arrivals up as a liquid
 * does. What the flow has to be is read straight off the surface it must
 * produce: each face carries away everything the columns behind it are
 * shedding, so the flux is the running total of the push - taken off its own
 * mean, so a press moves beer about without adding or removing any.
 */
export function splashSurface(beer: Beer, params: BeerParams, x: number, force: number, radius: number): void {
  const { w, flow, headNext } = beer;
  if (w < 2 || beer.level <= MIN_DEPTH) return;
  const [spanX] = cellSpansOf(beer);

  const depth = beer.level;
  const g = gravityOf(params);
  const uCap = Math.sqrt(g * depth) * 2.5;
  const centre = x / spanX;
  const span = Math.max(1, radius / spanX);

  // `headNext` is scratch here exactly as it is in `settleHead`: nothing reads
  // it between steps.
  let mean = 0;
  for (let i = 0; i < w; i++) {
    const d = (i - centre) / span;
    mean += headNext[i] = Math.exp(-d * d * 1.6);
  }
  mean /= w;

  let carried = 0;
  for (let k = 0; k < w - 1; k++) {
    carried += force * (headNext[k] - mean) * spanX;
    const pushed = flow[k] + carried / depth;
    flow[k] = pushed > uCap ? uCap : pushed < -uCap ? -uCap : pushed;
  }
}

/**
 * Drives the body of the beer with a stir: the sideways speed of the drag
 * accelerates the flow under it, and the vertical speed presses the surface.
 *
 * Driving the flow is the difference between stirring beer and drawing on it.
 * The beer piles against the leading wall because it was set moving towards
 * it; the bow wave - risen ahead of the drag, dipped behind - is the flux
 * converging ahead of the driven patch and diverging behind it, which is what
 * a finger pulled through liquid actually does to the liquid rather than a
 * shape painted onto its surface.
 *
 * Attenuated by depth, over twice `stirReach` - the pressure a moving hand
 * makes carries further than its grip does. A stir well below the surface
 * hardly moves it, and one above it - in the air, or in the foam - not at all.
 */
function stirFlow(beer: Beer, params: BeerParams, stir: Stir, fade: number, dt: number): void {
  const { w, wave, flow } = beer;
  if (w < 2 || beer.level <= MIN_DEPTH) return;
  const [spanX] = cellSpansOf(beer);
  const reach = params.stirReach;
  if (reach <= 0) return;

  const base = 1 - beer.level;
  const below = stir.y - (base + sampleColumn(wave, spanX, stir.x));
  if (below < 0) return;
  const grip = falloff(below * below, reach * 2);
  if (grip <= 0) return;

  if (stir.vx !== 0) {
    // Wider than the bubble grip, because the flow is a body of beer rather
    // than a thing at a point: a finger's wake is broader than its touch.
    const wide = reach * 1.5;
    const k0 = Math.max(0, Math.ceil((stir.x - wide) / spanX - 0.5));
    const k1 = Math.min(w - 2, Math.floor((stir.x + wide) / spanX - 0.5));
    const push = stir.vx * params.slosh * grip * fade * dt;
    // Held to a few times the wave speed at the point it is added, the same
    // ceiling the solver holds it to: a flick can be arbitrarily fast, and
    // beer cannot.
    const cap = 2.5 * Math.sqrt(gravityOf(params) * beer.level);
    for (let k = k0; k <= k1; k++) {
      const dx = (k + 0.5) * spanX - stir.x;
      const pushed = flow[k] + push * falloff(dx * dx, wide);
      flow[k] = pushed > cap ? cap : pushed < -cap ? -cap : pushed;
    }
  }

  // A downward drag presses the surface, an upward one lifts it. A fraction
  // of the sideways coupling, because a hand moving down a glass mostly
  // parts the beer rather than sinking the line.
  if (stir.vy !== 0) {
    splashSurface(beer, params, stir.x, stir.vy * params.slosh * 0.06 * grip * fade, reach * 0.8);
  }
}

/**
 * Applies the live stirs: bubbles near one are carried along with it, and the
 * beer takes a drive from it.
 *
 * A bubble is eased *towards* the stir's speed rather than shoved by it. A shove
 * accumulates - hold the pointer still over a bubble and it accelerates without
 * limit, or to whatever the damping happens to allow - whereas easing towards a
 * speed means the fizz can be carried at the speed of the drag and never faster,
 * however long it is held there.
 *
 * The flow is driven by the newest sample only. Every live stir is a sample of
 * the same pointer, so letting each of them push would have a fast drag drive
 * twice over - once through its speed, and once through the extra samples that
 * speed produced. One sample pushing per frame makes the impulse what it should
 * be: the speed of the drag times how long it lasted.
 */
export function stirBubbles(beer: Beer, params: BeerParams, stirs: readonly Stir[], dt: number, lifetime = 1): void {
  if (dt <= 0 || stirs.length === 0) return;

  const newest = stirs[stirs.length - 1];

  for (const stir of stirs) {
    // Squared, so a stir loses its grip gently at first and then lets go.
    const fade = lifetime > 0 ? Math.max(0, 1 - stir.age / lifetime) ** 2 : 0;
    if (fade <= 0) continue;

    if (stir === newest) stirFlow(beer, params, stir, fade, dt);

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

/** Ceiling on droplets in flight. A hard swirl throws a good many at once. */
const MAX_DROPS = 48;

/**
 * The height a thrown droplet is sized against, in height units: its launch
 * speed is what gravity turns into about this much climb.
 */
const SPRAY_RISE = 0.06;

/** Adds one droplet, or lets it go if the air is already full of them. */
function addDrop(beer: Beer, drop: Drop): void {
  if (beer.drops.length >= MAX_DROPS) return;
  beer.drops.push(drop);
}

/** A pop this many mean radii across may throw a droplet as it bursts. */
const SPRAY_POP_SIZE = 1.8;

/**
 * Pops the bubbles that have reached the surface, handing their area to the
 * head and their arrival to the flow. Returns how many went.
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
export function popBubbles(beer: Beer, params: BeerParams, rand: () => number = Math.random): number {
  const bubbles = beer.bubbles;
  const [spanX] = cellSpansOf(beer);
  const aspect = aspectOf(beer);
  const column = spanX > 0 ? spanX : aspect > 0 ? aspect : 1;
  let popped = 0;

  for (let i = 0; i < bubbles.length; ) {
    const bubble = bubbles[i];
    const line = surfaceAt(beer, bubble.x);

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

    for (let c = i0; c <= i1; c++) {
      const fed = beer.head[c] + thickness;
      beer.head[c] = fed > params.headMax ? params.headMax : fed;
    }

    // The burst presses the surface it broke: the bubble leaves a cavity, and
    // the dip and rebound that spread from it are what keep an idle pint's
    // surface moving. There is no other ambient motion anywhere.
    const ratio = params.radius > 0 ? bubble.radius / params.radius : 1;
    splashSurface(beer, params, bubble.x, params.splash * ratio, Math.max(bubble.radius * 2, column * 2));

    // A big enough burst throws a fleck of its shell into the air.
    if (params.spray > 0 && ratio > SPRAY_POP_SIZE && rand() < 0.35 * Math.min(1, params.spray)) {
      const g = gravityOf(params);
      addDrop(beer, {
        x: bubble.x,
        y: line - bubble.radius,
        vx: (rand() - 0.5) * 0.2,
        vy: -Math.sqrt(2 * g * SPRAY_RISE) * (0.6 + rand() * 0.8) * params.spray,
        radius: bubble.radius * 0.55,
      });
    }

    bubbles[i] = bubbles[bubbles.length - 1];
    bubbles.pop();
    popped++;
  }

  return popped;
}

/**
 * Flies the droplets by `dt`: ballistic under the same gravity the waves
 * answer to, held between the walls, and landing with a splash.
 *
 * The shared gravity is the point rather than a convenience - spray that hangs
 * longer than the slosh it came from swings, or drops faster than it, reads as
 * belonging to some other liquid.
 */
export function stepDrops(beer: Beer, params: BeerParams, dt: number): void {
  if (dt <= 0 || beer.drops.length === 0) return;

  const aspect = aspectOf(beer);
  const [spanX] = cellSpansOf(beer);
  const g = gravityOf(params);
  const drops = beer.drops;

  for (let i = drops.length - 1; i >= 0; i--) {
    const drop = drops[i];
    drop.vy += g * dt;
    drop.x += drop.vx * dt;
    drop.y += drop.vy * dt;

    // The walls again, damped rather than lively: a droplet hitting glass
    // sticks more than it bounces.
    if (drop.x < 0) {
      drop.x = 0;
      drop.vx = -drop.vx * 0.4;
    } else if (drop.x > aspect) {
      drop.x = aspect;
      drop.vx = -drop.vx * 0.4;
    }

    // Falling and back at the surface: it lands, presses the beer it rejoins,
    // and is gone. Only falling - a droplet still on its way up passes the
    // line it was thrown through.
    if (drop.vy > 0 && drop.y >= surfaceAt(beer, drop.x)) {
      const ratio = params.radius > 0 ? drop.radius / params.radius : 1;
      splashSurface(beer, params, drop.x, params.splash * ratio * 2, Math.max(drop.radius * 2, spanX * 2));
      drops.splice(i, 1);
    }
  }
}

/**
 * A press on the surface: the splash, the spray it throws, and the fizz it
 * knocks loose. The one gesture a click is.
 *
 * Nothing happens to a press in the air - there is no beer up there to press.
 * The reach below the surface is generous, because pressing *into* the beer is
 * how anyone actually clicks on it.
 */
export function pressBeer(beer: Beer, params: BeerParams, rand: () => number, x: number, y: number): void {
  const line = surfaceAt(beer, x);
  if (y < line - params.stirReach * 0.6) return;

  splashSurface(beer, params, x, params.splash * 40, params.stirReach * 0.7);

  if (params.spray > 0) {
    const g = gravityOf(params);
    const thrown = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < thrown; i++) {
      addDrop(beer, {
        x: x + (rand() - 0.5) * params.stirReach * 0.6,
        y: line - params.radius,
        vx: (rand() - 0.5) * 0.5,
        vy: -Math.sqrt(2 * g * SPRAY_RISE) * (0.8 + rand() * 1.2) * params.spray,
        radius: params.radius * (0.5 + rand() * 0.8),
      });
    }
  }

  // Knocked loose under the press, the way the drag's scrape does along its
  // path - a jolt is a very good rough spot.
  for (let i = 0; i < 5; i++) {
    addBubble(beer, params, rand, x + (rand() - 0.5) * params.stirReach, line + rand() * (1 - line));
  }
}

/** How quickly the raft comes to the beer when it is all but there... */
const RAFT_SLOW = 2.5;
/** ...and when the beer has plainly moved out from under it. */
const RAFT_FAST = 30;
/** The gap, in height units, past which the raft is plainly behind. */
const RAFT_REACH = 0.01;

/**
 * Moves the surface the foam rides towards the beer's.
 *
 * A head is a raft a finger thick, not a skin: it has weight and it holds
 * together, so it rides the swell the beer is on and ignores the pricking of
 * the bubbles coming up under it. Drawn straight off the beer's surface, every
 * bubble that broke poked the whole top of the head as it went - dozens a
 * second, and the head juddered at the rate the glass was fizzing.
 *
 * What the raft leaves behind is decided by width, not by speed: its surface
 * is the beer's smoothed sideways, over a span wide enough to swallow a
 * dimple and far narrower than the glass. Being a smoothing in space rather
 * than in time it has no memory, so a swirl reaches the head in full. And it
 * comes to that smoothed line at a pace that depends on how far behind it is -
 * the two things it must tell apart differ in size as much as in speed, and
 * followed at one rate there is no setting that does both: slow enough to
 * lose the fizz takes half the slosh with it, and quick enough to keep the
 * slosh keeps the fizz. Read as a distance instead, the raft ignores what it
 * is barely behind and goes with what it is plainly behind, which is a raft
 * of foam either way round.
 */
export function stepRaft(beer: Beer, dt: number): void {
  if (dt <= 0) return;

  const { w, wave, raft, raftKernel } = beer;
  const r = (raftKernel.length - 1) >> 1;
  const near = RAFT_SLOW * dt;
  const far = RAFT_FAST * dt;

  for (let i = 0; i < w; i++) {
    let smoothed = 0;
    for (let j = -r; j <= r; j++) {
      const at = i + j;
      smoothed += wave[at < 0 ? 0 : at > w - 1 ? w - 1 : at] * raftKernel[j + r];
    }
    const gap = smoothed - raft[i];
    const t = Math.min(1, Math.abs(gap) / RAFT_REACH);
    raft[i] += gap * Math.min(1, near + (far - near) * t * t);
  }
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

/** How much livelier the fizz is while the glass is still being poured. */
const POUR_FIZZ = 2.6;

/**
 * One frame of the loop: pour, waves, stir, rise, fuse, pop, spray, raft,
 * settle, nucleate.
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

  // The pour: a glass below its fill line climbs to it. A glass at the line
  // stays there; params are fixed for a mount, so it never has to fall.
  const pouring = beer.level < params.fill;
  if (pouring) {
    beer.level = params.pourRate > 0 ? Math.min(params.fill, beer.level + params.pourRate * dt) : params.fill;
  }

  stepWaves(beer, params, dt, rand);
  stirBubbles(beer, params, stirs, dt, stirLifetime);
  driftBubbles(beer, params, dt);
  fuseBubbles(beer, params);
  popBubbles(beer, params, rand);
  stepDrops(beer, params, dt);
  stepRaft(beer, dt);
  settleHead(beer, params, dt);

  // Nucleation. The debt is carried between steps rather than rounded, so a rate
  // that works out at less than one bubble a frame still produces bubbles at the
  // right rate instead of none at all. A glass being poured fizzes harder -
  // pouring is when the carbonation is liveliest.
  const aspect = aspectOf(beer);
  const supply = params.rate * aspect * dt * (pouring ? POUR_FIZZ : 1);
  const streamed = beer.sites.length > 0 ? Math.min(1, Math.max(0, params.streaming)) : 0;

  beer.owed += supply * (1 - streamed);
  for (const site of beer.sites) site.owed += supply * streamed * site.weight;

  let full = false;
  while (beer.owed >= 1 && !full) {
    beer.owed -= 1;
    const start = nucleate(beer, params, rand);
    // Off the floor of the glass, and a radius *below* the bottom edge rather
    // than on it. Nucleating exactly on the last row draws every new bubble at
    // half strength along the bottom of the canvas, which reads as a dotted
    // line rather than as fizz coming up off the base.
    full = !addBubble(beer, params, rand, start.x, 1 + params.radius, start.scale);
  }
  for (const site of beer.sites) {
    while (site.owed >= 1 && !full) {
      site.owed -= 1;
      const jitter = site.x + (rand() - 0.5) * 4 * params.radius;
      const x = jitter < 0 ? 0 : jitter > aspect ? aspect : jitter;
      full = !addBubble(beer, params, rand, x, 1 + params.radius, site.size);
    }
  }
  if (full) {
    // The debts are dropped rather than banked, or the moment a bubble pops
    // the backlog fires as a burst.
    beer.owed = 0;
    for (const site of beer.sites) site.owed = 0;
  }
}

/**
 * Carries a glass over to a resized one: the bubbles, the droplets, the level
 * and the clock as they are, the per-column state resampled.
 *
 * The bubbles are in height units and so mean the same thing at any resolution,
 * which is why a window drag does not have to empty the glass. The head, the
 * waves, the raft and the flow are per column or per face - a column means a
 * different place at a new width - so they are resampled rather than dropped:
 * losing the head on every resize is a visible flash of flat beer, and losing
 * the waves mid-slosh is a surface snapping level for no reason a viewer can
 * see. The sites are rescaled to the new width rather than carried or rerolled:
 * a site is a spot on the glass, and the glass got wider - carried straight
 * across, every stream on a narrowed window piles up on the right-hand wall.
 */
export function carryBeer(from: Beer, to: Beer): void {
  to.bubbles = from.bubbles;
  to.drops = from.drops;
  to.level = from.level;
  to.time = from.time;
  to.owed = from.owed;
  to.seed = from.seed;

  const fromAspect = aspectOf(from);
  const toAspect = aspectOf(to);
  to.sites = from.sites;
  const stretch = fromAspect > 0 ? toAspect / fromAspect : 1;
  for (const site of to.sites) site.x *= stretch;

  const [toSpan] = cellSpansOf(to);
  const [fromSpan] = cellSpansOf(from);
  for (let i = 0; i < to.w; i++) {
    const x = i * toSpan;
    to.head[i] = sampleColumn(from.head, fromSpan, x);
    to.wave[i] = sampleColumn(from.wave, fromSpan, x);
    to.raft[i] = sampleColumn(from.raft, fromSpan, x);
  }
  // The flow lives on the faces, half a span in from the columns on either
  // side, so its samples are taken half a span over on both grids.
  for (let k = 0; k < to.w - 1; k++) {
    to.flow[k] = sampleColumn(from.flow, fromSpan, (k + 0.5) * toSpan - fromSpan * 0.5);
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
 * How much foam is at a point, 0 to 1, given the head's thickness and the line
 * the raft rides in that column.
 *
 * Density falls off from the raft's line to the top of the head, and the noise
 * is added *before* the threshold rather than multiplied in afterwards. That is
 * what gives the head a ragged top edge rather than a fading one: near the top,
 * density and threshold are close enough that the noise decides which side of it
 * a cell lands on, so the edge breaks into lumps. Deeper in, density wins
 * outright and the noise only mottles the brightness.
 */
export function foamAt(beer: Beer, params: BeerParams, x: number, y: number, thickness: number, line: number): number {
  if (thickness <= 0) return 0;

  // 0 at the raft's line, 1 at the top of the head. Slightly negative is
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
 * - Rows above the surface band are air: one `fill(0)` for the whole block,
 *   with the droplets in flight drawn over it.
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
 * from the level rather than the wavy instantaneous surface, so a row's shade
 * is one number rather than per-column. The error is the wave height times
 * `depthFade` - under two hundredths of full scale at the defaults, a fraction
 * of one palette level.
 */
export function renderBeer(beer: Beer, params: BeerParams): void {
  const { w, h, field, raw, head, line, bubbles, wave, raft, drops } = beer;
  const [spanX, spanY] = cellSpansOf(beer);
  const base = 1 - beer.level;
  const halfEdge = params.surfaceWidth / 2;

  for (let i = 0; i < w; i++) line[i] = base + wave[i];

  // The surface band: the rows in which anything other than plain liquid or
  // plain air can appear, across all columns - from the top of the tallest
  // foam, measured off the raft it rides, to the bottom of the deepest surface
  // ramp. The raft and the line differ by at most a ripple, and the band takes
  // in both.
  let top = Infinity;
  let bottom = -Infinity;
  for (let i = 0; i < w; i++) {
    const rides = base + raft[i];
    const foamTop = rides - Math.max(1.3 * head[i], halfEdge);
    const foamFoot = rides + Math.max(0.2 * head[i], halfEdge);
    const wetTop = line[i] - halfEdge;
    const wetFoot = line[i] + halfEdge;
    if (foamTop < top) top = foamTop;
    if (wetTop < top) top = wetTop;
    if (foamFoot > bottom) bottom = foamFoot;
    if (wetFoot > bottom) bottom = wetFoot;
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
    // Held at zero above the level, which the foam reaches over. It needs
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

      const foam = foamAt(beer, params, i * spanX, y, head[i], base + raft[i]);
      // Over the top rather than added to it: the head sits on the beer, and
      // adding the two would blow the brightest bubbles out to white.
      if (foam > value) value = foam;

      field[k] = value > 1 ? 1 : value;
    }
  }

  // Below the band every column is wet and foamless, so a row is one number.
  // The depth needs no clamping at either end down here: the band reaches at
  // least to the deepest column's liquid line, and the waves are levelled so
  // the deepest line is never above the level, which puts every row below
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

  // The droplets, over everything: they are in the air, where the field is
  // zero, and a droplet crossing the band on its way down is *in front of*
  // the foam it passes. Each one is drawn alone rather than summed into `raw`
  // - spray is spray, not a metaball - as bright as a lit bubble, which is
  // what a bead of the same beer catching the same light would be.
  if (drops.length > 0) {
    const bright = Math.min(1, params.liquid + params.bubble);
    for (const drop of drops) {
      const i0 = spanX > 0 ? Math.max(0, Math.ceil((drop.x - drop.radius) / spanX)) : 0;
      const i1 = spanX > 0 ? Math.min(w - 1, Math.floor((drop.x + drop.radius) / spanX)) : w - 1;
      const j0 = spanY > 0 ? Math.max(0, Math.ceil((drop.y - drop.radius) / spanY)) : 0;
      const j1 = spanY > 0 ? Math.min(h - 1, Math.floor((drop.y + drop.radius) / spanY)) : h - 1;

      for (let j = j0; j <= j1; j++) {
        const dy = j * spanY - drop.y;
        const dy2 = dy * dy;
        const row = j * w;

        for (let i = i0; i <= i1; i++) {
          const dx = i * spanX - drop.x;
          const strength = falloff(dx * dx + dy2, drop.radius);
          if (strength <= low) continue;
          const value = ramp(strength, low, high) * bright;
          const k = row + i;
          if (value > field[k]) field[k] = value;
        }
      }
    }
  }
}
