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

import { ringPulse } from './background.js';

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

  /** How fast a click distortion's ring expands, in cells per second. */
  distortSpeed: number;
  /** Thickness of that ring, in cells. */
  distortWidth: number;
  /** Seconds a distortion lasts. */
  distortLifetime: number;
  /** How far it displaces the field at its peak, in cells. */
  distortStrength: number;
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
  // A ring crossing a 1080p field in about a second, which reads as a shock
  // travelling through the rain rather than as a flash.
  distortSpeed: 90,
  distortWidth: 7,
  distortLifetime: 1.1,
  // In cells, so it does not need re-tuning when the field resolution changes.
  // Six is roughly a bold drop's width - enough to visibly kink a streak.
  distortStrength: 6,
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
  /** Brightness per cell, 0 to 1, row-major. The simulation writes this. */
  field: Float32Array;
  /**
   * `field` with any click distortions applied. Only written when there are
   * some, and `distortField` returns whichever of the two should be shaded.
   */
  warped: Float32Array;
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

  return { w, h, lanes, field: new Float32Array(w * h), warped: new Float32Array(w * h) };
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

/** Where a click landed, in grid cells. */
export interface Distortion {
  x: number;
  y: number;
  /** Seconds since the click. */
  age: number;
  /** Multiplier on `distortStrength`. */
  strength: number;
}

/**
 * Bilinear sample of the field, wrapping sideways and clamping vertically.
 *
 * Wrapping in x matches the lanes, which wrap, so a distortion near an edge
 * pulls in streaks from the far side instead of smearing one column. Clamping in
 * y is right for the same reason it is wrong in the smoke: rain has a top it
 * falls from and a bottom it retires at, and wrapping would drag the bottom of
 * the screen back up into the top.
 *
 * Deliberately not the smoke's `sampleWrapped`. That wraps both axes, and these
 * two effects have no business importing each other's internals.
 */
function sampleField(field: Float32Array, w: number, h: number, x: number, y: number): number {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const tx = x - fx;
  // Above the top the row indices clamp to 0 and 1, so a surviving fraction
  // would blend downward into the field instead of holding the edge row - the
  // fraction has to clamp with them. Below the bottom both indices land on the
  // last row and the fraction cancels on its own, so only this side needs a
  // guard.
  const ty = fy < 0 ? 0 : y - fy;

  const x0 = (((fx % w) + w) % w) | 0;
  const x1 = (x0 + 1) % w;
  const y0 = fy < 0 ? 0 : fy > h - 1 ? h - 1 : fy;
  const y1 = y0 + 1 > h - 1 ? h - 1 : y0 + 1;

  const a = field[y0 * w + x0];
  const b = field[y0 * w + x1];
  const c = field[y1 * w + x0];
  const d = field[y1 * w + x1];

  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * ty;
}

/**
 * Applies click distortions, returning the buffer that should be shaded.
 *
 * A distortion *displaces what is already there* rather than adding light of its
 * own, which is what makes it read where a splash did not: the rain's streaks
 * are the highest-contrast thing on screen, so bending them is far more visible
 * than drawing a faint new shape among them. It is a droplet on glass acting as
 * a lens.
 *
 * Returns `field` untouched when there is nothing to do, so an idle page pays
 * nothing - not even a copy.
 *
 * Only the cells a ring can actually reach are recomputed. The rings are thin
 * and short-lived, so that bounding box is a small part of the field even while
 * one is running.
 */
export function distortField(rain: Rain, distortions: readonly Distortion[], params: RainParams): Float32Array {
  const { w, h, field, warped } = rain;

  // Expiry is settled here, once, rather than per cell in the loops below. The
  // ring's shape lives in `ringPulse`, shared with the plasma's ripples; the
  // only per-distortion constant it does not cover is the peak push, so that
  // is the one hoisted alongside.
  const live = distortions
    .filter((d) => d.age >= 0 && d.age < params.distortLifetime)
    .map((d) => ({ x: d.x, y: d.y, age: d.age, amp: params.distortStrength * d.strength }));
  if (live.length === 0) return field;

  warped.set(field);

  let x0 = w;
  let x1 = -1;
  let y0 = h;
  let y1 = -1;
  for (const d of live) {
    // How far out a ring can still be felt: its radius plus a few widths of
    // tail.
    const r = d.age * params.distortSpeed + params.distortWidth * 3;
    x0 = Math.min(x0, Math.floor(d.x - r));
    x1 = Math.max(x1, Math.ceil(d.x + r));
    y0 = Math.max(0, Math.min(y0, Math.floor(d.y - r)));
    y1 = Math.min(h - 1, Math.max(y1, Math.ceil(d.y + r)));
  }
  if (x1 < x0 || y1 < y0) return field;
  // A grown ring's box can be wider than the field. Left to lap round, the
  // wrap below would write the same output column twice - and the second
  // visit, at a different distance from the centre, would overwrite the first
  // with the far ring's push. One field's width of columns is every column.
  if (x1 - x0 >= w) x1 = x0 + w - 1;

  for (let y = y0; y <= y1; y++) {
    for (let xi = x0; xi <= x1; xi++) {
      let ox = 0;
      let oy = 0;

      for (const d of live) {
        // The lanes wrap sideways, so distance must too: a cell feels the
        // nearest image of the centre, not the literal coordinate difference.
        const dx = ((((xi - d.x + w * 0.5) % w) + w) % w) - w * 0.5;
        const dy = y - d.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < 1e-6) continue;

        const push =
          d.amp * ringPulse(distance, d.age, params.distortSpeed, params.distortWidth, params.distortLifetime);

        ox += (dx / distance) * push;
        oy += (dy / distance) * push;
      }

      if (ox === 0 && oy === 0) continue;
      // Read from where the content came from, so it appears pushed outward.
      const gx = (((xi % w) + w) % w) | 0;
      warped[y * w + gx] = sampleField(field, w, h, xi - ox, y - oy);
    }
  }

  return warped;
}

/** Mean brightness of the field. Exported for tests and for tuning. */
export function meanBrightness(rain: Rain): number {
  let total = 0;
  for (let k = 0; k < rain.field.length; k++) total += rain.field[k];
  return total / rain.field.length;
}
