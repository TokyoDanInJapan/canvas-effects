// The maths behind the smoke background: an actual fluid solver.
//
// Semi-Lagrangian advection with a Jacobi pressure projection - the scheme from
// Jos Stam's "Stable Fluids" (1999), which is the standard way to do this.
// Every frame:
//
//   1. forces      - buoyancy from the smoke's own density, plus a light stir
//   2. confinement - put back the small-scale swirl the solver eats
//   3. advect      - carry the velocity field through itself
//   4. project     - remove the divergence, so the fluid stops compressing
//   5. advect      - carry the density through the corrected velocity
//   6. replenish   - feed a little source back in
//
// WHY THIS AND NOT CURL NOISE
// ---------------------------
// A curl-noise flow is divergence-free and swirls convincingly, and it is far
// cheaper. What it does not have is *momentum*. Its eddies are prescribed by a
// noise field rather than caused by anything, so they cannot be spun up by the
// smoke, cannot persist once whatever made them has gone, and cannot interact.
// A real solver gets vortices shedding off shear layers, plumes that overturn
// because they are heavy, and structure with a history. That is the difference
// between something that looks like smoke in a still frame and something that
// behaves like it in motion.
//
// STEP 4 IS THE WHOLE THING
// -------------------------
// Advection on its own lets the fluid compress: density piles up, and it reads
// as a texture being stretched. The projection is what makes it a fluid. It
// solves for the pressure whose gradient cancels the divergence and subtracts
// it - a Poisson solve, done here with Jacobi iterations because they are
// simple, branch-free, and quite good enough for something nobody is meant to
// be looking at.
//
// The grid wraps in both directions. That makes the boundary conditions
// periodic, which is both the easiest case to solve and the one with no edges
// for a reader to notice.
//
// Kept DOM-free so it can be unit-tested; the canvas and the loop live in
// smoke-background.ts.

import { fbm } from './noise';

export interface SmokeParams {
  /** Jacobi iterations in the pressure solve. More is rounder, and slower. */
  iterations: number;
  /** Upward force per unit of density above the mean. */
  buoyancy: number;
  /**
   * Vorticity confinement. Semi-Lagrangian advection is diffusive and eats the
   * smallest eddies; this feeds energy back into them, which is where the wisps
   * and curls come from. Too much and it boils.
   */
  vorticity: number;
  /** Velocity lost per second. Without it the forces accumulate forever. */
  drag: number;
  /** Strength of the noise stirring that keeps it from settling. */
  stir: number;
  /** Spatial scale of the stirring noise. */
  stirScale: number;
  /** How fast the stirring pattern changes. */
  stirChurn: number;
  /** Fraction of the source mixed back in per second. */
  replenish: number;
  /** Spatial scale of the source pattern. */
  sourceScale: number;
  /**
   * The source is shaped by a smoothstep between these two, which turns smooth
   * noise into distinct dense regions with clear air between them. A smooth
   * source has no edges for the flow to stretch, and stretching nothing gives
   * fog rather than smoke.
   */
  sourceLow: number;
  sourceHigh: number;
  /** Octaves for the noise fields. */
  octaves: number;

  /** Mean seconds between jets. */
  jetInterval: number;
  /** How long a jet blows for, in seconds. */
  jetDuration: number;
  /** Nozzle radius, as a fraction of the shorter side of the grid. */
  jetRadius: number;
  /** Speed the nozzle drives the fluid at, in cells per second. */
  jetSpeed: number;
  /** Density a pale jet emits. */
  jetDensity: number;
  /** Density a dark jet emits - clear air, which carves rather than paints. */
  jetDarkDensity: number;
  /** Chance a given jet is a dark one. */
  jetDarkChance: number;

  /** Radius the cursor stirs within, as a fraction of the shorter grid side. */
  strokeRadius: number;
  /** Cells per second of velocity per cell of drag. */
  strokeStrength: number;
  /** Ceiling on that, so a flick across the screen cannot punch a hole. */
  strokeMaxSpeed: number;
}

