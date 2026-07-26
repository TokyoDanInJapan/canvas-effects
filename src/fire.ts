// Fire: a heat field seeded along the bottom edge and carried upward, cooling
// as it goes.
//
// The classic cellular fire of demoscene and early-90s game code, rather than
// anything derived from the fluid solver next door. Each frame every cell takes
// the heat of the cell below it, minus a random amount, displaced sideways by a
// random amount. That is the whole algorithm, and it is enough: the randomness
// in the cooling is what makes flames lick and break up, and the randomness in
// the displacement is what makes them lean and curl.
//
// WHY NOT REUSE THE FLUID SOLVER
// ------------------------------
// smoke.ts could carry a buoyant temperature field and would be more physical.
// It would also be far slower, and it would look like the smoke with a warm
// palette - the two effects would share a silhouette. Cellular fire has a
// completely different character: hard flickering tongues instead of smooth
// overturning plumes, because the noise is injected per cell per frame rather
// than emerging from a flow.
//
// ONE ROW PER FRAME
// -----------------
// The propagation is deliberately ordered so a row reads the *previous frame's*
// value of the row below: the loop runs downward-reading, upward-writing, and
// never touches a row it has already written. Heat therefore climbs one row per
// pass, and the flame front has a real speed rather than teleporting up the
// screen every frame. `passes` buys more of that speed without changing the
// timestep.
//
// A NOTE ON HOW THIS READS
// ------------------------
// Fire is the highest-contrast thing in this library, and the palette is the
// tightest constraint on it. Its siblings work at five near-black greys because
// smoke, plasma haze, rain streaks and thin lines are all inherently
// low-contrast; fire is not. Real flame legibility comes from a steep ramp -
// black to red to orange to yellow to white - and five dark greys cannot
// provide it.
//
// So at greyscale background amplitudes this reads as embers, or heat haze at
// the foot of the page, which is a perfectly good background and the default.
// To make it read as actual flame it wants a warm `tint`, a higher `amplitude`
// and more `levels`; the README has the recipe. That is a louder background
// than the others, deliberately chosen rather than defaulted to.
//
// Kept DOM-free so it can be unit-tested; the canvas and the loop live in
// fire-background.ts.

import { fbm } from './noise';

export interface FireParams {
  /**
   * How far up the field the flames reach, as a fraction of its height.
   *
   * Expressed this way rather than as heat lost per row, which is what the
   * algorithm actually wants, because a per-row figure is resolution
   * dependent: it fixes the flame height in *cells*, so the same value fills a
   * short field and leaves a thin strip on a tall one. The per-row cooling is
   * derived from this and the field height instead, so the fire keeps its
   * proportions on any window.
   */
  reach: number;
  /**
   * Spread on the cooling, 0 to 1.
   *
   * With no variance every column cools identically and the result is a smooth
   * gradient - a sunset, not a flame. The spread is what makes neighbouring
   * columns reach different heights, which is what tears the field into
   * separate tongues.
   *
   * Paired with `jitter`. Measured across their ranges with the other held
   * off, the two contribute about equally to how torn the field is - roughly a
   * tripling each. This one tears it vertically, `jitter` horizontally.
   */
  coolingVariance: number;
  /**
   * Random sideways displacement per row, in cells. The horizontal half of the
   * break-up, and what makes tongues curl rather than rise straight.
   */
  jitter: number;
  /** Steady sideways lean, in cells per row. */
  wind: number;
  /** How fast the wind wanders. */
  windChurn: number;
  /** Strength of that wandering, in cells per row. */
  windStrength: number;
  /** Heat of the hottest part of the source row, 0 to 1. */
  sourceHeat: number;
  /** How much cooler the cold patches of the source are, 0 to 1. */
  sourceVariance: number;
  /** Spatial scale of those patches along the base. */
  sourceScale: number;
  /** How fast they slide along the base. */
  sourceDrift: number;
  /** Octaves for the source noise. */
  octaves: number;
  /** Propagation steps per frame. Raising it makes the flames climb faster. */
  passes: number;

  /** Radius of a click spark, as a fraction of the shorter side of the grid. */
  sparkRadius: number;
  /** Heat at the centre of one, 0 to 1. */
  sparkHeat: number;
}

export const FIRE_DEFAULTS: FireParams = {
  // Halfway, which leaves the top of the page clear for text.
  reach: 0.5,
  // High. Paired with `jitter` - see the note on it.
  coolingVariance: 0.85,
  jitter: 1,
  wind: 0,
  windChurn: 0.09,
  windStrength: 0.5,
  sourceHeat: 1,
  sourceVariance: 0.55,
  sourceScale: 5.5,
  sourceDrift: 0.06,
  octaves: 3,
  // Two, so the front climbs about 48 cells a second at 24fps. At one the
  // flames crawl and read as a lava lamp.
  passes: 2,
  sparkRadius: 0.14,
  // Full heat, so a spark reads as new fuel rather than a smudge - and so it
  // survives the climb long enough to become a plume.
  sparkHeat: 1,
};

/** Seeds and offsets that give one run its character. */
export interface FireState {
  seed: number;
  windSeed: number;
  offset: number;
}

export function randomizeFire(rand: () => number = Math.random): FireState {
  return {
    seed: Math.floor(rand() * 100000) + 1,
    windSeed: Math.floor(rand() * 100000) + 1,
    offset: rand() * 64,
  };
}

export interface Fire {
  w: number;
  h: number;
  /** Heat per cell, 0 to 1, row-major. This is what gets shaded. */
  heat: Float32Array;
  state: FireState;
  /** Seconds burned, for the drifting source and wandering wind. */
  elapsed: number;
}

export function createFire(w: number, h: number, rand: () => number = Math.random): Fire {
  return { w, h, heat: new Float32Array(w * h), state: randomizeFire(rand), elapsed: 0 };
}

