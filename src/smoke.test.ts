import { describe, expect, it } from 'vitest';

import { fbm, makeRandom } from './noise';
import {
  SMOKE_DEFAULTS,
  advect,
  applyBuoyancy,
  applyVorticityConfinement,
  computeDivergence,
  computeSource,
  applyJet,
  applyStroke,
  createFluid,
  meanAbsDivergence,
  nextJetDelay,
  planJet,
  randomizeSmoke,
  sampleWrapped,
  solvePressure,
  stepFluid,
  subtractPressureGradient,
} from './smoke';

const seeded = () => randomizeSmoke(makeRandom(4242));

const W = 32;
const H = 24;

/** A fluid with a messy, very divergent velocity field. */
function stirred(w = W, h = H) {
  const fluid = createFluid(w, h);
  const rand = makeRandom(11);
  for (let k = 0; k < fluid.u.length; k++) {
    fluid.u[k] = rand() * 2 - 1;
    fluid.v[k] = rand() * 2 - 1;
  }
  return fluid;
}

const sourceOf = (time = 0, w = W, h = H) => {
  const out = new Float32Array(w * h);
  computeSource(time, SMOKE_DEFAULTS, seeded(), out, w, h);
  return out;
};

describe('createFluid', () => {
  it('wraps the neighbour tables at every edge', () => {
    // These tables replace a modulo in six inner loops; if they are wrong the
    // fluid leaks at the edges in ways that are hard to see and easy to blame
    // on the physics.
    const f = createFluid(4, 3);

    expect(f.left[0]).toBe(3); // first column wraps to last
    expect(f.right[3]).toBe(0); // last column wraps to first
    expect(f.up[0]).toBe(8); // first row wraps to last
    expect(f.down[8]).toBe(0); // last row wraps to first

    // And an interior cell is just its neighbours.
    const k = 1 * 4 + 1;
    expect(f.left[k]).toBe(k - 1);
    expect(f.right[k]).toBe(k + 1);
    expect(f.up[k]).toBe(k - 4);
    expect(f.down[k]).toBe(k + 4);
  });

  it('every index stays inside the grid', () => {
    const f = createFluid(7, 5);
    for (const table of [f.left, f.right, f.up, f.down]) {
      for (const index of table) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(35);
      }
    }
  });
});

describe('sampleWrapped', () => {
  const w = 4;
  const h = 3;
  const field = new Float32Array([0, 1, 2, 3, 10, 11, 12, 13, 20, 21, 22, 23]);

  it('returns cell values exactly at integer coordinates', () => {
    expect(sampleWrapped(field, w, h, 0, 0)).toBe(0);
    expect(sampleWrapped(field, w, h, 2, 1)).toBe(12);
  });

  it('interpolates between neighbours', () => {
    expect(sampleWrapped(field, w, h, 0.5, 0)).toBeCloseTo(0.5, 6);
    expect(sampleWrapped(field, w, h, 0, 0.5)).toBeCloseTo(5, 6);
  });

  it('wraps past the far edge back to the near one', () => {
    expect(sampleWrapped(field, w, h, 3.5, 0)).toBeCloseTo(1.5, 6);
    expect(sampleWrapped(field, w, h, 4, 0)).toBe(0);
  });

  it('wraps negative coordinates - the case a bare % gets wrong', () => {
    expect(sampleWrapped(field, w, h, -1, 0)).toBe(3);
    expect(sampleWrapped(field, w, h, -9.5, -6.5)).toBeCloseTo(sampleWrapped(field, w, h, 2.5, 2.5), 6);
  });

  it('never reads outside the buffer, however far a back-trace wanders', () => {
    for (let x = -60; x < 60; x += 0.37) {
      for (let y = -40; y < 40; y += 0.53) {
        expect(Number.isFinite(sampleWrapped(field, w, h, x, y))).toBe(true);
      }
    }
  });
});

