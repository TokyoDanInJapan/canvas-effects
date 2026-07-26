// Metaballs: an implicit surface. Several point sources each contribute a
// falloff to a shared scalar field, and the field is thresholded to a surface -
// so blobs bulge towards each other as they approach, fuse with a smooth neck,
// and part again without ever showing a seam.
//
// That merging is the whole point, and it is not a drawing trick. Nothing here
// knows about blobs or necks; there is only a sum and a threshold, and the neck
// is what the sum does when two falloffs overlap.
//
// COMPACT SUPPORT, NOT AN EXPONENTIAL
// -----------------------------------
// The textbook falloff is Blinn's `exp(-b * r^2)`, which never reaches zero, so
// every ball influences every cell and the cost is cells x balls. Wyvill's
// polynomial `(1 - r^2/R^2)^3` is smooth to the second derivative, needs no
// transcendental, and is exactly zero past R. That last property changes the
// loop: instead of visiting every cell and summing every ball, each ball adds
// itself over its own bounding box, so the work is the sum of the ball areas.
//
// STATELESS IN TIME
// -----------------
// Positions are closed-form functions of the clock, so the field is a pure
// function of elapsed time - no accumulation, like the plasma and unlike the
// smoke, rain and fire. A frame can be drawn at any moment without having drawn
// the ones before it, which is what makes the reduced-motion path a single draw.
//
// Kept DOM-free so it can be unit-tested; the canvas and the loop live in
// metaballs-background.ts.

export interface MetaballParams {
  /** How many balls. */
  count: number;
  /** Mean ball radius, in units of the field's *height*. */
  radius: number;
  /** Spread on that, as a fraction either side. */
  radiusVariance: number;
  /** Peak field contribution of one ball at its centre. */
  strength: number;
  /**
   * Field value taken as the surface.
   *
   * Below it the field reads as outside, above as inside. Because
   * contributions add, two balls that individually fall short of this can
   * cross it together - which is exactly what makes them reach for each other.
   */
  iso: number;
  /**
   * Width of the gradient across the surface, in field units.
   *
   * The look dial. Narrow gives hard-edged classic metaballs, which at five
   * greys means flat silhouettes; wide gives soft shaded blobs whose rims land
   * on several palette levels and dither into a gradient. Wide by default,
   * because a page of body text sits on top of this.
   */
  shoulder: number;
  /** How fast the balls move. */
  speed: number;
  /** How far they wander from centre, as a fraction of the half-extent. */
  wander: number;

  /**
   * How close a press has to be to a ball's centre to take hold of it, in
   * field-height units. Beyond this, a press grabs nothing.
   */
  grabReach: number;
  /**
   * Seconds a grabbed ball takes to come to the pointer.
   *
   * Not zero: snapping it under the cursor the instant the button goes down
   * reads as a glitch rather than as picking something up.
   */
  grabEase: number;
  /** Seconds a released ball takes to settle back onto its path. */
  releaseEase: number;
  /**
   * How fast a thrown ball loses its speed, as a proportion per second.
   *
   * Without a throw at all, letting go of a ball mid-flick reads as it losing
   * momentum: the blend pulls it straight back towards its path and the
   * direction you were moving it counts for nothing.
   */
  throwDamping: number;
  /**
   * Ceiling on release speed, in field-height units per second.
   *
   * A hard flick can hand over a very large velocity, and without this the ball
   * leaves the screen before the blend has any chance to reel it in.
   */
  throwMaxSpeed: number;
}

export const METABALL_DEFAULTS: MetaballParams = {
  // Few and large rather than many and small. Merging is the effect, and balls
  // only merge if they are big enough relative to their spacing to meet.
  count: 7,
  radius: 0.26,
  radiusVariance: 0.4,
  strength: 1,
  iso: 0.55,
  // Wide - about two thirds of `iso` - so the rim crosses three palette levels
  // and reads as shading rather than as a cut-out.
  shoulder: 0.38,
  speed: 0.16,
  // Not 1: balls stay clear of the edges, so the field has somewhere to fall to
  // and the blobs read as floating rather than as clipped.
  wander: 0.72,
  // Generous - a bit more than the default radius - so a press near a blob takes
  // hold of it rather than missing by a few pixels.
  grabReach: 0.4,
  grabEase: 0.16,
  // Slower than the grab. Letting go should look like release, not retraction.
  releaseEase: 0.9,
  // Loses about two thirds of its speed in half a second, which is long enough
  // for the throw to read as a throw before the blend takes over.
  throwDamping: 2.4,
  throwMaxSpeed: 2.5,
};

/** One ball, positioned in field-height units. */
export interface Ball {
  x: number;
  y: number;
  radius: number;
  strength: number;
}

/**
 * Per-ball motion constants. Positions are Lissajous figures - a sine on each
 * axis - so a ball traces a smooth closed path rather than drifting or
 * random-walking. Incommensurable frequencies keep the set from falling into a
 * visible common period.
 */
