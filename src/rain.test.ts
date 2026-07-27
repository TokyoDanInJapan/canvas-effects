import { describe, expect, it } from 'vitest';

import { makeRandom } from './noise.js';
import {
  RAIN_DEFAULTS,
  createRain,
  distortField,
  meanBrightness,
  rollLane,
  stepRain,
  type Distortion,
  type Rain,
  type RainLane,
} from './rain.js';

const W = 40;
const H = 30;
const DT = 1 / 24;

const seeded = (seed = 99) => createRain(W, H, makeRandom(seed), RAIN_DEFAULTS);

/** Runs the simulation forward, with its own seeded generator. */
function run(rain: Rain, steps: number, seed = 7, params = RAIN_DEFAULTS) {
  const rand = makeRandom(seed);
  for (let i = 0; i < steps; i++) stepRain(rain, params, rand, DT);
  return rain;
}

/** An empty field with a single lane falling down column `x`. */
function oneLane(x: number, over: Partial<RainLane> = {}): Rain {
  const rain = createRain(W, H, makeRandom(1), RAIN_DEFAULTS);
  for (const lane of rain.lanes) {
    lane.falling = false;
    lane.delay = Infinity;
  }
  rain.field.fill(0);
  Object.assign(rain.lanes[x], { y: 0, speed: 20, brightness: 1, delay: 0, falling: true, ...over });
  return rain;
}

const column = (rain: Rain, x: number) => Array.from({ length: rain.h }, (_, y) => rain.field[y * rain.w + x]);

describe('createRain', () => {
  it('gives every column a lane', () => {
    const rain = seeded();
    expect(rain.lanes).toHaveLength(W);
    expect(rain.field).toHaveLength(W * H);
  });

  it('is reproducible when given a seeded generator', () => {
    expect(createRain(W, H, makeRandom(5))).toEqual(createRain(W, H, makeRandom(5)));
  });

  it('opens mid-storm rather than as one tidy row at the top', () => {
    // The naive initialisation - every lane at y=0 - sweeps down the page as a
    // single line on the first second, and looks obviously wrong.
    const falling = seeded().lanes.filter((l) => l.falling);
    expect(falling.length).toBeGreaterThan(5);

    const heights = new Set(falling.map((l) => Math.floor(l.y / 4)));
    expect(heights.size).toBeGreaterThan(3);
  });

  it('leaves some lanes waiting, so the screen is not solid rain', () => {
    const idle = seeded().lanes.filter((l) => !l.falling);
    expect(idle.length).toBeGreaterThan(3);
  });
});

describe('rollLane', () => {
  const rolled = (seed: number) => {
    const lane: RainLane = { y: 0, speed: 0, brightness: 0, delay: 0, falling: false };
    rollLane(lane, makeRandom(seed), RAIN_DEFAULTS);
    return lane;
  };

  it('starts the head above the top edge, so drops enter rather than appear', () => {
    for (let seed = 1; seed < 40; seed++) expect(rolled(seed).y).toBeLessThan(0);
  });

  it('always falls downwards', () => {
    for (let seed = 1; seed < 40; seed++) expect(rolled(seed).speed).toBeGreaterThan(0);
  });

  it('keeps brightness inside the palette range', () => {
    for (let seed = 1; seed < 60; seed++) {
      const { brightness } = rolled(seed);
      expect(brightness).toBeGreaterThan(0);
      expect(brightness).toBeLessThanOrEqual(1);
    }
  });

  it('varies speed between drops, so the screen has no single rhythm', () => {
    const speeds = new Set(Array.from({ length: 30 }, (_, i) => Math.round(rolled(i + 1).speed)));
    expect(speeds.size).toBeGreaterThan(10);
  });

  it('sometimes rolls a bold drop, faster than any ordinary one', () => {
    const speeds = Array.from({ length: 120 }, (_, i) => rolled(i + 1).speed);
    const ordinaryMax = RAIN_DEFAULTS.speed * (1 + RAIN_DEFAULTS.speedVariance);
    expect(speeds.some((s) => s > ordinaryMax)).toBe(true);
  });
});