export const SMOKE_DEFAULTS: SmokeParams = {
  iterations: 24,
  // Swept rather than guessed. Drag turns out to dominate everything else: it
  // sets the flow speed, and the flow speed sets how fast the smoke mixes
  // itself towards uniform. Fast flow looks livelier frame to frame and reads
  // as fog within seconds. These give a mean of about an eighth of a cell per
  // frame, which only works because MacCormack advection made slow transport
  // stop meaning blur.
  buoyancy: 14,
  vorticity: 26,
  // Swept against replenish. Drag has to serve two things at once: low enough
  // that a jet's momentum carries across the field rather than stalling a few
  // cells from the nozzle, high enough that the ambient smoke does not mix
  // itself to fog between jets. At 0.5 the jets were good and the background
  // was a flat haze; 0.9 with the matching replenish holds both.
  drag: 0.9,
  stir: 6,
  stirScale: 2.4,
  stirChurn: 0.11,
  // Paired with drag: it is what keeps re-establishing the ambient structure
  // that the flow is continually mixing away.
  replenish: 0.9,
  sourceScale: 4.2,
  // Dense enough for a jet to have something to tear through. This was briefly
  // thinned right down, back when the event was a puff of *density* that needed
  // headroom to show. A jet is the opposite: it is visible through the hole it
  // opens and the vortices rolling off its edges, and both need smoke there in
  // the first place.
  sourceLow: 0.3,
  sourceHigh: 0.68,
  octaves: 3,
  jetInterval: 12,
  jetDuration: 1.9,
  jetRadius: 0.19,
  // Fast enough to cross the field in about two seconds, which is what makes it
  // read as a jet rather than a gust. Far above the ambient flow on purpose.
  jetSpeed: 92,
  jetDensity: 1,
  jetDarkDensity: 0,
  jetDarkChance: 0.45,
  strokeRadius: 0.17,
  strokeStrength: 130,
  strokeMaxSpeed: 190,
};

/** Seeds and offsets that give one run its character. */
export interface SmokeState {
  seeds: [number, number, number, number];
  offsets: [number, number, number, number];
  /** Slow translation of the source pattern, in domain units per second. */
  drift: [number, number];
}

export function randomizeSmoke(rand: () => number = Math.random): SmokeState {
  const sign = () => (rand() < 0.5 ? 1 : -1);

  return {
    seeds: [
      Math.floor(rand() * 100000) + 1,
      Math.floor(rand() * 100000) + 1,
      Math.floor(rand() * 100000) + 1,
      Math.floor(rand() * 100000) + 1,
    ],
    offsets: [rand() * 64, rand() * 64, rand() * 64, rand() * 64],
    drift: [(0.01 + rand() * 0.02) * sign(), (0.01 + rand() * 0.02) * sign()],
  };
}

/**
 * Everything the solver works on, allocated once.
 *
 * The neighbour tables are why this is a struct rather than a pile of
 * arguments. Every one of the passes below needs the four wrapped neighbours of
 * every cell, and computing that with a modulo in the inner loop costs more
 * than the arithmetic it feeds. Built once per resize, they turn the whole
 * solver into flat array indexing.
 */
export interface Fluid {
  w: number;
  h: number;
  u: Float32Array;
  v: Float32Array;
  uNext: Float32Array;
  vNext: Float32Array;
  density: Float32Array;
  densityNext: Float32Array;
  densityBack: Float32Array;
  pressure: Float32Array;
  pressureNext: Float32Array;
  divergence: Float32Array;
  curl: Float32Array;
  source: Float32Array;
  left: Int32Array;
  right: Int32Array;
  up: Int32Array;
  down: Int32Array;
}

