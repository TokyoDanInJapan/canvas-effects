// A tunnel: the demoscene standby. For every cell, convert its position to polar
// coordinates about a vanishing point and read a wall texture at
// `(angle, 1 / radius)`.
//
// THE PERSPECTIVE IS ONE DIVISION
// ------------------------------
// That `1 / radius` is the whole effect, and it is worth seeing why. A point on
// an infinite cylinder's wall, projected onto the screen, lands at a radius
// inversely proportional to how far down the cylinder it is. So reading the
// texture at `depth / radius` *is* the projection - there is no camera, no
// matrix and no depth buffer, just a reciprocal. Adding to it walks the viewer
// forward, and because the far wall is compressed into the middle, features
// sweep outward and accelerate exactly as they should.
//
// It also means the centre is a singularity: `radius` reaches zero and the
// texture coordinate runs to infinity. `coreRadius` floors it, and the vignette
// takes the middle to nothing, so the place where the maths gives up is the
// place nothing is drawn.
//
// IT WINDS, WHICH IS MOST OF THE MOTION
// -------------------------------------
// A straight cylinder with a drifting vanishing point reads as the camera
// wobbling: everything on screen moves together. A corridor whose *axis* winds
// reads as flight, because the near wall sweeps past while the far end holds
// still. `bend` is that, and the note on `wallCoords` has the derivation - it
// costs one extra pass of a fixed-point iteration and nothing else.
//
// WHY A BUILT TILE RATHER THAN NOISE
// ---------------------------------
// The wall has to wrap seamlessly around the circumference or a visible seam
// runs the length of the tunnel. fbm only wraps if the angular span happens to
// land on an integer lattice boundary, which is a constraint on two parameters
// at once and quietly breaks when either moves. A tile built from sinusoids at
// integer frequencies is periodic by construction, so it wraps whatever the
// parameters do - the same reason the plasma builds one.
//
// UNDERSAMPLING, AND WHY THE VIGNETTE IS THE SIZE IT IS
// -----------------------------------------------------
// `depth / radius` is not a uniform mapping, so a field of evenly spaced cells
// does not sample it evenly. The coordinate changes by roughly `depth * cell /
// radius²` between neighbours, which grows without bound towards the middle -
// so however fine the field, there is always an inner disc where consecutive
// cells land more than half a ring apart and the rings turn to noise.
//
// Two consequences, both of which took a picture to see rather than a metric:
//
// - This wants `fieldScale: 1`, like the rain and the ridges. Interpolating a
//   coarse field halves the resolution the rings are resolved at, and the first
//   version rendered at `fieldScale: 2` with `depth: 0.34` was flat mottle with
//   no rings in it at all. Supersampling says the same thing more precisely: the
//   error against a 4x reference halves, 0.037 to 0.020.
// - The vignette is not only hiding the singularity. Its radius is chosen to
//   cover the disc where the projection undersamples, and that disc is bigger on
//   a coarser field: measured against the tile's highest ring frequency it sits
//   at r = 0.30 on a 133-row field and r = 0.20 at the pixel ceiling. 0.3 covers
//   both. Dropping the vignette much below that uncovers a patch of moire rather
//   than a bright core, which is the failure worth knowing about.
//
// Turning `depth` up pushes that boundary outward as its square root. That is
// the trade the parameter makes: more rings on screen, and a larger middle that
// cannot resolve them.
//
// Stateless in time: the field is a pure function of the clock, like the plasma
// and the metaballs.
//
// Kept DOM-free so it can be unit-tested; the canvas and the loop live in
// tunnel-background.ts.

import { aspectOf, cellSpansOf } from './background.js';

const TAU = Math.PI * 2;