export interface MetaballState {
  ax: number[];
  ay: number[];
  fx: number[];
  fy: number[];
  px: number[];
  py: number[];
  radii: number[];
}

export function randomizeMetaballs(rand: () => number = Math.random, params = METABALL_DEFAULTS): MetaballState {
  const state: MetaballState = { ax: [], ay: [], fx: [], fy: [], px: [], py: [], radii: [] };

  for (let i = 0; i < params.count; i++) {
    state.ax.push(0.55 + rand() * 0.45);
    state.ay.push(0.55 + rand() * 0.45);
    // Deliberately not round numbers or simple ratios, or the whole set would
    // return to its starting arrangement on a short, noticeable cycle.
    state.fx.push(0.61 + rand() * 0.83);
    state.fy.push(0.57 + rand() * 0.79);
    state.px.push(rand() * Math.PI * 2);
    state.py.push(rand() * Math.PI * 2);
    state.radii.push(params.radius * (1 - params.radiusVariance + rand() * params.radiusVariance * 2));
  }

  return state;
}

/**
 * Wyvill's falloff, given the squared distance and the radius.
 *
 * Zero at and beyond `radius`, one at the centre, and flat-tangent at both ends
 * so neighbouring balls blend without a crease. Written on the squared distance
 * so the caller never needs a square root.
 */
export function falloff(distanceSquared: number, radius: number): number {
  const r2 = radius * radius;
  if (distanceSquared >= r2) return 0;
  const t = 1 - distanceSquared / r2;
  return t * t * t;
}

/**
 * Where the balls are at `time`, in field-height units.
 *
 * `x` spans `0..aspect` and `y` spans `0..1`, so distances are isotropic and a
 * ball is round on any window. Working in plain 0..1 on both axes would stretch
 * every blob into an ellipse on a wide screen.
 */
export function ballsAt(
  time: number,
  aspect: number,
  params: MetaballParams,
  state: MetaballState,
  out: Ball[],
  override: BallOverride | null = null
): void {
  const t = time * params.speed;
  const halfX = aspect / 2;
  const halfY = 0.5;

  out.length = 0;
  for (let i = 0; i < state.radii.length; i++) {
    let x = halfX + Math.sin(t * state.fx[i] + state.px[i]) * state.ax[i] * halfX * params.wander;
    let y = halfY + Math.sin(t * state.fy[i] + state.py[i]) * state.ay[i] * halfY * params.wander;

    // Blended towards the held position rather than replaced by it - see
    // `BallOverride` for why the release depends on that.
    if (override && override.index === i && override.weight > 0) {
      const w = override.weight > 1 ? 1 : override.weight;
      x += (override.x - x) * w;
      y += (override.y - y) * w;
    }

    out.push({ x, y, radius: state.radii[i], strength: params.strength });
  }
}

/**
 * A ball displaced from its path, because it is being dragged or has just been
 * let go of.
 *
 * `weight` is what makes releasing work. A ball's natural position is a closed-
 * form function of the clock, so it does not stop moving while you hold it -
 * which means letting go cannot simply hand control back, or the ball would jump
 * from your cursor to wherever its orbit had got to. Easing `weight` from 1 to 0
 * instead blends from where you left it onto a target that is itself still
 * moving, and it arrives without a seam.
 */
export interface BallOverride {
  /** Which ball. Out-of-range indices are ignored. */
  index: number;
  /** Where it is held, in field-height units. */
  x: number;
  y: number;
  /** 1 for fully held, 0 for fully back on its path. */
  weight: number;
}

/**
 * A ball let go of mid-drag: where it is, and how fast it is still going.
 *
 * The velocity is what stops a release reading as the ball losing momentum. On
 * its own, easing the blend weight to zero pulls the ball straight back towards
 * its path, so a hard flick and a gentle placement look identical. Carrying the
 * drag's velocity means it coasts on in the direction it was thrown and *then*
 * curves back, which is what makes the tether feel elastic rather than sprung.
 */