export function createFluid(w: number, h: number): Fluid {
  const n = w * h;
  const left = new Int32Array(n);
  const right = new Int32Array(n);
  const up = new Int32Array(n);
  const down = new Int32Array(n);

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      left[k] = j * w + ((i - 1 + w) % w);
      right[k] = j * w + ((i + 1) % w);
      up[k] = ((j - 1 + h) % h) * w + i;
      down[k] = ((j + 1) % h) * w + i;
    }
  }

  return {
    w,
    h,
    u: new Float32Array(n),
    v: new Float32Array(n),
    uNext: new Float32Array(n),
    vNext: new Float32Array(n),
    density: new Float32Array(n),
    densityNext: new Float32Array(n),
    densityBack: new Float32Array(n),
    pressure: new Float32Array(n),
    pressureNext: new Float32Array(n),
    divergence: new Float32Array(n),
    curl: new Float32Array(n),
    source: new Float32Array(n),
    left,
    right,
    up,
    down,
  };
}

/**
 * Bilinear sample of a field, wrapping at every edge.
 *
 * Wrapping rather than clamping is what keeps the smoke edgeless: density that
 * leaves one side arrives at the other, so there is no boundary for it to pile
 * up against and no visible frame around the effect.
 */
export function sampleWrapped(field: Float32Array, w: number, h: number, x: number, y: number): number {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const tx = x - fx;
  const ty = y - fy;

  // Double modulo: a bare % keeps the sign in JavaScript, and back-traced
  // coordinates are routinely negative.
  const x0 = (((fx % w) + w) % w) | 0;
  const y0 = (((fy % h) + h) % h) | 0;
  const x1 = (x0 + 1) % w;
  const y1 = (y0 + 1) % h;

  const a = field[y0 * w + x0];
  const b = field[y0 * w + x1];
  const c = field[y1 * w + x0];
  const d = field[y1 * w + x1];

  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * ty;
}

/**
 * Semi-Lagrangian advection: for each cell, look *back* along the velocity to
 * where its contents came from, and sample there.
 *
 * Tracing backwards rather than pushing forwards is what makes this
 * unconditionally stable - however large the step, every cell still gets
 * exactly one well-defined value, so it cannot blow up. The price is diffusion,
 * which is why vorticity confinement exists.
 */
export function advect(
  src: Float32Array,
  dst: Float32Array,
  u: Float32Array,
  v: Float32Array,
  w: number,
  h: number,
  dt: number
): void {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      dst[k] = sampleWrapped(src, w, h, i - u[k] * dt, j - v[k] * dt);
    }
  }
}

/**
 * The lowest and highest of the four cells a bilinear sample would read.
 *
 * Used to limit the MacCormack correction below. Writes into `out` to keep the
 * inner loop allocation-free.
 */
export function sampleBounds(field: Float32Array, w: number, h: number, x: number, y: number, out: Float32Array): void {
  const x0 = (((Math.floor(x) % w) + w) % w) | 0;
  const y0 = (((Math.floor(y) % h) + h) % h) | 0;
  const x1 = (x0 + 1) % w;
  const y1 = (y0 + 1) % h;

  const a = field[y0 * w + x0];
  const b = field[y0 * w + x1];
  const c = field[y1 * w + x0];
  const d = field[y1 * w + x1];

  out[0] = Math.min(a, b, c, d);
  out[1] = Math.max(a, b, c, d);
}

/**
 * MacCormack advection: advect forward, advect that result back again, and use
 * how far it misses as an estimate of the error to cancel.
 *
 * Plain semi-Lagrangian advection is stable but heavily diffusive - it
 * resamples every cell every step, so the field smooths itself out even where
 * the flow is only carrying it. That is fatal here: smoke without sharp edges
 * is fog, and no amount of vorticity in the *velocity* puts edges back into a
 * density field that has already lost them.
 *
 * The trick is that advecting forwards and then backwards ought to return the
 * original. Whatever it comes back short by is the scheme's own error, and half
 * of that added to the forward result cancels most of it.
 *
 * The correction is then clamped to the range of the cells the forward trace
 * actually read. Without that limiter MacCormack overshoots at exactly the
 * sharp edges it is meant to preserve, producing values outside the original
 * range - here, densities outside 0..1, and eventually a field that blows up.
 */
