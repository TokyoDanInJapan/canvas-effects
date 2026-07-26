import { describe, expect, it } from 'vitest';

import { makeRandom } from './noise';
import {
  FIRE_DEFAULTS,
  applySpark,
  createFire,
  flameHeight,
  propagateFire,
  randomizeFire,
  seedFire,
  stepFire,
  windAt,
  type Fire,
  type FireParams,
} from './fire';

const W = 48;
const H = 60;
const DT = 1 / 24;

const seeded = (seed = 17) => createFire(W, H, makeRandom(seed));

function burn(fire: Fire, frames: number, params: FireParams = FIRE_DEFAULTS, seed = 3) {
  const rand = makeRandom(seed);
  for (let i = 0; i < frames; i++) stepFire(fire, params, rand, DT);
  return fire;
}

const row = (f: Fire, y: number) => Array.from({ length: f.w }, (_, x) => f.heat[y * f.w + x]);
const rowMean = (f: Fire, y: number) => row(f, y).reduce((a, b) => a + b, 0) / f.w;

describe('randomizeFire', () => {
  it('is reproducible when given a seeded generator', () => {
    expect(randomizeFire(makeRandom(6))).toEqual(randomizeFire(makeRandom(6)));
  });

  it('gives the source and the wind independent seeds', () => {
    const state = randomizeFire(makeRandom(11));
    expect(state.seed).not.toBe(state.windSeed);
  });
});

