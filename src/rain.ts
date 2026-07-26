// Digital rain: the falling-streak field behind the Matrix-style background.
//
// One lane per field column. A head falls down its lane and writes brightness
// into the cells it passes; the whole field decays every frame, so the trail
// behind each head is simply what has not faded yet.
//
// WHY DECAY RATHER THAN A DRAWN TAIL
// ----------------------------------
// The obvious implementation is to draw a gradient of length L behind each
// head. That needs L as a parameter, needs the gradient recomputed every frame,
// and quietly breaks when a head moves more than one cell per frame - the tail
// either detaches or has to be stitched back on.
//
// Decaying the whole field instead makes the trail a consequence rather than a
// drawing. It costs one multiply per cell, it handles any speed without a
// special case, and it gets two things right for free: a fast head leaves a
// longer streak than a slow one, because its brightness has had less time to
// fade over the same distance; and a head that dies mid-screen leaves its trail
// to fade in place instead of vanishing with it.
//
// NOT GLYPHS
// ----------
// This is a scalar field, fed to the same coarse-grid-and-dither renderer the
// other effects use. It is the falling-light half of the Matrix look, not the
// characters - at a 6px dither cell a glyph would be about three cells tall and
// would read as noise. Streaks survive the palette; letterforms would not.
//
// Kept DOM-free so it can be unit-tested; the canvas and the loop live in
// rain-background.ts.

export interface RainParams {
  /**
   * How fast a trail fades, as a proportion lost per second. This is what sets
   * the apparent trail *length*, since length is speed divided by fade.
   */
  fade: number;
  /** Mean fall speed, in cells per second. */
  speed: number;
  /** Spread on that, as a fraction either side of the mean. */
  speedVariance: number;
  /**
   * Mean seconds a lane waits before falling again.
   *
   * This is the density dial. Lanes are one per field column, so how many are
   * visible at once is governed by how long they spend waiting, not by how many
   * exist.
   */
  respawn: number;
  /** Dimmest a head can be, as a fraction of full brightness. */
  minBrightness: number;
  /**
   * Per-cell brightness jitter, 0 to 1.
   *
   * Small on purpose. It is what stops a streak reading as a drawn line and
   * gives it the granular, flickering quality the effect is named for.
   */
  flicker: number;
  /**
   * Chance per lane, per respawn, of a much faster and brighter drop.
   *
   * Without these the field is uniform and dull: every lane the same speed
   * means the whole screen shares one rhythm.
   */
  boldChance: number;
  /** Speed and brightness multiplier for those. */
  boldFactor: number;
}

export const RAIN_DEFAULTS: RainParams = {
  // Paired with `speed`, and the pair is what matters: a trail reaches
  // `speed * ln(1 / brightness) / fade` cells before decaying to that
  // brightness. At these values, on a 1080p field ~90 cells tall, a streak is
  // still half-lit 15 cells back (16% of the height), a fifth-lit at 34 (38%),
  // and finally invisible around 64 (71%).
  //
  // That spread is the effect. A short bright trail reads as dashes; a long
  // even one reads as columns of light. Change `speed` and this has to move
  // with it or the look changes as much as the pace does.
  fade: 1.6,
  speed: 34,
  speedVariance: 0.55,
  // Lanes are only ~6 CSS pixels apart, so there are a lot of them and this is
  // the only thing keeping the screen from being solid rain. Shorter makes a
  // downpour; longer makes a drizzle. Re-tune it if `fieldScale` changes, since
  // that halves or doubles the lane count without touching this.
  respawn: 5.5,
  minBrightness: 0.45,
  flicker: 0.22,
  boldChance: 0.12,
  boldFactor: 1.9,
};

/** One falling lane. There is exactly one per field column. */
export interface RainLane {
  /**
   * Head position in cells. Starts negative so a drop enters from above the
   * top edge rather than appearing at it.
   */
  y: number;
  /** Cells per second. */
  speed: number;
  /** Brightness this head writes, 0 to 1. */
  brightness: number;
  /** Seconds left before this lane falls again. Only meaningful when idle. */
  delay: number;
  /** False while the lane is waiting to respawn. */
  falling: boolean;
}