describe('advect', () => {
  it('leaves the field alone when nothing is moving', () => {
    const f = createFluid(W, H);
    const src = sourceOf(1);
    const dst = new Float32Array(W * H);

    advect(src, dst, f.u, f.v, W, H, 1 / 24);
    for (let k = 0; k < src.length; k++) expect(dst[k]).toBeCloseTo(src[k], 6);
  });

  it('shifts the field by exactly one cell for a unit velocity', () => {
    const f = createFluid(W, H);
    f.u.fill(1);
    const src = sourceOf(1);
    const dst = new Float32Array(W * H);

    advect(src, dst, f.u, f.v, W, H, 1);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        // Traced back one cell to the left, wrapping.
        expect(dst[j * W + i]).toBeCloseTo(src[j * W + ((i - 1 + W) % W)], 5);
      }
    }
  });

  it('cannot push a field outside the range it started in', () => {
    // Every output is a bilinear blend of four inputs, so advection is a convex
    // combination and needs no clamping anywhere downstream.
    const f = stirred();
    const src = sourceOf(1);
    const dst = new Float32Array(W * H);

    advect(src, dst, f.u, f.v, W, H, 3);
    for (const value of dst) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('the pressure projection', () => {
  it('removes almost all the divergence - this is what makes it a fluid', () => {
    // Advection alone lets the field compress and density pile up. The
    // projection solves for the pressure whose gradient cancels the divergence
    // and subtracts it. If this stops working the smoke becomes a stretched
    // texture, so it is worth asserting hard.
    const fluid = stirred();
    const before = meanAbsDivergence(fluid);
    expect(before).toBeGreaterThan(0.1);

    computeDivergence(fluid);
    solvePressure(fluid, 60);
    subtractPressureGradient(fluid);

    expect(meanAbsDivergence(fluid)).toBeLessThan(before * 0.1);
  });

  it('gets closer with more iterations', () => {
    const remaining = (iterations: number) => {
      const fluid = stirred();
      computeDivergence(fluid);
      solvePressure(fluid, iterations);
      subtractPressureGradient(fluid);
      return meanAbsDivergence(fluid);
    };

    expect(remaining(24)).toBeLessThan(remaining(4));
    expect(remaining(80)).toBeLessThan(remaining(24));
  });

  it('leaves an already divergence-free field alone', () => {
    // Uniform flow has no divergence, so there is nothing to correct and the
    // projection must not invent a correction.
    const fluid = createFluid(W, H);
    fluid.u.fill(0.7);
    fluid.v.fill(-0.3);

    computeDivergence(fluid);
    solvePressure(fluid, 30);
    subtractPressureGradient(fluid);

    for (let k = 0; k < fluid.u.length; k++) {
      expect(fluid.u[k]).toBeCloseTo(0.7, 5);
      expect(fluid.v[k]).toBeCloseTo(-0.3, 5);
    }
  });

  it('produces finite pressure everywhere', () => {
    const fluid = stirred();
    computeDivergence(fluid);
    solvePressure(fluid, 40);
    for (const value of fluid.pressure) expect(Number.isFinite(value)).toBe(true);
  });
});

describe('applyBuoyancy', () => {
  it('lifts dense cells and lets clear ones sink', () => {
    const fluid = createFluid(4, 4);
    fluid.density.fill(0.5);
    fluid.density[5] = 1;
    fluid.density[6] = 0;

    applyBuoyancy(fluid, 10, 1 / 24);

    // Negative v is up on a canvas.
    expect(fluid.v[5]).toBeLessThan(0);
    expect(fluid.v[6]).toBeGreaterThan(0);
  });

  it('adds no net push, so a wrapping grid does not simply scroll', () => {
    const fluid = createFluid(W, H);
    fluid.density.set(sourceOf(1));
    applyBuoyancy(fluid, 10, 1 / 24);

    let total = 0;
    for (const value of fluid.v) total += value;
    expect(Math.abs(total / fluid.v.length)).toBeLessThan(1e-6);
  });

  it('does nothing to a uniformly dense field', () => {
    const fluid = createFluid(8, 8);
    fluid.density.fill(0.4);
    applyBuoyancy(fluid, 10, 1);
    for (const value of fluid.v) expect(value).toBeCloseTo(0, 6);
  });
});

describe('applyVorticityConfinement', () => {
  it('sharpens the swirl rather than smoothing it', () => {
    // The solver is diffusive and eats small eddies; this is what puts them
    // back. Total curl should go up, not down.
    const fluid = stirred();
    const totalCurl = () => {
      applyVorticityConfinement(fluid, 0, 0); // fills curl without forcing
      let total = 0;
      for (const value of fluid.curl) total += Math.abs(value);
      return total;
    };

    const before = totalCurl();
    applyVorticityConfinement(fluid, 20, 1 / 24);
    expect(totalCurl()).toBeGreaterThan(before);
  });

  it('does nothing at zero strength', () => {
    const fluid = stirred();
    const u = Float32Array.from(fluid.u);
    applyVorticityConfinement(fluid, 0, 1 / 24);
    for (let k = 0; k < u.length; k++) expect(fluid.u[k]).toBeCloseTo(u[k], 6);
  });

  it('leaves a curl-free field alone', () => {
    const fluid = createFluid(8, 8);
    fluid.u.fill(0.5);
    applyVorticityConfinement(fluid, 20, 1 / 24);
    for (const value of fluid.u) expect(value).toBeCloseTo(0.5, 6);
  });
});

describe('computeSource', () => {
  it('stays inside 0..1', () => {
    for (const v of sourceOf(4)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('is shaped into denser and clearer regions than the noise it came from', () => {
    // A smooth source has no edges for the flow to stretch, and stretching
    // nothing gives fog. Asserted against the raw noise rather than an absolute
    // fraction, so retuning the smoothstep band does not invalidate it.
    const state = seeded();
    const { sourceScale, octaves } = SMOKE_DEFAULTS;
    const time = 2;
    const dx = state.drift[0] * time;
    const dy = state.drift[1] * time;

    const raw = new Float32Array(W * H);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        raw[j * W + i] = fbm(
          (i / W) * sourceScale + dx + state.offsets[2],
          (j / H) * sourceScale + dy + state.offsets[0],
          state.seeds[2],
          octaves
        );
      }
    }

    const extreme = (f: Float32Array) => Array.from(f).filter((v) => v < 0.12 || v > 0.88).length / f.length;
    expect(extreme(sourceOf(time))).toBeGreaterThan(extreme(raw) * 2);
  });

  it('drifts over time, and is deterministic', () => {
    expect(Array.from(sourceOf(0))).not.toEqual(Array.from(sourceOf(40)));
    expect(Array.from(sourceOf(7))).toEqual(Array.from(sourceOf(7)));
  });
});

describe('stepFluid', () => {
  const settle = (steps: number, w = 48, h = 32) => {
    const fluid = createFluid(w, h);
    const state = seeded();
    computeSource(0, SMOKE_DEFAULTS, state, fluid.source, w, h);
    fluid.density.set(fluid.source);

    let time = 0;
    for (let i = 0; i < steps; i++) {
      time += 1 / 24;
      stepFluid(fluid, SMOKE_DEFAULTS, state, time, 1 / 24);
    }
    return fluid;
  };

  it('keeps density inside 0..1 without clamping', () => {
    const fluid = settle(300);
    for (const value of fluid.density) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('stays finite - a fluid solver that diverges takes the page with it', () => {
    const fluid = settle(600);
    for (const value of fluid.u) expect(Number.isFinite(value)).toBe(true);
    for (const value of fluid.v) expect(Number.isFinite(value)).toBe(true);
    for (const value of fluid.density) expect(Number.isFinite(value)).toBe(true);
  });

  it('holds the velocity to a sane magnitude rather than winding up', () => {
    // Buoyancy and stirring add energy every frame; drag is what takes it away.
    // If that balance is wrong this grows without bound, slowly enough not to
    // be noticed until the smoke is a blur.
    const fluid = settle(600);
    let peak = 0;
    for (let k = 0; k < fluid.u.length; k++) {
      peak = Math.max(peak, Math.abs(fluid.u[k]), Math.abs(fluid.v[k]));
    }
    // Ambient only - jets deliberately drive far harder than this, and are
    // covered by their own stability test.
    expect(peak).toBeLessThan(60);
  });

  it('keeps the flow near divergence-free while it runs', () => {
    // Relative to the speed of the flow, which is the only way the number means
    // anything - a fast fluid has a larger absolute residual at the same
    // quality. At the default iteration count this sits around 6%; eight
    // iterations gives 10% and sixty gives 2%.
    const fluid = settle(300);
    let speed = 0;
    for (let k = 0; k < fluid.u.length; k++) speed += Math.hypot(fluid.u[k], fluid.v[k]);
    speed /= fluid.u.length;

    expect(speed).toBeGreaterThan(0.5);
    expect(meanAbsDivergence(fluid) / speed).toBeLessThan(0.12);
  });

  it('is deterministic', () => {
    expect(Array.from(settle(40).density)).toEqual(Array.from(settle(40).density));
  });

  it('settles to smoke rather than to fog or to a flat field', () => {
    const values = Array.from(settle(400).density);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const spread = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);

    // Collapsed-to-fog would be well under 0.03.
    expect(spread).toBeGreaterThan(0.08);
    // And it should be smoke in air, not a uniform haze at either extreme.
    expect(mean).toBeGreaterThan(0.15);
    expect(mean).toBeLessThan(0.6);
  });

  it('actually moves the smoke around', () => {
    const early = Array.from(settle(30).density);
    const late = Array.from(settle(200).density);
    let moved = 0;
    for (let k = 0; k < early.length; k++) moved += Math.abs(early[k] - late[k]);
    expect(moved / early.length).toBeGreaterThan(0.05);
  });
});

describe('randomizeSmoke', () => {
  it('is reproducible when given a seeded generator', () => {
    expect(randomizeSmoke(makeRandom(9))).toEqual(randomizeSmoke(makeRandom(9)));
  });

  it('gives the noise fields different seeds and drifts either way', () => {
    const directions = new Set<number>();
    for (let seed = 1; seed < 30; seed++) {
      const state = randomizeSmoke(makeRandom(seed));
      expect(new Set(state.seeds).size).toBe(4);
      for (const d of state.drift) {
        expect(Math.abs(d)).toBeGreaterThan(0);
        expect(Math.abs(d)).toBeLessThan(0.04);
        directions.add(Math.sign(d));
      }
    }
    expect(directions).toEqual(new Set([-1, 1]));
  });
});

describe('planJet', () => {
  const params = SMOKE_DEFAULTS;

  it('is pure given the generator', () => {
    expect(planJet(60, 40, makeRandom(5), params)).toEqual(planJet(60, 40, makeRandom(5), params));
  });

  it('starts on an edge and fires inward', () => {
    for (let seed = 1; seed < 200; seed++) {
      const jet = planJet(60, 40, makeRandom(seed), params);

      const onTop = jet.y === 0;
      const onBottom = jet.y === 40;
      const onLeft = jet.x === 0;
      const onRight = jet.x === 60;
      expect(onTop || onBottom || onLeft || onRight).toBe(true);

      if (onTop) expect(jet.dirY).toBeGreaterThan(0);
      if (onBottom) expect(jet.dirY).toBeLessThan(0);
      if (onLeft) expect(jet.dirX).toBeGreaterThan(0);
      if (onRight) expect(jet.dirX).toBeLessThan(0);
    }
  });

  it('aims with a unit direction, so speed means what it says', () => {
    for (let seed = 1; seed < 100; seed++) {
      const jet = planJet(60, 40, makeRandom(seed), params);
      expect(Math.hypot(jet.dirX, jet.dirY)).toBeCloseTo(1, 6);
    }
  });

  it('uses all four edges', () => {
    const edges = new Set<string>();
    for (let seed = 1; seed < 400; seed++) {
      const jet = planJet(60, 40, makeRandom(seed), params);
      edges.add(jet.y === 0 ? 'top' : jet.y === 40 ? 'bottom' : jet.x === 0 ? 'left' : 'right');
    }
    expect(edges.size).toBe(4);
  });

  it('fires both pale and dark jets, in roughly the configured mix', () => {
    // A dark jet carries no smoke and carves a clear channel instead of
    // painting a bright one. Same momentum, opposite cargo.
    let dark = 0;
    const total = 600;
    for (let seed = 1; seed <= total; seed++) {
      if (planJet(60, 40, makeRandom(seed), params).density < 0.5) dark++;
    }
    const share = dark / total;
    expect(share).toBeGreaterThan(params.jetDarkChance - 0.12);
    expect(share).toBeLessThan(params.jetDarkChance + 0.12);
  });

  it('varies in size, speed and duration, and stays sane', () => {
    const radii = new Set<number>();
    for (let seed = 1; seed < 80; seed++) {
      const jet = planJet(60, 40, makeRandom(seed), params);
      expect(jet.radius).toBeGreaterThan(1);
      expect(jet.radius).toBeLessThan(20);
      expect(jet.speed).toBeGreaterThan(0);
      expect(jet.duration).toBeGreaterThan(0);
      expect(jet.duration).toBeLessThan(5);
      radii.add(jet.radius);
    }
    expect(radii.size).toBeGreaterThan(60);
  });
});

describe('nextJetDelay', () => {
  it('stays between half and one and a half times the mean', () => {
    for (let seed = 1; seed < 200; seed++) {
      const delay = nextJetDelay(makeRandom(seed), SMOKE_DEFAULTS);
      expect(delay).toBeGreaterThanOrEqual(SMOKE_DEFAULTS.jetInterval * 0.5);
      expect(delay).toBeLessThanOrEqual(SMOKE_DEFAULTS.jetInterval * 1.5);
    }
  });

  it('is never zero, so jets cannot pile up in one frame', () => {
    for (let seed = 1; seed < 200; seed++) {
      expect(nextJetDelay(makeRandom(seed), SMOKE_DEFAULTS)).toBeGreaterThan(0);
    }
  });
});

describe('applyJet', () => {
  const jet = { x: 20, y: 12, dirX: 1, dirY: 0, radius: 6, speed: 80, density: 1, duration: 1.5 };

  it('drives the fluid towards the jet velocity at the nozzle', () => {
    const fluid = createFluid(W, H);
    for (let i = 0; i < 30; i++) applyJet(fluid, jet, 1 / 24);

    expect(fluid.u[12 * W + 20]).toBeCloseTo(80, 0);
    expect(fluid.v[12 * W + 20]).toBeCloseTo(0, 4);
  });

  it('drives rather than adds, so it cannot run away', () => {
    // Adding would make the jet's strength depend on how long it had been
    // running and on the frame rate. Driving holds a fixed speed.
    const fluid = createFluid(W, H);
    for (let i = 0; i < 500; i++) applyJet(fluid, jet, 1 / 24);

    for (const value of fluid.u) expect(Math.abs(value)).toBeLessThanOrEqual(80.001);
    for (const value of fluid.density) expect(value).toBeLessThanOrEqual(1.0001);
  });

  it('tapers across the nozzle rather than stamping a disc', () => {
    const fluid = createFluid(W, H);
    for (let i = 0; i < 10; i++) applyJet(fluid, jet, 1 / 24);

    const centre = fluid.u[12 * W + 20];
    const middle = fluid.u[12 * W + 23];
    const rim = fluid.u[12 * W + 25];
    expect(middle).toBeLessThan(centre);
    expect(rim).toBeLessThan(middle);
  });

  it('touches nothing outside the nozzle', () => {
    const fluid = createFluid(W, H);
    applyJet(fluid, jet, 1 / 24);
    expect(fluid.u[12 * W + 2]).toBe(0);
    expect(fluid.u[0 * W + 20]).toBe(0);
  });

  it('wraps around the edges instead of being clipped by them', () => {
    // Jets are planned on an edge, so half the nozzle is on the far side.
    const fluid = createFluid(W, H);
    for (let i = 0; i < 10; i++) applyJet(fluid, { ...jet, x: 0, y: 0 }, 1 / 24);

    expect(fluid.u[0]).toBeGreaterThan(1);
    expect(fluid.u[(H - 1) * W + (W - 1)]).toBeGreaterThan(0);
  });

  it('a dark jet clears a channel rather than painting one', () => {
    // The mirror of the pale case: drive the nozzle with no smoke in it and the
    // density along its path should drop well below the field it crossed.
    const fluid = createFluid(48, 32);
    const state = seeded();
    fluid.density.fill(0.6);
    computeSource(0, SMOKE_DEFAULTS, state, fluid.source, 48, 32);

    const darkJet = { ...jet, x: 0, y: 16, radius: 5, density: 0 };
    let time = 0;
    for (let i = 0; i < 40; i++) {
      time += 1 / 24;
      applyJet(fluid, darkJet, 1 / 24);
      stepFluid(fluid, SMOKE_DEFAULTS, state, time, 1 / 24);
    }

    // Along the path it fired down, near the nozzle.
    let along = 0;
    let count = 0;
    for (let i = 1; i < 12; i++) {
      along += fluid.density[16 * 48 + i];
      count++;
    }
    expect(along / count).toBeLessThan(0.4);
  });

  it('opens a hole - the distortion is the point, not the smoke it carries', () => {
    // Fire across a uniformly dense field and the density downstream should be
    // visibly rearranged, not merely brightened at the nozzle.
    const fluid = createFluid(48, 32);
    const state = seeded();
    fluid.density.fill(0.5);
    computeSource(0, SMOKE_DEFAULTS, state, fluid.source, 48, 32);

    const crossing = { ...jet, x: 0, y: 16, radius: 5 };
    let time = 0;
    for (let i = 0; i < 60; i++) {
      time += 1 / 24;
      applyJet(fluid, crossing, 1 / 24);
      stepFluid(fluid, SMOKE_DEFAULTS, state, time, 1 / 24);
    }

    // Somewhere well downstream of the nozzle the field is no longer uniform.
    let spread = 0;
    let count = 0;
    for (let j = 8; j < 24; j++) {
      for (let i = 15; i < 35; i++) {
        spread += Math.abs(fluid.density[j * 48 + i] - 0.5);
        count++;
      }
    }
    expect(spread / count).toBeGreaterThan(0.05);
  });

  it('leaves the solver stable through repeated jets', () => {
    const fluid = createFluid(48, 32);
    const state = seeded();
    computeSource(0, SMOKE_DEFAULTS, state, fluid.source, 48, 32);
    fluid.density.set(fluid.source);

    let time = 0;
    for (let i = 0; i < 400; i++) {
      time += 1 / 24;
      if (i % 60 < 30) applyJet(fluid, planJet(48, 32, makeRandom(Math.floor(i / 60) + 1), SMOKE_DEFAULTS), 1 / 24);
      stepFluid(fluid, SMOKE_DEFAULTS, state, time, 1 / 24);
    }

    for (const value of fluid.density) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    for (const value of fluid.u) expect(Number.isFinite(value)).toBe(true);
  });
});

describe('applyStroke', () => {
  const at = (fluid: ReturnType<typeof createFluid>, x: number, y: number) => fluid.u[y * fluid.w + x];

  it('pushes the fluid the way the cursor moved', () => {
    const fluid = createFluid(W, H);
    applyStroke(fluid, { x: 16, y: 12, dx: 2, dy: 0 }, SMOKE_DEFAULTS, 1 / 24);

    expect(at(fluid, 16, 12)).toBeGreaterThan(0);
    expect(fluid.v[12 * W + 16]).toBeCloseTo(0, 6);

    const back = createFluid(W, H);
    applyStroke(back, { x: 16, y: 12, dx: -2, dy: 0 }, SMOKE_DEFAULTS, 1 / 24);
    expect(at(back, 16, 12)).toBeLessThan(0);
  });

  it('adds rather than drives, so a drag is an impulse and not a boundary', () => {
    // The jet nozzle drives towards a fixed speed; a cursor should not. Two
    // strokes in the same place must push harder than one.
    const fluid = createFluid(W, H);
    applyStroke(fluid, { x: 16, y: 12, dx: 1, dy: 0 }, SMOKE_DEFAULTS, 1 / 24);
    const once = at(fluid, 16, 12);
    applyStroke(fluid, { x: 16, y: 12, dx: 1, dy: 0 }, SMOKE_DEFAULTS, 1 / 24);
    expect(at(fluid, 16, 12)).toBeCloseTo(once * 2, 4);
  });

  it('caps a flick, so it stays emphatic rather than destructive', () => {
    const fluid = createFluid(W, H);
    applyStroke(fluid, { x: 16, y: 12, dx: 5000, dy: 0 }, SMOKE_DEFAULTS, 1 / 24);
    expect(at(fluid, 16, 12)).toBeLessThanOrEqual(SMOKE_DEFAULTS.strokeMaxSpeed + 0.001);
  });

  it('tapers to nothing at the rim and touches nothing beyond it', () => {
    const fluid = createFluid(W, H);
    applyStroke(fluid, { x: 16, y: 12, dx: 2, dy: 0 }, SMOKE_DEFAULTS, 1 / 24);

    const centre = at(fluid, 16, 12);
    const out = at(fluid, 18, 12);
    expect(out).toBeLessThan(centre);
    expect(out).toBeGreaterThan(0);
    // Well outside the radius.
    expect(at(fluid, 16 + Math.ceil(SMOKE_DEFAULTS.strokeRadius * Math.min(W, H)) + 2, 12)).toBe(0);
  });

  it('does nothing when the cursor has not moved', () => {
    const fluid = createFluid(W, H);
    applyStroke(fluid, { x: 16, y: 12, dx: 0, dy: 0 }, SMOKE_DEFAULTS, 1 / 24);
    for (const value of fluid.u) expect(value).toBe(0);
    for (const value of fluid.v) expect(value).toBe(0);
  });

  it('wraps at the edges rather than being clipped by them', () => {
    const fluid = createFluid(W, H);
    applyStroke(fluid, { x: 0, y: 0, dx: 2, dy: 0 }, SMOKE_DEFAULTS, 1 / 24);
    expect(at(fluid, 0, 0)).toBeGreaterThan(0);
    expect(at(fluid, W - 1, H - 1)).toBeGreaterThan(0);
  });

  it('leaves the solver stable under sustained scribbling', () => {
    const fluid = createFluid(48, 32);
    const state = seeded();
    computeSource(0, SMOKE_DEFAULTS, state, fluid.source, 48, 32);
    fluid.density.set(fluid.source);

    let time = 0;
    for (let i = 0; i < 300; i++) {
      time += 1 / 24;
      // A cursor being dragged about hard, several events per frame.
      for (let k = 0; k < 4; k++) {
        applyStroke(
          fluid,
          { x: (i * 7 + k * 3) % 48, y: (i * 5 + k) % 32, dx: Math.sin(i + k) * 6, dy: Math.cos(i * 2 + k) * 6 },
          SMOKE_DEFAULTS,
          1 / 24
        );
      }
      stepFluid(fluid, SMOKE_DEFAULTS, state, time, 1 / 24);
    }

    for (const value of fluid.density) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    for (const value of fluid.u) expect(Number.isFinite(value)).toBe(true);
  });
});