export interface Throw {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * Starts a throw, clamping the handover speed.
 *
 * A hard flick can produce a velocity of many screen heights a second, and
 * unclamped the ball is off the edge before the blend has any chance to reel it
 * back. The direction survives the clamp; only the magnitude is capped.
 */
export function startThrow(x: number, y: number, vx: number, vy: number, params: MetaballParams): Throw {
  const speed = Math.hypot(vx, vy);
  if (speed > params.throwMaxSpeed && speed > 0) {
    const scale = params.throwMaxSpeed / speed;
    return { x, y, vx: vx * scale, vy: vy * scale };
  }
  return { x, y, vx, vy };
}

/**
 * Coasts a throw forward by `dt`, damping it and keeping it on screen.
 *
 * Damping is exponential rather than a flat subtraction, so it is frame-rate
 * independent: two half-steps leave the same speed as one whole one. Position is
 * held inside the field, so a ball flung at an edge slides along it instead of
 * disappearing and reappearing when the blend catches up.
 */
export function advanceThrow(state: Throw, params: MetaballParams, dt: number, aspect: number): void {
  const keep = Math.exp(-params.throwDamping * dt);
  state.vx *= keep;
  state.vy *= keep;

  state.x += state.vx * dt;
  state.y += state.vy * dt;

  state.x = state.x < 0 ? 0 : state.x > aspect ? aspect : state.x;
  state.y = state.y < 0 ? 0 : state.y > 1 ? 1 : state.y;
}

/**
 * The ball nearest a point, or -1 if none is within `grabReach`.
 *
 * Distances are in field-height units, the same space the balls live in, so this
 * is isotropic and a press does not favour the horizontal on a wide window.
 */
export function nearestBall(balls: readonly Ball[], x: number, y: number, reach: number): number {
  let best = -1;
  let bestDistance = reach * reach;

  for (let i = 0; i < balls.length; i++) {
    const dx = balls[i].x - x;
    const dy = balls[i].y - y;
    const squared = dx * dx + dy * dy;
    if (squared <= bestDistance) {
      bestDistance = squared;
      best = i;
    }
  }

  return best;
}

/** Raw field strength at a point, before the surface threshold. */
export function fieldAt(balls: Ball[], x: number, y: number): number {
  let total = 0;
  for (const ball of balls) {
    const dx = x - ball.x;
    const dy = y - ball.y;
    total += ball.strength * falloff(dx * dx + dy * dy, ball.radius);
  }
  return total;
}

/**
 * Maps raw field strength to 0..1 across the surface.
 *
 * A smoothstep rather than a hard step: it is flat-tangent at both ends, so the
 * rim shades into the interior without a visible band, and it is what lets the
 * dither do any work at all - a hard threshold would give a two-value field and
 * the palette would be wasted.
 */
export function surface(value: number, params: MetaballParams): number {
  const low = params.iso - params.shoulder;
  const high = params.iso + params.shoulder;
  if (high <= low) return value >= params.iso ? 1 : 0;

  const t = (value - low) / (high - low);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

export interface Metaballs {
  w: number;
  h: number;
  /** Surface value per cell, 0 to 1, row-major. This is what gets shaded. */
  field: Float32Array;
  /** Raw summed strength, before thresholding. Kept to avoid reallocating. */
  raw: Float32Array;
  balls: Ball[];
  state: MetaballState;
}

export function createMetaballs(
  w: number,
  h: number,
  rand: () => number = Math.random,
  params = METABALL_DEFAULTS
): Metaballs {
  return {
    w,
    h,
    field: new Float32Array(w * h),
    raw: new Float32Array(w * h),
    balls: [],
    state: randomizeMetaballs(rand, params),
  };
}

/**
 * Draws one frame.
 *
 * Two passes, and the split is what makes it cheap. The first scatters each
 * ball over its own bounding box - possible only because the falloff has
 * compact support - so the accumulation costs the sum of the ball areas rather
 * than cells times balls. The second thresholds, which is one smoothstep per
 * cell and unavoidable.
 */
export function renderMetaballs(
  metaballs: Metaballs,
  params: MetaballParams,
  time: number,
  override: BallOverride | null = null
): void {
  const { w, h, field, raw, balls, state } = metaballs;
  const aspect = h > 0 ? w / h : 1;

  ballsAt(time, aspect, params, state, balls, override);
  raw.fill(0);

  const spanX = w > 1 ? aspect / (w - 1) : 0;
  const spanY = h > 1 ? 1 / (h - 1) : 0;

  for (const ball of balls) {
    // Only the cells this ball can possibly reach.
    const i0 = spanX > 0 ? Math.max(0, Math.ceil((ball.x - ball.radius) / spanX)) : 0;
    const i1 = spanX > 0 ? Math.min(w - 1, Math.floor((ball.x + ball.radius) / spanX)) : w - 1;
    const j0 = spanY > 0 ? Math.max(0, Math.ceil((ball.y - ball.radius) / spanY)) : 0;
    const j1 = spanY > 0 ? Math.min(h - 1, Math.floor((ball.y + ball.radius) / spanY)) : h - 1;

    for (let j = j0; j <= j1; j++) {
      const dy = j * spanY - ball.y;
      const dy2 = dy * dy;
      const row = j * w;

      for (let i = i0; i <= i1; i++) {
        const dx = i * spanX - ball.x;
        raw[row + i] += ball.strength * falloff(dx * dx + dy2, ball.radius);
      }
    }
  }

  for (let k = 0; k < field.length; k++) field[k] = surface(raw[k], params);
}

/** Fraction of the field inside the surface. Exported for tuning and tests. */
export function coverage(metaballs: Metaballs, threshold = 0.5): number {
  let inside = 0;
  for (const v of metaballs.field) if (v >= threshold) inside++;
  return inside / metaballs.field.length;
}