export function advectMacCormack(fluid: Fluid, dt: number): void {
  const { density, densityNext, densityBack, u, v, w, h } = fluid;
  const bounds = new Float32Array(2);

  advect(density, densityNext, u, v, w, h, dt);
  advect(densityNext, densityBack, u, v, w, h, -dt);

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const corrected = densityNext[k] + 0.5 * (density[k] - densityBack[k]);

      sampleBounds(density, w, h, i - u[k] * dt, j - v[k] * dt, bounds);
      densityNext[k] = corrected < bounds[0] ? bounds[0] : corrected > bounds[1] ? bounds[1] : corrected;
    }
  }
}

/**
 * How much the velocity field is spreading out or piling up, per cell.
 *
 * Backward differences, deliberately, and this is not a detail. The pressure is
 * solved against the compact five-point Laplacian, so the divergence and the
 * gradient that follows it have to compose into exactly that stencil. Central
 * differences for both feel like the obvious choice and are wrong: they compose
 * into a *wide* Laplacian spanning two cells, which does not match the equation
 * being solved, decouples odd from even cells, and leaves most of the
 * divergence behind. Backward here plus forward in `subtractPressureGradient`
 * telescopes to `p[l] + p[r] + p[u] + p[d] - 4p[c]` exactly, which makes the
 * projection exact up to how far the solve has converged.
 */
export function computeDivergence(fluid: Fluid): void {
  const { u, v, divergence, left, up } = fluid;
  for (let k = 0; k < divergence.length; k++) {
    divergence[k] = u[k] - u[left[k]] + (v[k] - v[up[k]]);
  }
}

/**
 * Solves for the pressure whose gradient cancels the divergence, by Jacobi
 * iteration.
 *
 * Jacobi rather than Gauss-Seidel deliberately: it reads only the previous
 * iterate, so there is no ordering dependence and no branching, which is both
 * easier to reason about and faster here. It converges more slowly per pass,
 * but the pressure only has to be approximately right - what matters is that
 * most of the divergence goes away.
 */
export function solvePressure(fluid: Fluid, iterations: number): void {
  const { divergence, left, right, up, down } = fluid;
  let p = fluid.pressure;
  let next = fluid.pressureNext;
  p.fill(0);

  for (let iter = 0; iter < iterations; iter++) {
    for (let k = 0; k < p.length; k++) {
      next[k] = (p[left[k]] + p[right[k]] + p[up[k]] + p[down[k]] - divergence[k]) * 0.25;
    }
    const swap = p;
    p = next;
    next = swap;
  }

  fluid.pressure = p;
  fluid.pressureNext = next;
}

/**
 * Subtracts the pressure gradient, leaving the velocity divergence-free.
 *
 * Forward differences, to pair with the backward differences in
 * `computeDivergence` - see the note there for why the pairing matters.
 */
export function subtractPressureGradient(fluid: Fluid): void {
  const { u, v, pressure, right, down } = fluid;
  for (let k = 0; k < u.length; k++) {
    u[k] -= pressure[right[k]] - pressure[k];
    v[k] -= pressure[down[k]] - pressure[k];
  }
}

/**
 * Vorticity confinement.
 *
 * The solver is diffusive and steadily eats the smallest eddies - left alone,
 * stable-fluids smoke goes smooth and lifeless. This measures the curl that is
 * left, finds the direction in which it is strengthening, and pushes along it
 * to sharpen it. It is not physical; it is putting back energy the numerics
 * removed, at the scale they removed it from.
 */