export interface TunnelParams {
  /** How fast the viewer travels, in tile lengths per second. */
  speed: number;
  /**
   * Scale on the `1 / radius` projection.
   *
   * Higher packs more of the tunnel into the same screen - more rings between
   * the middle and the edge, so it reads as longer and narrower.
   */
  depth: number;
  /** How many times the tile wraps around the circumference. Whole numbers only. */
  repeats: number;
  /** Rotations per second. Slow: it should read as a drift, not a barrel roll. */
  twist: number;
  /**
   * Radius at which the wall reaches full brightness, in field-height units.
   *
   * Everything inside it is graded away to nothing, which is what gives the
   * tunnel a dark throat rather than a bright blob where the maths breaks down.
   */
  vignette: number;
  /** Floor on the radius, guarding the singularity at the exact centre. */
  coreRadius: number;
  /**
   * How far the tunnel's axis wanders off straight, in wall radii.
   *
   * This is what makes it a corridor being flown through rather than a cylinder
   * being looked down. 0 is a straight tunnel.
   */
  bend: number;
  /** Cycles of the wind per unit depth. Higher is a twistier passage. */
  bendRate: number;
  /**
   * How far the view rolls into a turn, in turns per unit of lateral drift.
   *
   * Small: it is what sells the bend as flight rather than as the picture
   * sliding about, and past about 0.1 it reads as the whole image spinning.
   */
  bank: number;
  /** How far the vanishing point drifts, in field-height units. */
  sway: number;
  /** How fast it drifts. */
  swaySpeed: number;
  /** Edge of the wall tile, in samples. Wrapped on both axes. */
  tileSize: number;
}

export const TUNNEL_DEFAULTS: TunnelParams = {
  speed: 0.22,
  // How many rings land on the screen at once, and it is the parameter this
  // effect lives or dies by. At 0.34 the entire visible annulus spanned less than
  // half a tile - about one ring - and the result read as flat mottle rather than
  // as a tunnel. See the note on undersampling below.
  depth: 1,
  repeats: 2,
  // A twentieth of a turn a second. Any faster and it stops being a background.
  twist: 0.05,
  // Sized to cover the undersampled core rather than by eye: see below.
  vignette: 0.3,
  coreRadius: 0.035,
  // Just over a wall radius, so the corridor visibly leans without the far end
  // swinging so far off centre that the near wall fills the frame.
  bend: 1.15,
  bendRate: 0.55,
  bank: 0.05,
  sway: 0.06,
  swaySpeed: 0.13,
  tileSize: 128,
};

/** Seeds and phases that give one run its drift. */
export interface TunnelState {
  swayPhaseX: number;
  swayPhaseY: number;
  swayRateX: number;
  swayRateY: number;
  /** Starting distance down the tunnel, so two runs do not open identically. */
  offset: number;
  bendPhaseX: number;
  bendPhaseY: number;
  bendRateX: number;
  bendRateY: number;
}

export function randomizeTunnel(rand: () => number = Math.random): TunnelState {
  return {
    swayPhaseX: rand() * TAU,
    swayPhaseY: rand() * TAU,
    // Incommensurable, so the vanishing point traces a slow figure rather than
    // going round and round on a period a reader could notice.
    swayRateX: 0.7 + rand() * 0.5,
    swayRateY: 0.6 + rand() * 0.55,
    offset: rand() * 32,
    bendPhaseX: rand() * TAU,
    bendPhaseY: rand() * TAU,
    // Again incommensurable, so the passage does not return to the same corner
    // on a period a reader could learn.
    bendRateX: 0.8 + rand() * 0.45,
    bendRateY: 0.62 + rand() * 0.5,
  };
}

/**
 * A seamless wall tile, values in 0..1.
 *
 * Every frequency is a whole number of cycles across the tile, which is what
 * makes it wrap on both axes - and it has to, because the angular coordinate
 * comes back around every turn and the depth coordinate runs to infinity.
 *
 * The mix is deliberately structured rather than cloudy: bands around the
 * circumference and rings along it, so the forward motion is legible. A smooth
 * organic wall flies past without reading as movement at all.
 */
export function buildTunnelTile(size: number): Float32Array {
  const tile = new Float32Array(size * size);
  let lo = Infinity;
  let hi = -Infinity;

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;

      const value =
        Math.sin(TAU * (2 * u)) +
        0.7 * Math.sin(TAU * (3 * v)) +
        0.45 * Math.sin(TAU * (u + 2 * v)) +
        0.3 * Math.sin(TAU * (4 * u - v)) +
        0.2 * Math.sin(TAU * (6 * v));

      tile[y * size + x] = value;
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
  }

  const range = hi - lo || 1;
  for (let i = 0; i < tile.length; i++) tile[i] = (tile[i] - lo) / range;

  return tile;
}

