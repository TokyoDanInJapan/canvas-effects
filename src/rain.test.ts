import { describe, expect, it } from 'vitest';

import { makeRandom } from './noise';
import { RAIN_DEFAULTS, createRain, meanBrightness, rollLane, stepRain, type Rain, type RainLane } from './rain';

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