export function applyVorticityConfinement(fluid: Fluid, strength: number, dt: number): void {
  const { u, v, curl, left, right, up, down } = fluid;

  for (let k = 0; k < curl.length; k++) {
    curl[k] = 0.5 * (v[right[k]] - v[left[k]] - (u[down[k]] - u[up[k]]));
  }

  for (let k = 0; k < curl.length; k++) {
    // Gradient of |curl| - the direction the swirl is strengthening in.
    const gx = 0.5 * (Math.abs(curl[right[k]]) - Math.abs(curl[left[k]]));
    const gy = 0.5 * (Math.abs(curl[down[k]]) - Math.abs(curl[up[k]]));
    const length = Math.sqrt(gx * gx + gy * gy);
    if (length < 1e-6) continue;

    // N x curl, in two dimensions.
    u[k] += strength * (gy / length) * curl[k] * dt;
    v[k] -= strength * (gx / length) * curl[k] * dt;
  }
}

/**
 * Buoyancy: dense smoke rises.
 *
 * Measured against the mean rather than absolutely, so the fluid gets no net
 * push. Forcing every cell upward on a wrapping grid would simply scroll the
 * whole field, which is not what buoyancy looks like.
 */
export function applyBuoyancy(fluid: Fluid, strength: number, dt: number): void {
  const { v, density } = fluid;

  let total = 0;
  for (let k = 0; k < density.length; k++) total += density[k];
  const mean = total / density.length;

  // Negative is up: y grows downward on a canvas.
  for (let k = 0; k < v.length; k++) v[k] -= strength * (density[k] - mean) * dt;
}

/**
 * A light, slowly changing stir.
 *
 * Buoyancy on its own is a closed loop - it drives the flow from the density,
 * and the flow rearranges the density - and the pair can settle into a steady
 * circulation. This keeps breaking the symmetry so it never quite settles.
 */
export function applyStirring(fluid: Fluid, params: SmokeParams, state: SmokeState, time: number, dt: number): void {
  const { u, v, w, h } = fluid;
  const { stir, stirScale, stirChurn, octaves } = params;
  const { seeds, offsets } = state;
  const t = time * stirChurn;

  for (let j = 0; j < h; j++) {
    const y = (j / h) * stirScale;
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const x = (i / w) * stirScale;
      u[k] += (fbm(x + offsets[0] + t, y + offsets[1], seeds[0], octaves) - 0.5) * stir * dt;
      v[k] += (fbm(x + offsets[2], y + offsets[3] - t, seeds[1], octaves) - 0.5) * stir * dt;
    }
  }
}

/**
 * A jet of smoke fired in from one side.
 *
 * Not a puff of density dropped into the field - that was the first attempt and
 * it barely showed, because density added to an already-dense field is mostly
 * clamped away and adds no motion at all. What makes a jet visible is
 * *momentum*: it drives the fluid hard enough to shove what is already there
 * out of the way, and the hole it opens and the vortices rolling off its edges
 * are the effect. The smoke it carries is almost incidental.
 */
export interface Jet {
  /** Nozzle position, in cells, on one edge of the grid. */
  x: number;
  y: number;
  /** Unit direction it fires in. */
  dirX: number;
  dirY: number;
  /** Nozzle radius, in cells. */
  radius: number;
  /** Speed it drives the fluid at, in cells per second. */
  speed: number;
  /** Density it emits: high for a pale jet, near zero for a dark one. */
  density: number;
  /** Seconds it blows for. */
  duration: number;
}

/**
 * Picks a jet: a nozzle somewhere along a random edge, aimed across.
 *
 * Some are pale and some are dark, and the difference is only what the nozzle
 * emits - the momentum is identical. A pale jet drives the density up and paints
 * a bright plume; a dark one drives it to nothing and carves a clear channel
 * through whatever is there. Both distort the smoke in exactly the same way,
 * because the distortion comes from the velocity and the projection, not from
 * what is being carried.
 *
 * Pure given `rand`, so the tests can pin it and a seeded run is repeatable.
 */