/** Nearest sample of the tile, wrapping both axes. */
export function sampleTile(tile: Float32Array, size: number, u: number, v: number): number {
  // Double modulo: a bare % keeps the sign, and both coordinates go negative.
  const x = (((Math.floor(u * size) % size) + size) % size) | 0;
  const y = (((Math.floor(v * size) % size) + size) % size) | 0;
  return tile[y * size + x];
}

/**
 * Where the vanishing point sits at `time`, in field units, written into `out`.
 *
 * `x` spans `0..aspect` and `y` spans `0..1`, so the drift is isotropic and the
 * tunnel does not travel further sideways on a wide window than it does
 * vertically.
 */
export function tunnelCentre(
  time: number,
  aspect: number,
  params: TunnelParams,
  state: TunnelState,
  out: Float32Array
): void {
  const t = time * params.swaySpeed;
  out[0] = aspect / 2 + Math.sin(t * state.swayRateX + state.swayPhaseX) * params.sway;
  out[1] = 0.5 + Math.sin(t * state.swayRateY + state.swayPhaseY) * params.sway;
}

/**
 * How much of the wall shows at a given radius, 0 to 1.
 *
 * A smoothstep rather than a linear ramp, so the throat fades in without a ring
 * marking where the vignette ends.
 */
export function vignetteAt(radius: number, params: TunnelParams): number {
  if (params.vignette <= 0) return 1;
  const t = radius / params.vignette;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/**
 * Where the tunnel's axis sits at depth `v`, in wall radii, written into `out`.
 *
 * Two incommensurable sinusoids, so the corridor leans one way and then another
 * without ever repeating on a period short enough to notice. Bounded on purpose:
 * a path that wandered without limit would take the far end of the tunnel
 * off-screen entirely, and there is nothing behind it to show.
 */
export function axisAt(v: number, params: TunnelParams, state: TunnelState, out: Float32Array): void {
  const t = v * params.bendRate;
  out[0] = Math.sin(t * state.bendRateX + state.bendPhaseX) * params.bend;
  out[1] = Math.sin(t * state.bendRateY + state.bendPhaseY) * params.bend;
}

/**
 * The axis position over the depths one frame can see, sampled into a table.
 *
 * Evaluating `axisAt` per cell means two sines per cell, which measured at 3.8 ms
 * a frame on a 160,000-cell field - as much again as the rest of the effect put
 * together. The axis depends on nothing but depth, and one frame only ever sees
 * depths between the far corner of the screen and the edge of the vignette, so a
 * few hundred samples across that span replace every one of those sines with a
 * lerp. The same trick as the wall tile, for the same reason.
 *
 * It is an approximation, but a controlled one: the axis is two sinusoids of
 * bounded frequency, so the error is that of linear interpolation on a smooth
 * curve. `TABLE_SIZE` samples across a span the axis crosses only a fraction of a
 * cycle in keeps it far below what five palette levels can show, and there is a
 * test pinning it against the exact function.
 */
export interface AxisTable {
  /** Interleaved x, y pairs. */
  values: Float32Array;
  /** Depth of the first sample. */
  from: number;
  /** Depth step between samples. */
  step: number;
}

const TABLE_SIZE = 512;

export function createAxisTable(): AxisTable {
  return { values: new Float32Array(TABLE_SIZE * 2), from: 0, step: 1 };
}

/** Fills `table` with the axis over `from`..`to`. */
export function fillAxisTable(
  table: AxisTable,
  from: number,
  to: number,
  params: TunnelParams,
  state: TunnelState,
  scratch: Float32Array
): void {
  table.from = from;
  // A span of zero would make every lookup divide by it; one sample repeated is
  // the right answer there, and it happens whenever the field is a single cell.
  table.step = to > from ? (to - from) / (TABLE_SIZE - 1) : 0;
  for (let i = 0; i < TABLE_SIZE; i++) {
    axisAt(from + table.step * i, params, state, scratch);
    table.values[i * 2] = scratch[0];
    table.values[i * 2 + 1] = scratch[1];
  }
}

/** The axis at `v`, interpolated from `table` and written into `out`. */
export function axisFromTable(table: AxisTable, v: number, out: Float32Array): void {
  const { values, from, step } = table;
  // Clamped rather than wrapped: outside the span is the region the frame cannot
  // see, and holding the end value there is what the horizon does anyway.
  const t = step > 0 ? (v - from) / step : 0;
  const i = t <= 0 ? 0 : t >= TABLE_SIZE - 1 ? TABLE_SIZE - 1 : Math.floor(t);
  const f = t <= 0 || t >= TABLE_SIZE - 1 ? 0 : t - i;
  const j = i + 1 < TABLE_SIZE ? i + 1 : i;
  out[0] = values[i * 2] + (values[j * 2] - values[i * 2]) * f;
  out[1] = values[i * 2 + 1] + (values[j * 2 + 1] - values[i * 2 + 1]) * f;
}

/**
 * The wall coordinate a screen offset reads from, written into `out` as
 * `[u, v, distance]`.
 *
 * Pulled out of the render loop because it *is* the effect, and because the
 * property that matters is not observable in the finished field: `v` falls as
 * the radius grows and rises with `travel`, and those two together are what make
 * features sweep outward. Watching the rendered rings instead does not settle it,
 * since they do not translate - they stretch, moving further the further out they
 * already are, which is the perspective accelerating.
 *
 * `distance` comes back unfloored so the caller can vignette on the true radius
 * while sampling on the floored one.
 *
 * THE BEND IS ONE FIXED-POINT ITERATION
 * ------------------------------------
 * With a straight axis this is a single division. With a winding one it is still
 * almost that, and the reason is worth writing down.
 *
 * Put the wall at radius 1 about an axis at `(X(z), Y(z))` and project through a
 * pinhole: a wall point at depth `z`, angle `t`, lands at `R * (X(z) + cos t,
 * Y(z) + sin t)` where `R = f / z` is the radius the wall appears at. Read that
 * backwards - which is what this function does - and the screen offset to undo is
 * `R * X(z)`, with `R` the *corrected* radius rather than the raw one. So the
 * exact answer is a fixed point, and one pass of it is all this takes: solve the
 * straight tunnel, look up the axis at the depth that gives, subtract, solve
 * again. Costs one extra square root - not an extra atan2, because the first pass
 * needs only the radius - and it is exact wherever the axis is not moving fast
 * compared to the depth.
 *
 * Note `R * X`, not `X`: a lateral offset subtends less the further away it is,
 * so the correction vanishes at the centre of the screen and is largest at the
 * edges. That is the right way round, and it is what makes the near wall sweep
 * past while the far end stays put - the thing that reads as flying through a
 * corridor rather than as the picture sliding sideways.
 *
 * `axis` carries both the table to read the bend from and the scratch to read it
 * into; pass null for a straight tunnel.
 */
export function wallCoords(
  dx: number,
  dy: number,
  params: TunnelParams,
  travel: number,
  spin: number,
  out: Float32Array,
  axis: { table: AxisTable; scratch: Float32Array } | null = null
): void {
  let distance = Math.sqrt(dx * dx + dy * dy);
  // Floored, or the reciprocal runs away at the exact centre.
  let radius = distance < params.coreRadius ? params.coreRadius : distance;

  let roll = spin;

  if (axis && params.bend !== 0) {
    // The axis is looked up no deeper than the edge of the vignette, and that is
    // not an optimisation. `v` runs away towards the middle of the screen, so a
    // winding axis sampled there swings by whole cycles between neighbouring
    // cells and the throat fills with churning noise. Inside the vignette
    // nothing is drawn, so holding the lookup at its edge costs no visible
    // detail and keeps the deep centre coherent - a real horizon, in effect:
    // beyond a certain depth a bent corridor is blocked by its own wall anyway.
    const seen = radius < params.vignette ? params.vignette : radius;
    const lean = axis.scratch;
    axisFromTable(axis.table, params.depth / seen + travel, lean);
    dx -= lean[0] * radius;
    dy -= lean[1] * radius;

    distance = Math.sqrt(dx * dx + dy * dy);
    radius = distance < params.coreRadius ? params.coreRadius : distance;

    // Bank into the turn. Rolling by where the axis has gone rather than by how
    // fast it is going is deliberate: the derivative is what a vehicle's roll
    // actually follows, but it is also a quarter-cycle out of phase with the
    // lean, which reads as the picture counter-rotating against its own bend.
    roll += axis.scratch[0] * params.bank;
  }

  out[0] = (Math.atan2(dy, dx) / TAU + roll) * params.repeats;
  out[1] = params.depth / radius + travel;
  out[2] = distance;
}

export interface Tunnel {
  w: number;
  h: number;
  /** Wall brightness per cell, 0 to 1, row-major. This is what gets shaded. */
  field: Float32Array;
  tile: Float32Array;
  state: TunnelState;
  /** Scratch for the current centre, so the render loop allocates nothing. */
  centre: Float32Array;
  /** Scratch for one cell's wall coordinate. Same reason.  */
  coords: Float32Array;
  /** The bend over this frame's visible depths, and scratch to read it into. */
  axis: { table: AxisTable; scratch: Float32Array };
}

export function createTunnel(w: number, h: number, rand: () => number = Math.random, params = TUNNEL_DEFAULTS): Tunnel {
  return {
    w,
    h,
    field: new Float32Array(w * h),
    tile: buildTunnelTile(params.tileSize),
    state: randomizeTunnel(rand),
    centre: new Float32Array(2),
    coords: new Float32Array(3),
    axis: { table: createAxisTable(), scratch: new Float32Array(2) },
  };
}

/**
 * Draws one frame.
 *
 * `steer` overrides the vanishing point when the pointer is pushing it about;
 * pass null to leave it on its own drift.
 *
 * `atan2` per cell looks expensive and is not worth precomputing away. Caching it
 * would mean caching the radius too, and both change the moment the centre moves
 * - which it does every frame, by design. Measured cost is in the note above the
 * defaults in tunnel-background.ts.
 */
export function renderTunnel(
  tunnel: Tunnel,
  params: TunnelParams,
  time: number,
  steer: readonly [number, number] | null = null
): void {
  const { w, h, field, tile, state, centre, coords, axis } = tunnel;
  const aspect = aspectOf(tunnel);

  tunnelCentre(time, aspect, params, state, centre);
  const cx = steer ? steer[0] : centre[0];
  const cy = steer ? steer[1] : centre[1];

  const travel = time * params.speed + state.offset;
  const spin = time * params.twist;

  // Only the fractional parts reach the per-cell coordinates. `travel` and
  // `spin` both grow without bound, and the coordinates pass through a
  // Float32Array - after a day of travel its precision is a visible fraction of
  // a tile cell, so the texture would quantise on a long-running page. The tile
  // repeats every whole unit on both axes and `repeats` is a whole number, so
  // dropping the whole parts changes nothing the sampler can see.
  const travelFrac = travel - Math.floor(travel);
  const spinFrac = spin - Math.floor(spin);

  const [spanX, spanY] = cellSpansOf(tunnel);

  if (params.bend !== 0) {
    // The depths this frame can see, from the furthest corner to the edge of the
    // vignette. Taken from the actual centre rather than assumed, because a steer
    // can push it right up against one side and put a corner much further away -
    // and the furthest corner is simply the larger reach on each axis.
    const far = Math.hypot(Math.max(cx, aspect - cx), Math.max(cy, 1 - cy));
    const near = Math.max(params.vignette, params.coreRadius);
    // Built on the unreduced travel, in float64: the axis is deliberately not
    // periodic, so its shape has to come from the true depth. The table is then
    // shifted into the reduced coordinate the cells actually pass, so lookups
    // still land on the right samples.
    fillAxisTable(
      axis.table,
      params.depth / Math.max(far, near) + travel,
      params.depth / near + travel,
      params,
      state,
      axis.scratch
    );
    axis.table.from -= travel - travelFrac;
  }

  for (let j = 0; j < h; j++) {
    const dy = j * spanY - cy;

    for (let i = 0; i < w; i++) {
      wallCoords(i * spanX - cx, dy, params, travelFrac, spinFrac, coords, axis);
      field[j * w + i] = sampleTile(tile, params.tileSize, coords[0], coords[1]) * vignetteAt(coords[2], params);
    }
  }
}