describe('seedFire', () => {
  it('fuels the bottom row and nothing else', () => {
    const fire = seeded();
    seedFire(fire, FIRE_DEFAULTS);
    expect(rowMean(fire, H - 1)).toBeGreaterThan(0.2);
    expect(rowMean(fire, H - 2)).toBe(0);
  });

  it('stays inside 0..1', () => {
    const fire = seeded();
    for (let i = 0; i < 40; i++) {
      fire.elapsed += 0.3;
      seedFire(fire, FIRE_DEFAULTS);
      for (const v of row(fire, H - 1)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is uneven along the base, so the fire has hot and cold patches', () => {
    // A constant source row gives an even wall of flame with no shape.
    const fire = seeded();
    seedFire(fire, FIRE_DEFAULTS);
    const base = row(fire, H - 1);
    expect(Math.max(...base) - Math.min(...base)).toBeGreaterThan(0.15);
  });

  it('slides those patches along over time', () => {
    const fire = seeded();
    seedFire(fire, FIRE_DEFAULTS);
    const before = row(fire, H - 1);
    fire.elapsed += 20;
    seedFire(fire, FIRE_DEFAULTS);
    expect(row(fire, H - 1)).not.toEqual(before);
  });

  it('goes flat when the variance is off', () => {
    const fire = seeded();
    seedFire(fire, { ...FIRE_DEFAULTS, sourceVariance: 0 });
    const base = row(fire, H - 1);
    expect(Math.max(...base) - Math.min(...base)).toBeCloseTo(0, 6);
  });
});

describe('windAt', () => {
  it('wanders either side of the set wind rather than holding still', () => {
    const fire = seeded();
    const seen: number[] = [];
    for (let i = 0; i < 200; i++) {
      fire.elapsed += 0.5;
      seen.push(windAt(fire, FIRE_DEFAULTS));
    }
    expect(Math.min(...seen)).toBeLessThan(0);
    expect(Math.max(...seen)).toBeGreaterThan(0);
  });

  it('follows the bias it is given', () => {
    const fire = seeded();
    const mean = (wind: number) => {
      let total = 0;
      for (let i = 0; i < 200; i++) {
        fire.elapsed += 0.5;
        total += windAt(fire, { ...FIRE_DEFAULTS, wind });
      }
      return total / 200;
    };
    expect(mean(3)).toBeGreaterThan(mean(-3));
  });
});

describe('propagateFire', () => {
  it('carries heat upward', () => {
    const fire = seeded();
    seedFire(fire, FIRE_DEFAULTS);
    expect(rowMean(fire, H - 2)).toBe(0);
    propagateFire(fire, FIRE_DEFAULTS, makeRandom(2));
    expect(rowMean(fire, H - 2)).toBeGreaterThan(0);
  });

  it('climbs one row per pass rather than reaching the top at once', () => {
    // The loop order is what guarantees this: it reads a row and writes the one
    // above, never reading a row it has already written. Get that backwards and
    // heat teleports up the field in a single frame.
    const fire = seeded();
    seedFire(fire, FIRE_DEFAULTS);
    propagateFire(fire, FIRE_DEFAULTS, makeRandom(2));

    expect(rowMean(fire, H - 2)).toBeGreaterThan(0);
    expect(rowMean(fire, H - 3)).toBe(0);
  });

  it('cools as it climbs', () => {
    const fire = burn(seeded(), 120);
    // Averaged over bands, to look past the flicker.
    const band = (from: number, to: number) => {
      let total = 0;
      for (let y = from; y < to; y++) total += rowMean(fire, y);
      return total / (to - from);
    };
    expect(band(H - 10, H)).toBeGreaterThan(band(H - 25, H - 15));
    expect(band(H - 25, H - 15)).toBeGreaterThan(band(0, 10));
  });

  it('never goes negative or above one', () => {
    const fire = burn(seeded(), 200);
    for (const v of fire.heat) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('wraps sideways, so there is no edge to pile up against', () => {
    // A hard left-blowing wind must not clip a column of heat against x = 0.
    const fire = seeded();
    const windy = { ...FIRE_DEFAULTS, wind: -3, windStrength: 0, jitter: 0 };
    burn(fire, 80, windy);

    const leftEdge = Array.from({ length: H }, (_, y) => fire.heat[y * W]);
    const rightEdge = Array.from({ length: H }, (_, y) => fire.heat[y * W + W - 1]);
    expect(leftEdge.some((v) => v > 0)).toBe(true);
    expect(rightEdge.some((v) => v > 0)).toBe(true);
  });
});

describe('flame shape', () => {
  it('reaches partway up and leaves the top clear for text', () => {
    const fire = burn(seeded(), 200);
    const height = flameHeight(fire);
    expect(height).toBeGreaterThan(0.15);
    expect(height).toBeLessThan(0.95);
  });

  it('burns as high as it is told to, whatever the field size', () => {
    // The point of expressing this as a fraction rather than as heat lost per
    // row: a per-row figure fixes the height in cells, so the same value fills
    // a short field and leaves a strip on a tall one.
    //
    // Kept deliberately cheap. The first version ran `h * 4` frames over fields
    // up to 120x150 and called this helper twice per size - 50M cell operations,
    // which passed locally and timed out at 5s on a CI runner. The front climbs
    // `reach * h` rows at two passes a frame, so `h` frames is already four
    // times the settling time it needs.
    const reached = (w: number, h: number, reach: number) => {
      const fire = createFire(w, h, makeRandom(5));
      const rand = makeRandom(3);
      for (let i = 0; i < h; i++) stepFire(fire, { ...FIRE_DEFAULTS, reach }, rand, DT);
      return flameHeight(fire);
    };

    for (const [w, h] of [
      [32, 40],
      [32, 90],
      [48, 120],
    ]) {
      const height = reached(w, h, 0.5);
      expect(height).toBeGreaterThan(0.3);
      expect(height).toBeLessThan(0.8);
    }
  });

  it('burns higher when told to reach higher', () => {
    const height = (reach: number) => flameHeight(burn(seeded(5), 300, { ...FIRE_DEFAULTS, reach }));
    expect(height(0.8)).toBeGreaterThan(height(0.25));
  });

  it('burns higher on hotter fuel', () => {
    // With `reach` fixed, hotter fuel still climbs higher: the derived cooling
    // is tuned for full-strength fuel, so a weaker source runs out sooner.
    const height = (sourceHeat: number) =>
      flameHeight(burn(seeded(5), 200, { ...FIRE_DEFAULTS, sourceHeat, reach: 0.5 }));
    expect(height(1)).toBeGreaterThan(height(0.35));
  });

  describe('breaking into tongues rather than a smooth gradient', () => {
    /** Mean step between neighbouring cells across a line: how torn it is. */
    const roughness = (over: Partial<FireParams>) => {
      const fire = burn(seeded(8), 150, { ...FIRE_DEFAULTS, ...over });
      const line = row(fire, Math.floor(H * 0.75));
      let total = 0;
      for (let x = 1; x < line.length; x++) total += Math.abs(line[x] - line[x - 1]);
      return total / line.length;
    };

    it('is what cooling variance buys, measured with jitter held off', () => {
      // Both parameters roughen the field, so comparing them at default jitter
      // measures their sum rather than either one. Isolated: 0.013 -> 0.021 ->
      // 0.037 across the range, roughly a tripling.
      const still = { jitter: 0 };
      expect(roughness({ ...still, coolingVariance: 0.4 })).toBeGreaterThan(
        roughness({ ...still, coolingVariance: 0.02 })
      );
      expect(roughness({ ...still, coolingVariance: 0.85 })).toBeGreaterThan(
        roughness({ ...still, coolingVariance: 0.4 })
      );
      expect(roughness({ ...still, coolingVariance: 0.85 })).toBeGreaterThan(
        roughness({ ...still, coolingVariance: 0.02 }) * 2
      );
    });

    it('is also what jitter buys, independently', () => {
      // Measured rather than assumed: jitter contributes about as much as the
      // cooling variance does, which is not what the first version of this
      // claimed.
      const flat = { coolingVariance: 0.02 };
      expect(roughness({ ...flat, jitter: 1 })).toBeGreaterThan(roughness({ ...flat, jitter: 0 }));
      expect(roughness({ ...flat, jitter: 3 })).toBeGreaterThan(roughness({ ...flat, jitter: 1 }));
    });

    it('is nearly smooth with both switched off', () => {
      expect(roughness({ coolingVariance: 0.02, jitter: 0 })).toBeLessThan(0.02);
    });
  });
});

describe('stepFire', () => {
  it('keeps burning indefinitely rather than filling up or dying', () => {
    const fire = burn(seeded(), 600);
    expect(rowMean(fire, H - 1)).toBeGreaterThan(0.2);
    expect(flameHeight(fire)).toBeGreaterThan(0.1);
  });

  it('goes out when the fuel is cut, and does not come back', () => {
    const fire = burn(seeded(), 150);
    expect(flameHeight(fire)).toBeGreaterThan(0.1);

    burn(fire, 300, { ...FIRE_DEFAULTS, sourceHeat: 0 });
    let total = 0;
    for (const v of fire.heat) total += v;
    expect(total / fire.heat.length).toBeLessThan(0.01);
  });

  it('flickers - the picture changes frame to frame', () => {
    const fire = burn(seeded(), 100);
    const before = Array.from(fire.heat);
    burn(fire, 3, FIRE_DEFAULTS, 99);
    expect(Array.from(fire.heat)).not.toEqual(before);
  });

  it('is reproducible for a given seed', () => {
    const a = burn(seeded(21), 60, FIRE_DEFAULTS, 4);
    const b = burn(seeded(21), 60, FIRE_DEFAULTS, 4);
    expect(Array.from(a.heat)).toEqual(Array.from(b.heat));
  });

  it('climbs faster with more passes', () => {
    const reach = (passes: number) => flameHeight(burn(seeded(7), 12, { ...FIRE_DEFAULTS, passes }));
    expect(reach(4)).toBeGreaterThan(reach(1));
  });
});

describe('applySpark', () => {
  /** A cold field, so only the spark and what becomes of it are present. */
  const cold = () => {
    const fire = createFire(W, H, makeRandom(2));
    fire.heat.fill(0);
    return fire;
  };

  const spark = (fire: Fire, x = 24, y = 40, strength = 1, params = FIRE_DEFAULTS) => {
    applySpark(fire, { x, y, strength }, params);
    return fire;
  };

  const at = (f: Fire, x: number, y: number) => f.heat[y * f.w + x];
  const total = (f: Fire) => {
    let t = 0;
    for (const v of f.heat) t += v;
    return t;
  };
  /** Height of the heat's centre of mass, in rows from the top. */
  const centreOfMass = (f: Fire) => {
    let weighted = 0;
    let mass = 0;
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const v = f.heat[y * f.w + x];
        weighted += v * y;
        mass += v;
      }
    }
    return mass > 0 ? weighted / mass : -1;
  };

  it('drops heat where it landed', () => {
    const f = spark(cold());
    expect(at(f, 24, 40)).toBeCloseTo(1, 6);
  });

  it('falls off smoothly to nothing at its rim', () => {
    const f = spark(cold());
    const radius = Math.round(FIRE_DEFAULTS.sparkRadius * Math.min(W, H));
    expect(at(f, 24 + Math.floor(radius / 2), 40)).toBeGreaterThan(0);
    expect(at(f, 24 + radius + 2, 40)).toBe(0);
  });

  it('stays inside 0..1 even with an over-hot parameter', () => {
    const f = spark(cold(), 24, 40, 4, { ...FIRE_DEFAULTS, sparkHeat: 3 });
    for (const v of f.heat) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('never cools what is already burning', () => {
    const f = cold();
    f.heat.fill(1);
    spark(f, 24, 40, 0.4);
    for (const v of f.heat) expect(v).toBe(1);
  });

  it('wraps sideways, so a click near an edge is not half a spark', () => {
    const f = spark(cold(), 1, 40);
    let farSide = 0;
    for (let y = 0; y < H; y++) for (let x = W - 4; x < W; x++) farSide += at(f, x, y);
    expect(farSide).toBeGreaterThan(0);
  });

  it('scales with strength', () => {
    expect(total(spark(cold(), 24, 40, 1))).toBeGreaterThan(total(spark(cold(), 24, 40, 0.25)));
  });

  it('is clipped by the top and bottom edges without erroring', () => {
    for (const y of [-10, 0, H - 1, H + 10]) {
      const f = cold();
      expect(() => spark(f, 24, y)).not.toThrow();
      for (const v of f.heat) expect(Number.isFinite(v)).toBe(true);
    }
  });

  describe('what the simulation then does with it', () => {
    it('carries it upward - the whole reason this shape of effect fits', () => {
      // Nothing here says "rise". The propagation reads each row from the row
      // below, so a parcel of heat climbs on its own.
      const f = spark(cold(), 24, 40, 1, { ...FIRE_DEFAULTS, sourceHeat: 0 });
      const before = centreOfMass(f);

      const rand = makeRandom(5);
      for (let i = 0; i < 8; i++) stepFire(f, { ...FIRE_DEFAULTS, sourceHeat: 0 }, rand, DT);

      // Smaller row index is higher up the field.
      expect(centreOfMass(f)).toBeLessThan(before);
    });

    it('loses its bottom edge as it climbs, rather than sitting where it was put', () => {
      // `propagateFire` overwrites each row from the row below, so the cells a
      // spark occupied are replaced by the cooler air beneath them. That is what
      // makes the blob move instead of hovering.
      const params = { ...FIRE_DEFAULTS, sourceHeat: 0 };
      const f = spark(cold(), 24, 40, 1, params);
      const bottomBefore = at(f, 24, 40 + 3);

      const rand = makeRandom(5);
      for (let i = 0; i < 6; i++) stepFire(f, params, rand, DT);
      expect(at(f, 24, 40 + 3)).toBeLessThan(bottomBefore);
    });

    it('dies out on its own, with no fuel and nothing to prune', () => {
      const params = { ...FIRE_DEFAULTS, sourceHeat: 0 };
      const f = spark(cold(), 24, 40, 1, params);
      expect(total(f)).toBeGreaterThan(0);

      const rand = makeRandom(5);
      for (let i = 0; i < 200; i++) stepFire(f, params, rand, DT);
      expect(total(f) / f.heat.length).toBeLessThan(0.005);
    });

    it('breaks up as it goes rather than rising as a clean disc', () => {
      // The cooling variance and the sideways jitter tear it, which is what makes
      // a spark read as flame rather than as a moving blob.
      const params = { ...FIRE_DEFAULTS, sourceHeat: 0 };
      const roughness = (over: Partial<typeof FIRE_DEFAULTS>) => {
        const f = spark(cold(), 24, 40, 1, { ...params, ...over });
        const rand = makeRandom(5);
        for (let i = 0; i < 10; i++) stepFire(f, { ...params, ...over }, rand, DT);
        // Mean step between horizontal neighbours across the plume's rows.
        let sum = 0;
        let n = 0;
        for (let y = 20; y < 45; y++) {
          for (let x = 1; x < W; x++) {
            sum += Math.abs(at(f, x, y) - at(f, x - 1, y));
            n++;
          }
        }
        return sum / n;
      };

      expect(roughness({})).toBeGreaterThan(roughness({ coolingVariance: 0, jitter: 0 }));
    });

    it('adds to a burning fire rather than replacing it', () => {
      const lit = createFire(W, H, makeRandom(2));
      const rand = makeRandom(5);
      for (let i = 0; i < 60; i++) stepFire(lit, FIRE_DEFAULTS, rand, DT);
      const before = total(lit);

      spark(lit, 24, 20);
      expect(total(lit)).toBeGreaterThan(before);
    });
  });
});