export function planJet(w: number, h: number, rand: () => number, params: SmokeParams): Jet {
  const radius = Math.max(2, params.jetRadius * Math.min(w, h) * (0.75 + rand() * 0.5));
  const speed = params.jetSpeed * (0.75 + rand() * 0.5);
  const duration = params.jetDuration * (0.7 + rand() * 0.6);
  const along = rand();
  // Angled off square, so they do not all cross the same way.
  const skew = (rand() - 0.5) * 0.9;
  const edge = Math.floor(rand() * 4) % 4;
  const dark = rand() < params.jetDarkChance;

  const length = Math.sqrt(1 + skew * skew);
  const density = dark ? params.jetDarkDensity : params.jetDensity;
  const base = { radius, speed, density, duration };

  switch (edge) {
    case 0:
      return { ...base, x: along * w, y: 0, dirX: skew / length, dirY: 1 / length };
    case 1:
      return { ...base, x: w, y: along * h, dirX: -1 / length, dirY: skew / length };
    case 2:
      return { ...base, x: along * w, y: h, dirX: skew / length, dirY: -1 / length };
    default:
      return { ...base, x: 0, y: along * h, dirX: 1 / length, dirY: skew / length };
  }
}

/** How long to wait before the next one. Half to one and a half times the mean. */
export function nextJetDelay(rand: () => number, params: SmokeParams): number {
  return params.jetInterval * (0.5 + rand());
}

/**
 * Drives the nozzle for one frame. Called every frame a jet is alive.
 *
 * The velocity is *driven towards* the jet's, not added to it. Adding would
 * make the jet's strength depend on the frame rate and on how long it had been
 * running; driving makes the nozzle behave like an inflow boundary, holding a
 * fixed speed however hard the surrounding fluid and the drag push back.
 *
 * No attempt is made to keep this divergence-free - forcing fluid in at one
 * point is exactly the sort of thing that is not. The projection on the next
 * step is what works out where the displaced air has to go, and that
 * redistribution *is* the distortion: the smoke ahead is shouldered aside and
 * rolls into vortices along the shear at the jet's edges.
 */
export function applyJet(fluid: Fluid, jet: Jet, dt: number): void {
  const { w, h, density, u, v } = fluid;
  const radius = Math.max(1, jet.radius);
  const radius2 = radius * radius;
  const reach = Math.ceil(radius);

  const targetU = jet.dirX * jet.speed;
  const targetV = jet.dirY * jet.speed;

  for (let dy = -reach; dy <= reach; dy++) {
    const gy = Math.round(jet.y) + dy;
    const row = (((gy % h) + h) % h) * w;

    for (let dx = -reach; dx <= reach; dx++) {
      const squared = dx * dx + dy * dy;
      if (squared > radius2) continue;

      const gx = Math.round(jet.x) + dx;
      const k = row + (((gx % w) + w) % w);

      // Smooth across the nozzle, so it has no hard rim.
      const falloff = (1 - squared / radius2) ** 2;
      // Clamped, so a long frame cannot overshoot past the target.
      const grip = Math.min(1, falloff * dt * 24);

      u[k] += (targetU - u[k]) * grip;
      v[k] += (targetV - v[k]) * grip;
      density[k] += (jet.density - density[k]) * grip;
    }
  }
}