export interface Rain {
  w: number;
  h: number;
  lanes: RainLane[];
  /** Brightness per cell, 0 to 1, row-major. This is what gets shaded. */
  field: Float32Array;
}

/**
 * Rolls a lane's next drop.
 *
 * Exported because the respawn distribution is the whole character of the
 * effect and is worth being able to test on its own.
 */
export function rollLane(lane: RainLane, rand: () => number, params: RainParams): void {
  const bold = rand() < params.boldChance;
  const spread = 1 + (rand() * 2 - 1) * params.speedVariance;

  lane.y = -1 - rand() * 8;
  lane.speed = params.speed * spread * (bold ? params.boldFactor : 1);
  lane.brightness = Math.min(
    1,
    (params.minBrightness + rand() * (1 - params.minBrightness)) * (bold ? params.boldFactor : 1)
  );
  lane.delay = 0;
  lane.falling = true;
}

/**
 * A field of lanes, all mid-fall at staggered heights.
 *
 * Started already running rather than all at the top, so the first frame is
 * rain in progress instead of a single tidy row sweeping down the page - which
 * is what a naive initialisation looks like, and it is very obviously wrong.
 */
export function createRain(w: number, h: number, rand: () => number = Math.random, params = RAIN_DEFAULTS): Rain {
  const lanes: RainLane[] = [];

  for (let i = 0; i < w; i++) {
    const lane: RainLane = { y: 0, speed: 0, brightness: 0, delay: 0, falling: false };
    rollLane(lane, rand, params);
    // Scatter them through a full cycle: some already falling at every height,
    // some still waiting.
    const phase = rand();
    if (phase < 0.55) {
      lane.y = rand() * (h + 8) - 4;
    } else {
      lane.falling = false;
      lane.delay = rand() * params.respawn;
    }
    lanes.push(lane);
  }

  return { w, h, lanes, field: new Float32Array(w * h) };
}

/**
 * One frame: fade everything, then move each head and light the cells it
 * crossed.
 *
 * The deposit walks from the head's previous position to its current one, so a
 * head moving several cells in a frame leaves a continuous streak rather than a
 * dotted line. That matters more than it sounds: at 24fps a bold drop covers
 * two to three cells per frame.
 */
export function stepRain(rain: Rain, params: RainParams, rand: () => number, dt: number): void {
  const { w, h, field, lanes } = rain;

  // Exponential rather than linear, so the fade is frame-rate independent:
  // halving dt and stepping twice leaves the same brightness behind.
  const keep = Math.exp(-params.fade * dt);
  for (let k = 0; k < field.length; k++) field[k] *= keep;

  for (let i = 0; i < w; i++) {
    const lane = lanes[i];

    if (!lane.falling) {
      lane.delay -= dt;
      if (lane.delay <= 0) rollLane(lane, rand, params);
      continue;
    }

    const previous = lane.y;
    lane.y += lane.speed * dt;

    const from = Math.max(0, Math.floor(Math.min(previous, lane.y)));
    const to = Math.min(h - 1, Math.floor(lane.y));

    for (let y = from; y <= to; y++) {
      // Jittered per cell, not per drop, which is where the granularity comes
      // from - a uniform streak reads as a drawn line.
      const value = lane.brightness * (1 - rand() * params.flicker);
      const k = y * w + i;
      // Brightest wins, so a slow head cannot dim a bright one that has just
      // passed through the same cell.
      if (value > field[k]) field[k] = value;
    }

    if (lane.y >= h) {
      // Idle, but the trail it left keeps fading on its own.
      lane.falling = false;
      lane.delay = params.respawn * (0.4 + rand() * 1.2);
    }
  }
}

/** Mean brightness of the field. Exported for tests and for tuning. */
export function meanBrightness(rain: Rain): number {
  let total = 0;
  for (let k = 0; k < rain.field.length; k++) total += rain.field[k];
  return total / rain.field.length;
}