/**
 * Writes the bottom row: the fuel.
 *
 * Deliberately uneven and slowly sliding. A constant source row gives an even
 * wall of flame with no shape to it; the hot and cool patches are what make one
 * part of the fire flare while another dies back.
 */
export function seedFire(fire: Fire, params: FireParams): void {
  const { w, h, heat, state, elapsed } = fire;
  const { sourceHeat, sourceVariance, sourceScale, sourceDrift, octaves } = params;
  const row = (h - 1) * w;

  for (let x = 0; x < w; x++) {
    const u = (x / w) * sourceScale + elapsed * sourceDrift + state.offset;
    const n = fbm(u, elapsed * 0.05, state.seed, octaves);
    heat[row + x] = sourceHeat * (1 - sourceVariance + n * sourceVariance);
  }
}

/**
 * The wind at this moment, in cells of sideways drift per row climbed.
 *
 * Wanders rather than being fixed, so the fire leans one way for a while and
 * then the other. A constant lean reads as a texture being sheared.
 */
export function windAt(fire: Fire, params: FireParams): number {
  const n = fbm(fire.elapsed * params.windChurn, 0, fire.state.windSeed, 2);
  return params.wind + (n - 0.5) * 2 * params.windStrength;
}

/**
 * One propagation pass: every cell takes from the cell below, cooled and
 * displaced.
 *
 * The loop reads row `y` and writes row `y - 1`, walking downward through the
 * field. Because it only ever writes rows it has already read past, no row is
 * read after being written this pass - which is what limits the climb to one
 * row per pass instead of letting heat shoot to the top in a single frame.
 */
export function propagateFire(fire: Fire, params: FireParams, rand: () => number): void {
  const { w, h, heat } = fire;
  const { coolingVariance, jitter } = params;
  const wind = windAt(fire, params);

  // Heat lost per row, derived so the flames reach the same fraction of the
  // screen whatever the field height is.
  const cooling = params.sourceHeat / Math.max(1, params.reach * h);

  for (let y = 1; y < h; y++) {
    const below = y * w;
    const above = below - w;

    for (let x = 0; x < w; x++) {
      const source = heat[below + x];

      // Cooling scattered about its mean. At zero variance this is a smooth
      // gradient; the spread is what breaks it into tongues.
      const spread = 1 - coolingVariance + rand() * coolingVariance * 2;
      const next = source - cooling * spread;

      const drift = Math.round(wind + (rand() * 2 - 1) * jitter);
      // Wrapped, so the fire has no side edges to pile up against.
      const tx = (((x + drift) % w) + w) % w;

      heat[above + tx] = next > 0 ? next : 0;
    }
  }
}

/** One frame: re-fuel the base, then climb. */
export function stepFire(fire: Fire, params: FireParams, rand: () => number, dt: number): void {
  fire.elapsed += dt;
  seedFire(fire, params);
  for (let i = 0; i < params.passes; i++) propagateFire(fire, params, rand);
}

/** Where a click landed, in grid cells. */
export interface Spark {
  x: number;
  y: number;
  /** Multiplier on `sparkHeat`. */
  strength: number;
}

/**
 * Drops a blob of heat in - new fuel, thrown wherever the click landed.
 *
 * A one-shot deposit with no state of its own, and unusually for that, it still
 * *evolves*. Every other interaction in this library fades where it was put: a
 * splash decays, a ripple expands and dims, a wobble propagates and stops. This
 * one gets taken away from where it was put, because the propagation already
 * carries every cell's heat upward, cools it by a random amount and jitters it
 * sideways. So a spark rises, thins, tears into tongues and dies out - none of
 * which is written here. It is the existing simulation doing it.
 *
 * Note what happens to the blob's own cells. `propagateFire` writes each row
 * from the row below, so the cells a spark occupies are overwritten by the
 * cooler air beneath them on the very next pass. That is not a defect: it is why
 * the blob *moves* rather than sitting where it was dropped, losing its bottom
 * edge one row at a time until it is gone. At the defaults that gives a plume
 * about a second long.
 *
 * Wraps sideways, like the propagation does, so a click near an edge is not
 * clipped into half a spark.
 */
export function applySpark(fire: Fire, spark: Spark, params: FireParams): void {
  const { w, h, heat } = fire;
  const radius = Math.max(1, params.sparkRadius * Math.min(w, h));
  const radius2 = radius * radius;
  const reach = Math.ceil(radius);
  const centreX = Math.round(spark.x);
  const centreY = Math.round(spark.y);

  for (let dy = -reach; dy <= reach; dy++) {
    const gy = centreY + dy;
    if (gy < 0 || gy >= h) continue;
    const row = gy * w;

    for (let dx = -reach; dx <= reach; dx++) {
      const squared = dx * dx + dy * dy;
      if (squared > radius2) continue;

      const gx = (((centreX + dx) % w) + w) % w;
      // Smooth to nothing at the rim, so the spark has no hard edge for the
      // propagation to carry upward as a disc.
      const falloff = (1 - squared / radius2) ** 2;
      const raw = spark.strength * params.sparkHeat * falloff;
      const value = raw > 1 ? 1 : raw;

      const index = row + gx;
      // Hottest wins, so a spark never cools what is already burning.
      if (value > heat[index]) heat[index] = value;
    }
  }
}

/**
 * How high the flames reach, as a fraction of the field height.
 *
 * Exported because it is the number that says whether `cooling` and
 * `sourceHeat` are in a sensible relationship, and it is awkward to eyeball.
 */
export function flameHeight(fire: Fire, threshold = 0.02): number {
  const { w, h, heat } = fire;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (heat[y * w + x] > threshold) return 1 - y / (h - 1);
    }
  }
  return 0;
}