describe('stepRain', () => {
  it('moves heads downwards', () => {
    const rain = oneLane(3);
    const before = rain.lanes[3].y;
    run(rain, 5);
    expect(rain.lanes[3].y).toBeGreaterThan(before);
  });

  it('lights the cells the head passes through', () => {
    const rain = oneLane(3);
    run(rain, 10);
    expect(column(rain, 3).some((v) => v > 0.1)).toBe(true);
  });

  it('leaves other columns alone - lanes are independent', () => {
    const rain = oneLane(3);
    run(rain, 10);
    for (let x = 0; x < W; x++) {
      if (x === 3) continue;
      expect(column(rain, x).every((v) => v === 0)).toBe(true);
    }
  });

  it('leaves a trail that fades behind the head, brightest at the front', () => {
    const rain = oneLane(0, { speed: 30, brightness: 1 });
    // No flicker, so the gradient is the decay rather than the jitter.
    run(rain, 12, 3, { ...RAIN_DEFAULTS, flicker: 0 });

    const head = Math.floor(rain.lanes[0].y);
    const lit = column(rain, 0);

    // Walking back from the head, brightness only ever decreases.
    let previous = Infinity;
    for (let y = Math.min(head, H - 1); y >= 0; y--) {
      if (lit[y] === 0) break;
      expect(lit[y]).toBeLessThanOrEqual(previous + 1e-6);
      previous = lit[y];
    }
    expect(previous).toBeLessThan(1);
  });

  it('draws a continuous streak even when the head crosses several cells a frame', () => {
    // A bold drop covers two to three cells per frame at 24fps. Depositing only
    // at the head's landing cell would leave a dotted line.
    const rain = oneLane(0, { speed: 90, brightness: 1 });
    run(rain, 4, 3, { ...RAIN_DEFAULTS, flicker: 0, fade: 0 });

    const lit = column(rain, 0);
    const head = Math.min(Math.floor(rain.lanes[0].y), H - 1);
    for (let y = 0; y <= head; y++) expect(lit[y]).toBeGreaterThan(0);
  });

  it('keeps the field inside 0..1, which is what the shader assumes', () => {
    const rain = seeded();
    run(rain, 400);
    for (const value of rain.field) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('retires a head at the bottom and leaves its trail to fade in place', () => {
    const rain = oneLane(0, { y: H - 2, speed: 40, brightness: 1 });
    run(rain, 3, 3, { ...RAIN_DEFAULTS, flicker: 0 });

    expect(rain.lanes[0].falling).toBe(false);
    expect(rain.lanes[0].delay).toBeGreaterThan(0);
    // The trail did not vanish with the head.
    expect(column(rain, 0).some((v) => v > 0)).toBe(true);
  });

  it('brings a retired lane back after its delay', () => {
    const rain = oneLane(0, { y: H - 1, speed: 40, brightness: 1 });
    run(rain, 2);
    expect(rain.lanes[0].falling).toBe(false);

    // Sampled every step rather than once at the end: a lane can respawn, fall
    // the height of this test field in under a second, and retire again well
    // inside the longest respawn delay - so a single check at a fixed time
    // reads "waiting" whether or not it ever came back.
    const rand = makeRandom(7);
    const budget = Math.ceil((RAIN_DEFAULTS.respawn * 1.6 + 1) / DT);
    let revived = false;
    for (let i = 0; i < budget && !revived; i++) {
      stepRain(rain, RAIN_DEFAULTS, rand, DT);
      revived = rain.lanes[0].falling;
    }
    expect(revived).toBe(true);
  });

  describe('the fade', () => {
    it('is frame-rate independent - the same second costs the same brightness', () => {
      const coarse = oneLane(0, { speed: 0, brightness: 1 });
      const fine = oneLane(0, { speed: 0, brightness: 1 });
      const still = { ...RAIN_DEFAULTS, flicker: 0 };

      // One second, at two different step sizes.
      const a = makeRandom(1);
      for (let i = 0; i < 24; i++) stepRain(coarse, still, a, 1 / 24);
      const b = makeRandom(1);
      for (let i = 0; i < 96; i++) stepRain(fine, still, b, 1 / 96);

      // A linear `1 - fade * dt` fade would leave these visibly apart; the
      // exponential one agrees to three places.
      expect(meanBrightness(coarse)).toBeCloseTo(meanBrightness(fine), 3);
    });

    it('empties the field once the rain stops', () => {
      const rain = seeded();
      run(rain, 60);
      expect(meanBrightness(rain)).toBeGreaterThan(0);

      for (const lane of rain.lanes) {
        lane.falling = false;
        lane.delay = Infinity;
      }
      run(rain, 300);
      expect(meanBrightness(rain)).toBeLessThan(1e-4);
    });

    it('sets the trail length: slower fade, longer streaks', () => {
      // The reach of a trail is `speed * ln(1 / threshold) / fade` cells. Both
      // the fades and the threshold have to be picked so that reach lands
      // inside this field: at a 0.05 threshold even fade 3.2 reaches 28 cells,
      // so on a 30-cell field both ends of the comparison saturate and the
      // assertion compares two identical numbers.
      const lit = (fade: number) => {
        const rain = oneLane(0, { speed: 30, brightness: 1 });
        run(rain, 20, 3, { ...RAIN_DEFAULTS, fade, flicker: 0 });
        return column(rain, 0).filter((v) => v > 0.2).length;
      };
      expect(lit(6)).toBeLessThan(15);
      expect(lit(1)).toBeGreaterThan(lit(6));
    });
  });

  it('settles to a steady density rather than filling up or dying out', () => {
    const rain = seeded(4);
    run(rain, 240);
    const early = meanBrightness(rain);
    run(rain, 240);
    const late = meanBrightness(rain);

    expect(early).toBeGreaterThan(0.005);
    expect(late).toBeGreaterThan(0.005);
    // Sparse - it is rain over a page, not a wall of light.
    expect(late).toBeLessThan(0.35);
    expect(Math.abs(late - early)).toBeLessThan(0.1);
  });

  it('is reproducible for a given seed', () => {
    const a = run(seeded(11), 50, 2);
    const b = run(seeded(11), 50, 2);
    expect(Array.from(a.field)).toEqual(Array.from(b.field));
  });

  describe('density', () => {
    it('responds to respawn - shorter waits mean more rain', () => {
      const density = (respawn: number) => {
        const rain = createRain(W, H, makeRandom(3), { ...RAIN_DEFAULTS, respawn });
        run(rain, 300, 8, { ...RAIN_DEFAULTS, respawn });
        return meanBrightness(rain);
      };
      expect(density(0.6)).toBeGreaterThan(density(8));
    });
  });
});

describe('distortField', () => {
  const params = RAIN_DEFAULTS;
  const spot = (over: Partial<Distortion> = {}): Distortion => ({ x: 20, y: 15, age: 0.15, strength: 1, ...over });

  /** A field with a recognisable pattern, so displacement is detectable. */
  const patterned = () => {
    const rain = createRain(W, H, makeRandom(1), params);
    for (const lane of rain.lanes) {
      lane.falling = false;
      lane.delay = Infinity;
    }
    // A grid, varying on *both* axes. Vertical stripes alone have a blind spot:
    // they are invariant under vertical displacement, so along the centre column
    // - where the push is purely vertical - a real distortion shows as no change
    // at all.
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) rain.field[y * W + x] = x % 4 === 0 || y % 4 === 0 ? 1 : 0;
    }
    return rain;
  };

  const changed = (a: Float32Array, b: Float32Array) => {
    let n = 0;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) n++;
    return n;
  };

  it('returns the field untouched when there is nothing to do', () => {
    // An idle page must not even pay for a copy.
    const rain = patterned();
    expect(distortField(rain, [], params)).toBe(rain.field);
  });

  it('returns the warped buffer when there is a distortion', () => {
    const rain = patterned();
    const out = distortField(rain, [spot()], params);
    expect(out).toBe(rain.warped);
  });

  it('displaces what is already there rather than adding light', () => {
    // The difference from a splash, and the reason it reads: total brightness is
    // essentially conserved, but it has moved.
    const rain = patterned();
    const before = Array.from(rain.field);
    const out = distortField(rain, [spot({ age: 0.2 })], params);

    expect(changed(new Float32Array(before), out)).toBeGreaterThan(20);

    const sum = (xs: ArrayLike<number>) => {
      let t = 0;
      for (let i = 0; i < xs.length; i++) t += xs[i];
      return t;
    };
    // Within a few percent - a lens moves light, it does not make it.
    expect(sum(out)).toBeGreaterThan(sum(before) * 0.85);
    expect(sum(out)).toBeLessThan(sum(before) * 1.15);
  });

  it('leaves the field itself alone, so the simulation is unaffected', () => {
    const rain = patterned();
    const snapshot = Array.from(rain.field);
    distortField(rain, [spot()], params);
    expect(Array.from(rain.field)).toEqual(snapshot);
  });

  it('stays local rather than touching the whole field', () => {
    // Asserted as a fraction rather than by picking corners. This test field is
    // 40x30, so its corners are 25 cells from the centre - inside the Gaussian
    // tail of even a young ring, which reaches three widths past its radius. The
    // property that matters is that the work is local, not that any given cell
    // is untouched.
    const rain = patterned();
    const tight = { ...params, distortSpeed: 20, distortWidth: 2 };
    const out = distortField(rain, [spot({ age: 0.1 })], tight);

    let touched = 0;
    for (let i = 0; i < out.length; i++) if (Math.abs(out[i] - rain.field[i]) > 1e-6) touched++;
    expect(touched).toBeGreaterThan(0);
    expect(touched).toBeLessThan(out.length * 0.5);
  });

  it('reaches further as the ring expands', () => {
    // Measured along the centre row. Two things rule out the obvious
    // alternatives: taking the furthest changed cell in *any* direction fails
    // because x wraps like the lanes do, so the bounding box spans every column
    // and the answer is the corner distance whatever the age; and the ring has to
    // be slowed down, or at 90 cells a second it leaves this 40x30 field entirely
    // and the measure saturates.
    const slow = { ...params, distortSpeed: 20, distortWidth: 2 };
    const reachAcross = (age: number) => {
      const rain = patterned();
      const out = distortField(rain, [spot({ age })], slow);
      let far = 0;
      for (let x = 0; x < W; x++) {
        if (Math.abs(out[15 * W + x] - rain.field[15 * W + x]) <= 1e-6) continue;
        far = Math.max(far, Math.abs(x - 20));
      }
      return far;
    };
    expect(reachAcross(0.4)).toBeGreaterThan(reachAcross(0.1));
  });

  it('does nothing once its lifetime is up', () => {
    const rain = patterned();
    for (const age of [params.distortLifetime, params.distortLifetime + 1, 99]) {
      const out = distortField(rain, [spot({ age })], params);
      expect(changed(rain.field, out)).toBe(0);
    }
  });

  it('ignores a negative age', () => {
    const rain = patterned();
    const out = distortField(rain, [spot({ age: -1 })], params);
    expect(changed(rain.field, out)).toBe(0);
  });

  it('scales with strength', () => {
    const spread = (strength: number) => {
      const rain = patterned();
      const out = distortField(rain, [spot({ strength })], params);
      return changed(rain.field, out);
    };
    expect(spread(1)).toBeGreaterThan(spread(0.1));
  });

  it('keeps the field inside 0..1', () => {
    const rain = patterned();
    const out = distortField(rain, [spot()], params);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('wraps sideways, so a distortion near an edge is not smeared', () => {
    // Lanes wrap, so this must too - otherwise the outermost column drags.
    const rain = patterned();
    const out = distortField(rain, [spot({ x: 1, y: 15, age: 0.2 })], params);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);

    // Something on the far side moved, pulled round the edge.
    let farSide = 0;
    for (let y = 0; y < H; y++) {
      for (let x = W - 4; x < W; x++) {
        if (Math.abs(out[y * W + x] - rain.field[y * W + x]) > 1e-6) farSide++;
      }
    }
    expect(farSide).toBeGreaterThan(0);
  });

  it('pushes symmetrically when the ring outgrows a narrow field', () => {
    // At this age the bounding box is wider than the field, so every column
    // falls inside it more than once. Each output column must be written
    // exactly once, from the nearest image of the centre - a last-write-wins
    // overlap hands cells the far ring's push instead of their own, and that
    // shows up as a left/right asymmetry about the centre column.
    const rain = patterned();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // Mirror-symmetric about column 20 even across the wrap, and varying
        // on both axes so displacement in any direction is detectable.
        rain.field[y * W + x] = 0.5 + 0.5 * Math.cos(((x - 20) / W) * 2 * Math.PI) * Math.cos((y / H) * 2 * Math.PI);
      }
    }

    const out = distortField(rain, [spot({ x: 20, y: 15, age: 0.3 })], params);
    for (let y = 0; y < H; y++) {
      for (let k = 1; k < W / 2; k++) {
        expect(out[y * W + 20 + k]).toBeCloseTo(out[y * W + 20 - k], 5);
      }
    }
  });

  it('clamps vertically rather than wrapping, unlike the smoke', () => {
    // Rain has a top it falls from and a bottom it retires at. Wrapping y would
    // drag the bottom of the screen back up into the top.
    const rain = patterned();
    rain.field.fill(0);
    for (let x = 0; x < W; x++) rain.field[(H - 1) * W + x] = 1;

    const out = distortField(rain, [spot({ x: 20, y: 1, age: 0.2 })], params);
    // Nothing from the bright bottom row should appear near the top.
    for (let x = 0; x < W; x++) expect(out[x]).toBeLessThan(0.5);
  });

  it('holds the edge row when a read lands past the top or bottom', () => {
    // A distortion centred just off an edge pushes the edge row's reads out of
    // the field. Those reads must land on the edge row itself: a partial clamp
    // that pins the row indices but leaves the blend fraction live mixes the
    // edge row with its neighbour, dimming it for no physical reason. The age
    // puts the ring's peak exactly on the edge cell, so the read overshoots by
    // several rows.
    const age = 5 / RAIN_DEFAULTS.distortSpeed;

    const top = patterned();
    top.field.fill(0);
    for (let x = 0; x < W; x++) top.field[x] = 1;
    expect(distortField(top, [spot({ x: 20, y: -5, age })], params)[20]).toBeCloseTo(1, 6);

    const bottom = patterned();
    bottom.field.fill(0);
    for (let x = 0; x < W; x++) bottom.field[(H - 1) * W + x] = 1;
    expect(distortField(bottom, [spot({ x: 20, y: H - 1 + 5, age })], params)[(H - 1) * W + 20]).toBeCloseTo(1, 6);
  });

  it('adds several distortions together', () => {
    const rain = patterned();
    const one = Array.from(distortField(rain, [spot({ x: 10 })], params));
    const two = Array.from(distortField(rain, [spot({ x: 10 }), spot({ x: 30 })], params));
    expect(two).not.toEqual(one);
  });

  it('survives a distortion centred outside the field', () => {
    const rain = patterned();
    for (const d of [spot({ x: -20 }), spot({ x: W + 20 }), spot({ y: -30 }), spot({ y: H + 30 })]) {
      const out = distortField(rain, [d], params);
      for (const v of out) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('skips the pass entirely when a live ring cannot reach any row', () => {
    // Rows clamp rather than wrap, so a ring far enough above or below the
    // field touches nothing - and the untouched case must return `field`
    // itself, not pay for a copy into the warped buffer.
    const rain = patterned();
    expect(distortField(rain, [spot({ y: -100 })], params)).toBe(rain.field);
    expect(distortField(rain, [spot({ y: H + 100 })], params)).toBe(rain.field);
  });
});