/** One frame's worth of cursor drag, in grid cells. */
export interface Stroke {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

/**
 * Shoves the fluid along a drag of the cursor.
 *
 * Velocity is *added* here, unlike the jet nozzle which drives towards a fixed
 * speed. A drag is an impulse rather than a boundary condition: the reader
 * pushes the smoke and then lets go of it, and what happens next should be the
 * fluid's business, not the cursor's.
 *
 * The speed is capped. Without it a fast flick across the screen injects a
 * velocity of thousands of cells per second, which the solver survives - it is
 * unconditionally stable - but which tears a hole straight through the field
 * and takes several seconds to settle. The cap keeps a hard drag emphatic
 * rather than destructive.
 */
export function applyStroke(fluid: Fluid, stroke: Stroke, params: SmokeParams, dt: number): void {
  const { w, h, u, v } = fluid;
  const drag = Math.hypot(stroke.dx, stroke.dy);
  if (drag < 1e-4) return;

  const speed = Math.min(params.strokeMaxSpeed, drag * params.strokeStrength);
  const pushU = (stroke.dx / drag) * speed;
  const pushV = (stroke.dy / drag) * speed;

  const radius = Math.max(1, params.strokeRadius * Math.min(w, h));
  const radius2 = radius * radius;
  const reach = Math.ceil(radius);

  for (let dy = -reach; dy <= reach; dy++) {
    const gy = Math.round(stroke.y) + dy;
    const row = (((gy % h) + h) % h) * w;

    for (let dx = -reach; dx <= reach; dx++) {
      const squared = dx * dx + dy * dy;
      if (squared > radius2) continue;

      const gx = Math.round(stroke.x) + dx;
      const k = row + (((gx % w) + w) % w);

      // Smooth to nothing at the rim, so the cursor has no hard edge.
      const falloff = (1 - squared / radius2) ** 2;
      u[k] += pushU * falloff * dt * 24;
      v[k] += pushV * falloff * dt * 24;
    }
  }
}

/**
 * Fills the source field - the smoke being fed in.
 *
 * Low frequency on purpose. The fine structure is not drawn here; it is what
 * the fluid makes of this as it folds it.
 */
export function computeSource(
  time: number,
  params: SmokeParams,
  state: SmokeState,
  out: Float32Array,
  w: number,
  h: number
): void {
  const { sourceScale, sourceLow, sourceHigh, octaves } = params;
  const { seeds, offsets, drift } = state;
  const dx = drift[0] * time;
  const dy = drift[1] * time;
  const span = sourceHigh - sourceLow || 1;

  for (let j = 0; j < h; j++) {
    const y = (j / h) * sourceScale + dy;
    for (let i = 0; i < w; i++) {
      const x = (i / w) * sourceScale + dx;
      const raw = fbm(x + offsets[2], y + offsets[0], seeds[2], octaves);
      const t = Math.min(1, Math.max(0, (raw - sourceLow) / span));
      out[j * w + i] = t * t * (3 - 2 * t);
    }
  }
}

/** One frame of fluid. See the list at the top of the file. */
export function stepFluid(fluid: Fluid, params: SmokeParams, state: SmokeState, time: number, dt: number): void {
  const { w, h } = fluid;

  applyBuoyancy(fluid, params.buoyancy, dt);
  applyStirring(fluid, params, state, time, dt);
  applyVorticityConfinement(fluid, params.vorticity, dt);

  const keep = Math.max(0, 1 - params.drag * dt);
  for (let k = 0; k < fluid.u.length; k++) {
    fluid.u[k] *= keep;
    fluid.v[k] *= keep;
  }

  // The velocity carries itself. Both components have to be advected through
  // the *old* field, so they are written into separate buffers and swapped in.
  advect(fluid.u, fluid.uNext, fluid.u, fluid.v, w, h, dt);
  advect(fluid.v, fluid.vNext, fluid.u, fluid.v, w, h, dt);
  let swap = fluid.u;
  fluid.u = fluid.uNext;
  fluid.uNext = swap;
  swap = fluid.v;
  fluid.v = fluid.vNext;
  fluid.vNext = swap;

  computeDivergence(fluid);
  solvePressure(fluid, params.iterations);
  subtractPressureGradient(fluid);

  advectMacCormack(fluid, dt);
  swap = fluid.density;
  fluid.density = fluid.densityNext;
  fluid.densityNext = swap;

  computeSource(time, params, state, fluid.source, w, h);
  const mix = Math.min(1, params.replenish * dt);
  const { density, source } = fluid;
  for (let k = 0; k < density.length; k++) density[k] += (source[k] - density[k]) * mix;
}

/**
 * Mean absolute divergence - how compressible the velocity field currently is.
 *
 * Exported because it is the one number that says whether the solver is
 * working: it should be near zero after a projection and much larger before.
 */
export function meanAbsDivergence(fluid: Fluid): number {
  computeDivergence(fluid);
  let total = 0;
  for (let k = 0; k < fluid.divergence.length; k++) total += Math.abs(fluid.divergence[k]);
  return total / fluid.divergence.length;
}
