import { describe, expect, it } from 'vitest';

import { aspectOf, cellSpansOf } from './background.js';
import {
  BEER_DEFAULTS,
  addBubble,
  carryBeer,
  createBeer,
  driftBubbles,
  fuseBubbles,
  headAt,
  headVolume,
  popBubbles,
  renderBeer,
  settleHead,
  stepBeer,
  stepWaves,
  stirBubbles,
  surfaceAt,
  type Beer,
  type BeerParams,
  type Bubble,
  type Stir,
} from './beer.js';
import { makeRandom } from './noise.js';

const W = 128;
const H = 72;

/** A glass with the fizz cleared out, for tests that place their own bubbles. */
const empty = (params: BeerParams = BEER_DEFAULTS, w = W, h = H, seed = 21): Beer => {
  const beer = createBeer(w, h, makeRandom(seed), params);
  beer.bubbles.length = 0;
  return beer;
};

const bubble = (x: number, y: number, radius = 0.02, over: Partial<Bubble> = {}): Bubble => ({
  x,
  y,
  radius,
  vx: 0,
  vy: 0,
  phase: 0,
  wobble: 1,
  ...over,
});

const stir = (x: number, y: number, vx: number, vy = 0, age = 0): Stir => ({ x, y, vx, vy, age });

/**
 * A becalmed glass: no splashes, so an undisturbed surface stays exactly at
 * the pour line. Splashes are the only ambient input to the wave field, which
 * is why turning them off is all stillness takes.
 */
const FLAT: BeerParams = { ...BEER_DEFAULTS, splash: 0 };

describe('the liquid line', () => {
  it('sits at the fill fraction, measured from the bottom', () => {
    const beer = empty(FLAT);
    expect(surfaceAt(beer, FLAT, 0.5)).toBeCloseTo(1 - FLAT.fill, 6);
  });

  it('stays flat until something disturbs it', () => {
    // There is no procedural ripple to fake life: a glass with no fizz and no
    // stirs is glassy still, which is what a real flat pint looks like.
    const beer = empty(FLAT);
    for (let i = 0; i < 100; i++) stepWaves(beer, FLAT, 1 / 24);

    for (let x = 0; x < aspectOf(beer); x += 0.1) {
      expect(surfaceAt(beer, FLAT, x)).toBeCloseTo(1 - FLAT.fill, 9);
    }
  });
});

describe('the waves', () => {
  it('spreads a heap to its neighbours instead of leaving it standing', () => {
    const beer = empty(FLAT);
    const mid = beer.w >> 1;
    beer.wave[mid] = -0.02;

    stepWaves(beer, FLAT, 1 / 24);

    let moved = 0;
    for (const v of beer.wave) if (Math.abs(v) > 5e-4) moved++;
    expect(moved).toBeGreaterThan(3);
    expect(Math.abs(beer.wave[mid])).toBeLessThan(0.015);
  });

  it('sloshes: the fundamental mode swings past level and inverts', () => {
    // The old version animated a tilt oscillator to get this. Here it has to
    // *emerge*: a half-cosine across the glass is the wave field's fundamental
    // mode, and its half-period is `aspect / waveSpeed` - so after that long,
    // the wall that started high should be low. If this fails, the surface
    // eases back like a lid instead of swinging like a liquid.
    const params: BeerParams = { ...FLAT, waveDamping: 0.5 };
    const beer = empty(params);
    const w = beer.w;
    for (let i = 0; i < w; i++) beer.wave[i] = -0.02 * Math.cos((Math.PI * i) / (w - 1));

    const halfPeriod = aspectOf(beer) / params.waveSpeed;
    const steps = Math.round(halfPeriod * 24);
    for (let i = 0; i < steps; i++) stepWaves(beer, params, 1 / 24);

    // The left wall began raised (negative is up) and should now be dropped.
    expect(beer.wave[0]).toBeGreaterThan(0.004);
    expect(beer.wave[w - 1]).toBeLessThan(-0.004);
  });

  it('carries a disturbance at about waveSpeed', () => {
    const params: BeerParams = { ...FLAT, waveDamping: 0, waveMax: 0.5 };
    const beer = empty(params);
    const [spanX] = cellSpansOf(beer);
    const mid = beer.w >> 1;

    // A smooth dip, not a spike - a single-column spike disperses into ringing
    // and there is no clean front to time.
    for (let i = 0; i < beer.w; i++) {
      const d = ((i - mid) * spanX) / 0.06;
      beer.wave[i] = -0.02 * Math.exp(-d * d);
    }

    const target = mid + Math.round(0.5 / spanX);
    const before = beer.wave[target];
    const dt = 1 / 48;
    let arrived = -1;
    for (let i = 0; i < 48 && arrived < 0; i++) {
      stepWaves(beer, params, dt);
      if (beer.wave[target] < before - 0.005) arrived = (i + 1) * dt;
    }

    // Half a height unit away at 2 height units a second: about a quarter of a
    // second, with slack for numerical dispersion softening the front.
    expect(arrived).toBeGreaterThan(0.15);
    expect(arrived).toBeLessThan(0.4);
  });

  it('conserves the beer, whatever pushes on it', () => {
    // Stirs and splashes hand the surface velocity with no promise that it
    // sums to zero, so the volume guarantee has to live here: the mean height
    // is levelled every step, which cannot touch the motion because every
    // travelling wave and the slosh itself are zero-mean shapes.
    const beer = empty(FLAT);
    const rand = makeRandom(9);

    for (let i = 0; i < 60; i++) {
      beer.waveV[Math.floor(rand() * beer.w)] += rand() * 0.5;
      stepWaves(beer, FLAT, 1 / 24);
    }

    let mean = 0;
    for (const v of beer.wave) mean += v;
    expect(Math.abs(mean / beer.w)).toBeLessThan(1e-5);
  });

  it('loses no energy at the walls, only to the damping', () => {
    // Reflection is the slosh, so the walls must be mirrors rather than
    // absorbers. With the damping off, the discrete wave energy has to hold
    // steady across many round trips - a leaky wall shows up here as a drain.
    const params: BeerParams = { ...FLAT, waveDamping: 0, waveMax: 0.5 };
    const beer = empty(params);
    const [spanX] = cellSpansOf(beer);
    const mid = beer.w >> 1;
    for (let i = 0; i < beer.w; i++) {
      const d = ((i - mid) * spanX) / 0.1;
      beer.wave[i] = -0.02 * Math.exp(-d * d);
    }

    const energy = () => {
      let e = 0;
      for (let i = 0; i < beer.w; i++) {
        e += beer.waveV[i] * beer.waveV[i];
        if (i > 0) {
          const slope = ((beer.wave[i] - beer.wave[i - 1]) / spanX) * params.waveSpeed;
          e += slope * slope;
        }
      }
      return e;
    };

    // After the first step the pulse is moving, so measure from there.
    stepWaves(beer, params, 1 / 24);
    const start = energy();
    for (let i = 0; i < 100; i++) stepWaves(beer, params, 1 / 24);

    expect(energy()).toBeGreaterThan(start * 0.6);
    expect(energy()).toBeLessThan(start * 1.4);
  });

  it('calms down', () => {
    const beer = empty(FLAT);
    beer.waveV[beer.w >> 2] = 2;

    for (let i = 0; i < 24 * 6; i++) stepWaves(beer, FLAT, 1 / 24);

    let peak = 0;
    for (const v of beer.wave) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(0.002);
  });

  it('is held to waveMax', () => {
    const beer = empty(FLAT);
    beer.waveV[beer.w >> 2] = 50;

    for (let i = 0; i < 40; i++) stepWaves(beer, FLAT, 1 / 24);

    for (const v of beer.wave) expect(Math.abs(v)).toBeLessThanOrEqual(FLAT.waveMax * 1.1);
  });

  it('advances the same however the seconds are chopped up', () => {
    // The CFL substepping must make the physics a function of elapsed time,
    // not of how the frames happened to land. These particular numbers give
    // both paths identical substeps, so the runs agree to float precision.
    const params: BeerParams = { ...FLAT, waveSpeed: 2, waveDamping: 1 };
    const one = empty(params);
    const two = empty(params);
    one.wave[10] = -0.02;
    two.wave[10] = -0.02;

    stepWaves(one, params, 1 / 24);
    stepWaves(two, params, 1 / 48);
    stepWaves(two, params, 1 / 48);

    for (let i = 0; i < one.w; i++) expect(two.wave[i]).toBeCloseTo(one.wave[i], 7);
  });
});

describe('bubbles rising', () => {
  it('climbs, and the bigger one climbs faster', () => {
    const beer = empty();
    const small = bubble(0.5, 0.9, 0.011);
    const large = bubble(1.0, 0.9, 0.044);
    beer.bubbles.push(small, large);

    driftBubbles(beer, BEER_DEFAULTS, 0.1);

    expect(small.y).toBeLessThan(0.9);
    expect(large.y).toBeLessThan(small.y);
  });

  it('rises with the square of its radius - the Stokes law', () => {
    // Half the mean radius climbs at a quarter speed, double it at four times:
    // a factor of sixteen between them. This is what leaves the finest fizz
    // hanging almost still while a fresh merge pulls away from the crowd.
    const beer = empty();
    const small = bubble(0.5, 0.9, BEER_DEFAULTS.radius / 2);
    const large = bubble(1.0, 0.9, BEER_DEFAULTS.radius * 2);
    beer.bubbles.push(small, large);

    driftBubbles(beer, BEER_DEFAULTS, 0.1);

    expect((0.9 - large.y) / (0.9 - small.y)).toBeCloseTo(16, 4);
  });

  it('caps the climb, so a lucky chain of merges cannot teleport', () => {
    const beer = empty();
    const huge = bubble(0.5, 0.9, BEER_DEFAULTS.radius * 20);
    const capped = bubble(1.0, 0.9, BEER_DEFAULTS.radius * 2);
    beer.bubbles.push(huge, capped);

    driftBubbles(beer, BEER_DEFAULTS, 0.1);

    // Twenty times the radius is four hundred times the law's speed, but both
    // of these sit at the cap - a factor of four - so they climb together.
    expect(huge.y).toBeCloseTo(capped.y, 6);
  });

  it('swells as it climbs', () => {
    const beer = empty();
    const rising = bubble(0.5, 0.9, 0.02);
    beer.bubbles.push(rising);

    driftBubbles(beer, BEER_DEFAULTS, 1);

    expect(rising.radius).toBeCloseTo(0.02 * Math.exp(BEER_DEFAULTS.growth), 6);
  });

  it('stays between the walls of the glass', () => {
    const beer = empty();
    const shoved = bubble(0.1, 0.9, 0.02, { vx: -8 });
    beer.bubbles.push(shoved);

    for (let i = 0; i < 20; i++) driftBubbles(beer, BEER_DEFAULTS, 1 / 24);

    expect(shoved.x).toBeGreaterThanOrEqual(0);
    expect(shoved.x).toBeLessThanOrEqual(aspectOf(beer));
  });

  it('zigzags no further than the sway allows', () => {
    const beer = empty();
    const drifting = bubble(1, 0.9, 0.02);
    beer.bubbles.push(drifting);

    let furthest = 0;
    for (let i = 0; i < 200; i++) {
      driftBubbles(beer, BEER_DEFAULTS, 1 / 60);
      furthest = Math.max(furthest, Math.abs(drifting.x - 1));
    }

    // The zigzag is integrated from a cosine, so the excursion is the amplitude
    // itself rather than something that accumulates.
    expect(furthest).toBeLessThan(BEER_DEFAULTS.sway * 1.2);
  });

  it('loses a stir push exponentially, at a rate that does not depend on the step', () => {
    const one = empty();
    const two = empty();
    one.bubbles.push(bubble(1, 0.9, 0.02, { vx: 1 }));
    two.bubbles.push(bubble(1, 0.9, 0.02, { vx: 1 }));

    driftBubbles(one, BEER_DEFAULTS, 0.5);
    driftBubbles(two, BEER_DEFAULTS, 0.25);
    driftBubbles(two, BEER_DEFAULTS, 0.25);

    expect(two.bubbles[0].vx).toBeCloseTo(one.bubbles[0].vx, 9);
  });
});

describe('fusing - two bubbles becoming one', () => {
  it('conserves area', () => {
    const beer = empty();
    beer.bubbles.push(bubble(1, 0.8, 0.02), bubble(1.01, 0.8, 0.03));

    expect(fuseBubbles(beer, BEER_DEFAULTS)).toBe(1);
    expect(beer.bubbles).toHaveLength(1);
    expect(beer.bubbles[0].radius).toBeCloseTo(Math.hypot(0.02, 0.03), 9);
  });

  it('puts the survivor at the area-weighted centre, not at either bubble', () => {
    const beer = empty();
    beer.bubbles.push(bubble(1, 0.8, 0.01), bubble(1.02, 0.8, 0.03));

    fuseBubbles(beer, BEER_DEFAULTS);

    // Nine tenths of the area is in the larger one, so the join happens mostly
    // where it already was.
    expect(beer.bubbles[0].x).toBeCloseTo((1 * 0.0001 + 1.02 * 0.0009) / 0.001, 9);
  });

  it('leaves bubbles that are merely near each other alone', () => {
    const beer = empty();
    beer.bubbles.push(bubble(1, 0.8, 0.02), bubble(1.05, 0.8, 0.02));

    expect(fuseBubbles(beer, BEER_DEFAULTS)).toBe(0);
    expect(beer.bubbles).toHaveLength(2);
  });

  it('never fuses anything when merge is zero', () => {
    const beer = empty();
    beer.bubbles.push(bubble(1, 0.8, 0.02), bubble(1.001, 0.8, 0.02));

    expect(fuseBubbles(beer, { ...BEER_DEFAULTS, merge: 0 })).toBe(0);
    expect(beer.bubbles).toHaveLength(2);
  });

  it('collapses a whole crowd, however it was ordered', () => {
    // The sweep walks a sort, so hand it the worst case: overlapping bubbles
    // pushed in reverse order, where a naive left-to-right scan that trusted
    // the insertion order would miss pairs. Area must survive the pile-up.
    const beer = empty();
    for (let i = 4; i >= 0; i--) beer.bubbles.push(bubble(1 + i * 0.005, 0.8, 0.02));

    expect(fuseBubbles(beer, BEER_DEFAULTS)).toBe(4);
    expect(beer.bubbles).toHaveLength(1);
    expect(beer.bubbles[0].radius).toBeCloseTo(Math.sqrt(5 * 0.02 * 0.02), 9);
  });

  it('has already been drawn as one blob by the time it happens', () => {
    const params: BeerParams = { ...FLAT, rate: 0 };
    const beer = empty(params);
    const radius = 0.05;
    // A hair further apart than the physics fuses at, so these are still two
    // bubbles as far as everything but the field is concerned.
    const gap = params.merge * (radius + radius) * 1.05;

    beer.bubbles.push(bubble(1 - gap / 2, 0.8, radius), bubble(1 + gap / 2, 0.8, radius));
    expect(fuseBubbles(beer, params)).toBe(0);

    renderBeer(beer, params);

    const [spanX, spanY] = cellSpansOf(beer);
    const at = (x: number, y: number) => beer.field[Math.round(y / spanY) * beer.w + Math.round(x / spanX)];

    // Compared against beer at the same depth, so the depth shading is not what
    // is being measured. The midpoint is lit because the two falloffs have
    // crossed the surface between them, which is the neck.
    expect(at(1, 0.8)).toBeGreaterThan(at(1.6, 0.8) + 0.1);
  });
});

describe('popping - what feeds the head', () => {
  it('bursts a bubble that reaches the surface and leaves foam behind', () => {
    const beer = empty(FLAT);
    const line = 1 - FLAT.fill;
    beer.bubbles.push(bubble(1, line + 0.01, 0.02));

    expect(popBubbles(beer, FLAT)).toBe(1);
    expect(beer.bubbles).toHaveLength(0);
    expect(headVolume(beer)).toBeGreaterThan(0);
  });

  it('leaves one still under the surface alone', () => {
    const beer = empty(FLAT);
    beer.bubbles.push(bubble(1, 1 - FLAT.fill + 0.2, 0.02));

    expect(popBubbles(beer, FLAT)).toBe(0);
    expect(headVolume(beer)).toBe(0);
  });

  it('splashes the surface it broke', () => {
    // This is the whole of the idle shimmer: no pops, no motion. The kick goes
    // into the wave field's velocity, so the dip spreads as a real wave rather
    // than being stamped on as a shape.
    const params: BeerParams = { ...BEER_DEFAULTS, splash: 0.2 };
    const beer = empty(params);
    beer.bubbles.push(bubble(1, 1 - params.fill + 0.01, 0.02));

    popBubbles(beer, params);

    let kicked = 0;
    for (const v of beer.waveV) kicked += v;
    expect(kicked).toBeGreaterThan(0);
  });

  it('leaves the same amount of foam on a coarse field as on a fine one', () => {
    // The bug this pins: dropping a pop's whole area into the single column
    // under its centre gives a thickness that scales with the field's
    // resolution, so on a fine field almost all of it is clipped away by
    // `headMax` and the head comes out thin. Spread over the columns the bubble
    // actually covers, it is the same foam either way - exactly, because the
    // area is divided by the width of those columns rather than by the ideal
    // footprint.
    const foam = (w: number, h: number) => {
      const beer = empty(FLAT, w, h);
      beer.bubbles.push(bubble(aspectOf(beer) / 2, 1 - FLAT.fill + 0.01, 0.03));
      popBubbles(beer, FLAT);
      return headVolume(beer);
    };

    const coarse = foam(64, 36);
    const fine = foam(512, 288);

    expect(fine).toBeGreaterThan(0);
    expect(coarse).toBeCloseTo(fine, 6);
  });

  it('never piles the head past its ceiling', () => {
    const beer = empty(FLAT);
    for (let i = 0; i < 50; i++) beer.bubbles.push(bubble(1, 1 - FLAT.fill + 0.01, 0.03));

    popBubbles(beer, FLAT);

    // To within what a Float32Array can hold, which is what the head is.
    for (const thickness of beer.head) expect(thickness).toBeLessThanOrEqual(FLAT.headMax + 1e-7);
  });
});

describe('the head', () => {
  it('drains at the same rate however the seconds are chopped up', () => {
    const still: BeerParams = { ...FLAT, spread: 0 };

    const one = empty(still);
    const two = empty(still);
    one.head.fill(0.1);
    two.head.fill(0.1);

    settleHead(one, still, 0.5);
    settleHead(two, still, 0.25);
    settleHead(two, still, 0.25);

    expect(two.head[10]).toBeCloseTo(one.head[10], 7);
    expect(one.head[10]).toBeCloseTo(0.1 * Math.exp(-still.drain * 0.5), 7);
  });

  it('levels a spike sideways without losing the foam in it', () => {
    // Diffusion moves foam about; it does not create or destroy it. Tested with
    // the drain off, which is the only thing here that is meant to lose any.
    const params: BeerParams = { ...FLAT, drain: 0 };
    const beer = empty(params);
    beer.head[beer.w >> 1] = 0.1;

    const before = headVolume(beer);
    for (let i = 0; i < 40; i++) settleHead(beer, params, 1 / 24);

    expect(headVolume(beer)).toBeCloseTo(before, 6);
    // It has actually spread rather than sat there.
    expect(beer.head[beer.w >> 1]).toBeLessThan(0.1);
    expect(beer.head[(beer.w >> 1) + 3]).toBeGreaterThan(0);
  });

  it('smooths rather than rings, even at an absurd step', () => {
    // An explicit diffusion step goes unstable past a coefficient of a half and
    // starts alternating sign along the array. The clamp is what stops that, and
    // this is the test that would notice it going.
    const params: BeerParams = { ...FLAT, drain: 0, spread: 40 };
    const beer = empty(params);
    beer.head[beer.w >> 1] = 0.1;

    for (let i = 0; i < 60; i++) settleHead(beer, params, 1);

    for (const thickness of beer.head) expect(thickness).toBeGreaterThanOrEqual(0);
  });

  it('keeps foam pushed against a wall instead of draining it out of the array', () => {
    const params: BeerParams = { ...FLAT, drain: 0 };
    const beer = empty(params);
    beer.head[0] = 0.1;

    const before = headVolume(beer);
    for (let i = 0; i < 60; i++) settleHead(beer, params, 1 / 24);

    expect(headVolume(beer)).toBeCloseTo(before, 6);
  });
});

describe('stirring', () => {
  it('carries a bubble along with the pointer', () => {
    const beer = empty();
    const caught = bubble(1, 0.8, 0.02);
    beer.bubbles.push(caught);

    stirBubbles(beer, BEER_DEFAULTS, [stir(1, 0.8, 1.5)], 1 / 24, 0.55);

    expect(caught.vx).toBeGreaterThan(0);
  });

  it('never carries it faster than the pointer, however long it is held there', () => {
    // The reason a bubble is eased towards the stir's speed rather than shoved
    // by it: a shove accumulates for as long as the pointer is over it.
    const beer = empty();
    const caught = bubble(1, 0.8, 0.02);
    beer.bubbles.push(caught);

    for (let i = 0; i < 200; i++) stirBubbles(beer, BEER_DEFAULTS, [stir(caught.x, caught.y, 1.5)], 1 / 24, 0.55);

    expect(caught.vx).toBeLessThanOrEqual(1.5 + 1e-9);
    expect(caught.vx).toBeGreaterThan(1.2);
  });

  it('leaves a bubble beyond its reach entirely alone', () => {
    const beer = empty();
    const far = bubble(1 + BEER_DEFAULTS.stirReach * 1.5, 0.8, 0.02);
    beer.bubbles.push(far);

    stirBubbles(beer, BEER_DEFAULTS, [stir(1, 0.8, 3)], 1 / 24, 0.55);

    expect(far.vx).toBe(0);
  });

  it('does nothing once it has aged out', () => {
    const beer = empty();
    const caught = bubble(1, 0.8, 0.02);
    beer.bubbles.push(caught);

    stirBubbles(beer, BEER_DEFAULTS, [stir(1, 1 - BEER_DEFAULTS.fill + 0.05, 2, 0, 1)], 1 / 24, 0.55);

    expect(caught.vx).toBe(0);
    for (const v of beer.waveV) expect(v).toBe(0);
  });

  it('ploughs a bow wave: risen ahead of the drag, dipped behind it', () => {
    // What a finger pulled through liquid does, and the sign a viewer would
    // notice being wrong. Negative velocity is upward, matching `y`.
    const beer = empty(FLAT);
    const surface = 1 - FLAT.fill;
    stirBubbles(beer, FLAT, [stir(1, surface + 0.05, 1.5)], 1 / 24, 0.55);

    const [spanX] = cellSpansOf(beer);
    let ahead = 0;
    let behind = 0;
    for (let i = 0; i < beer.w; i++) {
      if (i * spanX > 1) ahead += beer.waveV[i];
      else behind += beer.waveV[i];
    }

    expect(ahead).toBeLessThan(0);
    expect(behind).toBeGreaterThan(0);
  });

  it('moves beer about without conjuring any', () => {
    // The bow wave is antisymmetric, so a horizontal drag's pushes sum to zero
    // across the glass - the volume guarantee starts here, before the wave
    // field's levelling ever has to correct anything.
    const beer = empty(FLAT);
    stirBubbles(beer, FLAT, [stir(1, 1 - FLAT.fill + 0.05, 2)], 1 / 24, 0.55);

    let total = 0;
    for (const v of beer.waveV) total += v;
    expect(Math.abs(total)).toBeLessThan(1e-4);
  });

  it('lifts the surface under an upward pull', () => {
    const beer = empty(FLAT);
    stirBubbles(beer, FLAT, [stir(1, 1 - FLAT.fill + 0.05, 0, -1.5)], 1 / 24, 0.55);

    let total = 0;
    for (const v of beer.waveV) total += v;
    expect(total).toBeLessThan(0);
  });

  it('pushes the surface with the newest sample only', () => {
    // Every live stir is a sample of the same pointer, so letting each of them
    // push would have a fast drag plough twice over - once through its speed
    // and once through the extra samples that speed produced.
    const surface = 1 - FLAT.fill;

    const sparse = empty(FLAT);
    stirBubbles(sparse, FLAT, [stir(1, surface + 0.05, 1.2)], 1 / 24, 0.55);

    const dense = empty(FLAT);
    const many = Array.from({ length: 10 }, () => stir(1, surface + 0.05, 1.2));
    stirBubbles(dense, FLAT, many, 1 / 24, 0.55);

    for (let i = 0; i < sparse.w; i++) expect(dense.waveV[i]).toBeCloseTo(sparse.waveV[i], 9);
  });

  it('cannot move the surface from the air above it', () => {
    const beer = empty(FLAT);
    stirBubbles(beer, FLAT, [stir(1, 0.1, 3)], 1 / 24, 0.55);

    for (const v of beer.waveV) expect(v).toBe(0);
  });

  it('hardly moves the surface from deep in the glass', () => {
    // The pressure a moving hand makes falls off with depth: a drag along the
    // bottom stirs the fizz there, not the line half a screen above it.
    const beer = empty(FLAT);
    stirBubbles(beer, FLAT, [stir(1, 0.95, 3)], 1 / 24, 0.55);

    for (const v of beer.waveV) expect(v).toBe(0);
  });
});

describe('the loop', () => {
  it('settles to a head and holds it', () => {
    const rand = makeRandom(4);
    const beer = createBeer(192, 108, rand, BEER_DEFAULTS);

    for (let i = 0; i < 240; i++) stepBeer(beer, BEER_DEFAULTS, rand, 1 / 24);
    const settled = headVolume(beer);

    for (let i = 0; i < 240; i++) stepBeer(beer, BEER_DEFAULTS, rand, 1 / 24);
    const later = headVolume(beer);

    expect(settled).toBeGreaterThan(0.02);
    expect(later).toBeGreaterThan(settled * 0.6);
    expect(later).toBeLessThan(settled * 1.6);
  });

  it('thins the head when the fizz is turned down, with nothing else touched', () => {
    // The claim the whole arrangement rests on: the head is a balance between
    // two rates rather than a thickness anybody sets.
    const head = (rate: number) => {
      const params = { ...BEER_DEFAULTS, rate };
      const rand = makeRandom(4);
      const beer = createBeer(192, 108, rand, params);
      for (let i = 0; i < 300; i++) stepBeer(beer, params, rand, 1 / 24);
      return headVolume(beer);
    };

    expect(head(6)).toBeLessThan(head(40) * 0.5);
  });

  it('keeps the surface moving while the fizz runs', () => {
    // The shimmer has a cause now, and this is it: pops splashing the wave
    // field. A settled glass at the default fizz is never glassy still.
    const rand = makeRandom(4);
    const beer = createBeer(192, 108, rand, BEER_DEFAULTS);
    for (let i = 0; i < 120; i++) stepBeer(beer, BEER_DEFAULTS, rand, 1 / 24);

    let peak = 0;
    for (let i = 0; i < 120; i++) {
      stepBeer(beer, BEER_DEFAULTS, rand, 1 / 24);
      for (const v of beer.wave) peak = Math.max(peak, Math.abs(v));
    }

    expect(peak).toBeGreaterThan(0.001);
    // Alive, not stormy: well clear of the clamp, so a stir has headroom.
    expect(peak).toBeLessThan(BEER_DEFAULTS.waveMax * 0.5);
  });

  it('keeps the population within its ceiling', () => {
    const params = { ...BEER_DEFAULTS, rate: 400, maxBubbles: 60 };
    const rand = makeRandom(4);
    const beer = createBeer(192, 108, rand, params);

    for (let i = 0; i < 200; i++) {
      stepBeer(beer, params, rand, 1 / 24);
      expect(beer.bubbles.length).toBeLessThanOrEqual(params.maxBubbles);
    }
  });

  it('does not bank a backlog while the glass is full', () => {
    // Otherwise the moment a bubble pops, every bubble the rate has owed since
    // the ceiling was reached arrives at once.
    const params = { ...BEER_DEFAULTS, rate: 2000, maxBubbles: 20 };
    const rand = makeRandom(4);
    const beer = createBeer(96, 54, rand, params);

    for (let i = 0; i < 50; i++) stepBeer(beer, params, rand, 1 / 24);

    expect(beer.owed).toBeLessThan(1);
  });

  it('advances nothing on a zero step', () => {
    const rand = makeRandom(4);
    const beer = createBeer(96, 54, rand, BEER_DEFAULTS);
    const before = beer.bubbles.map((b) => b.y);

    stepBeer(beer, BEER_DEFAULTS, rand, 0);

    expect(beer.time).toBe(0);
    expect(beer.bubbles.map((b) => b.y)).toEqual(before);
    for (const v of beer.wave) expect(v).toBe(0);
  });
});

describe('rendering', () => {
  const settled = (params: BeerParams = FLAT, w = W, h = H) => {
    const rand = makeRandom(8);
    const beer = createBeer(w, h, rand, params);
    for (let i = 0; i < 240; i++) stepBeer(beer, params, rand, 1 / 24);
    renderBeer(beer, params);
    return beer;
  };

  const rowMean = (beer: Beer, v: number) => {
    const j = Math.min(beer.h - 1, Math.max(0, Math.round(v * (beer.h - 1))));
    let total = 0;
    for (let i = 0; i < beer.w; i++) total += beer.field[j * beer.w + i];
    return total / beer.w;
  };

  it('stays inside the range the shading expects', () => {
    const beer = settled();
    for (const value of beer.field) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('stacks air, foam and beer in that order', () => {
    const beer = settled();
    const air = rowMean(beer, 0.1);
    const foam = rowMean(beer, 1 - FLAT.fill - 0.02);
    const liquid = rowMean(beer, 0.6);

    expect(air).toBe(0);
    expect(foam).toBeGreaterThan(liquid);
    expect(liquid).toBeGreaterThan(0);
  });

  it('fills to the level it was asked for', () => {
    // Measured rather than asserted from the parameter: the row where the field
    // first stops being empty is where the beer visibly starts, and it should be
    // the head - a little above the liquid line, never below it.
    const beer = settled();

    let first = beer.h;
    for (let j = 0; j < beer.h && first === beer.h; j++) {
      if (rowMean(beer, j / (beer.h - 1)) > 0.01) first = j;
    }

    const top = first / (beer.h - 1);
    expect(top).toBeLessThan(1 - FLAT.fill);
    expect(top).toBeGreaterThan(1 - FLAT.fill - FLAT.headMax * 1.4);
  });

  it('leaves the glass dark when it is poured to nothing', () => {
    // All but the last row. The liquid line's ramp is centred on the line
    // itself, so at a fill of zero the bottom half of that ramp is off the
    // bottom edge and the last row keeps the top half of it - a sliver of
    // meniscus at the very base of the glass, which is what an empty one has.
    const beer = settled({ ...FLAT, fill: 0, rate: 0 });
    for (let j = 0; j < beer.h - 1; j++) {
      for (let i = 0; i < beer.w; i++) expect(beer.field[j * beer.w + i]).toBe(0);
    }
  });

  it('shows a bubble as brighter than the beer around it', () => {
    const params: BeerParams = { ...FLAT, rate: 0 };
    const beer = empty(params);
    beer.bubbles.push(bubble(1, 0.7, 0.05));
    renderBeer(beer, params);

    const [spanX, spanY] = cellSpansOf(beer);
    const at = (x: number, y: number) => beer.field[Math.round(y / spanY) * beer.w + Math.round(x / spanX)];

    expect(at(1, 0.7)).toBeGreaterThan(at(1.5, 0.7) + 0.1);
  });

  it('lights a bubble the same whether it sits in the surface band or below it', () => {
    // The renderer takes two different routes to a bubble - per-cell inside
    // the surface band, box-applied below it - and a viewer must not be able
    // to tell which one drew it. Same glass, same bubble, twice: the second
    // render drags the band down over the bubble by spiking the surface in a
    // far-away column, because the band is a set of *rows* shared by every
    // column. Every cell of the bubble has to come out identical.
    const params: BeerParams = { ...FLAT, rate: 0, depthFade: 0 };
    const one = empty(params);
    one.bubbles.push(bubble(1, 0.7, 0.04));
    renderBeer(one, params);
    const below = one.field.slice();

    // The spike is at x = 0, half the glass away from the bubble at x = 1, so
    // nothing about the bubble's own surroundings changes - only the route.
    one.wave[0] = 0.5;
    renderBeer(one, params);

    const [spanX, spanY] = cellSpansOf(one);
    const j = Math.round(0.7 / spanY);
    const i = Math.round(1 / spanX);
    for (const [dj, di] of [
      [0, 0],
      [0, 2],
      [-1, 0],
      [1, -2],
    ]) {
      const k = (j + dj) * one.w + (i + di);
      expect(one.field[k]).toBeCloseTo(below[k], 6);
    }
  });

  it('darkens with depth, so the glass has a bottom to it', () => {
    const params: BeerParams = { ...FLAT, rate: 0 };
    const beer = empty(params);
    renderBeer(beer, params);

    expect(rowMean(beer, 0.99)).toBeLessThan(rowMean(beer, 1 - params.fill + 0.05));
  });

  it('paints no bubble above the surface, where it would have burst', () => {
    const params: BeerParams = { ...FLAT, rate: 0 };
    const beer = empty(params);
    // Placed in mid-air on purpose. `popBubbles` would have taken it; the
    // renderer must not draw it in the meantime either.
    beer.bubbles.push(bubble(1, 0.1, 0.05));
    renderBeer(beer, params);

    expect(rowMean(beer, 0.1)).toBe(0);
  });

  it('draws the same picture twice in a row', () => {
    // The renderer clears its accumulation box-by-box as it consumes it, and
    // this is the test that the bookkeeping balances: a leftover from frame N
    // would brighten frame N+1.
    const beer = settled();
    const first = beer.field.slice();
    renderBeer(beer, FLAT);
    expect(beer.field).toEqual(first);
  });
});

describe('a resize', () => {
  it('carries the glass over rather than pouring a fresh one', () => {
    const rand = makeRandom(6);
    const before = createBeer(W, H, rand, BEER_DEFAULTS);
    for (let i = 0; i < 120; i++) stepBeer(before, BEER_DEFAULTS, rand, 1 / 24);

    const after = createBeer(W * 2, H * 2, rand, BEER_DEFAULTS);
    carryBeer(before, after);

    expect(after.bubbles).toBe(before.bubbles);
    expect(after.time).toBe(before.time);
  });

  it('resamples the head onto the new columns, keeping roughly the same foam', () => {
    const rand = makeRandom(6);
    const before = createBeer(W, H, rand, BEER_DEFAULTS);
    for (let i = 0; i < 240; i++) stepBeer(before, BEER_DEFAULTS, rand, 1 / 24);

    const after = createBeer(W * 3, H * 3, rand, BEER_DEFAULTS);
    carryBeer(before, after);

    expect(headVolume(after)).toBeCloseTo(headVolume(before), 2);
    expect(headAt(after, 1)).toBeCloseTo(headAt(before, 1), 3);
  });

  it('carries the waves too, so a slosh survives a window drag', () => {
    const before = empty(FLAT);
    const [spanX] = cellSpansOf(before);
    for (let i = 0; i < before.w; i++) before.wave[i] = -0.02 * Math.cos((Math.PI * i * spanX) / aspectOf(before));

    const after = empty(FLAT, W * 2, H * 2);
    carryBeer(before, after);

    for (const x of [0.2, 0.9, 1.5]) {
      expect(surfaceAt(after, FLAT, x)).toBeCloseTo(surfaceAt(before, FLAT, x), 3);
    }
  });
});

describe('glasses that are barely glasses', () => {
  // The guards all over this file are for fields with no width to speak of,
  // steps with no time in them, and parameters turned to zero. None of it is
  // reachable through the mount - `planSurface` never hands over fewer than
  // two cells an axis - but every one of these is a public function, and a
  // guard nothing exercises is a guess.

  it('reads a head and a surface off a single-column glass', () => {
    const beer = empty(FLAT, 1, 4);
    beer.head[0] = 0.05;

    expect(headAt(beer, 0)).toBeCloseTo(0.05, 7);
    expect(headAt(beer, 99)).toBeCloseTo(0.05, 7);
    expect(surfaceAt(beer, FLAT, 0.5)).toBeCloseTo(1 - FLAT.fill, 6);
    expect(headVolume(beer)).toBeCloseTo(0.05, 7);
  });

  it('reads nothing off a glass with no columns at all', () => {
    const beer = empty(FLAT, 0, 4);
    expect(headAt(beer, 0)).toBe(0);
    expect(headVolume(beer)).toBe(0);
  });

  it('samples the left wall for a point outside it', () => {
    const beer = empty(FLAT);
    beer.head[0] = 0.07;
    expect(headAt(beer, -5)).toBeCloseTo(0.07, 7);
  });

  it('steps a single-column glass without dividing by its width', () => {
    const params = { ...BEER_DEFAULTS, maxBubbles: 3 };
    const rand = makeRandom(2);
    const beer = createBeer(1, 6, rand, params);
    beer.bubbles.push(bubble(0, 1 - params.fill + 0.01, 0.02));

    expect(() => {
      for (let i = 0; i < 20; i++) stepBeer(beer, params, rand, 1 / 24);
      renderBeer(beer, params);
    }).not.toThrow();

    for (const v of beer.field) expect(Number.isFinite(v)).toBe(true);
    // A pop still leaves its foam, in the only column there is.
    expect(beer.head[0]).toBeGreaterThan(0);
  });

  it('does nothing to the waves on a step with no time in it', () => {
    const beer = empty(FLAT);
    beer.wave[4] = -0.02;
    beer.waveV[4] = 0.5;

    stepWaves(beer, FLAT, 0);
    stepWaves(beer, FLAT, -1);

    expect(beer.wave[4]).toBeCloseTo(-0.02, 9);
    expect(beer.waveV[4]).toBeCloseTo(0.5, 9);
  });

  it('does nothing to the waves when the wave speed is zero', () => {
    const still: BeerParams = { ...FLAT, waveSpeed: 0 };
    const beer = empty(still);
    beer.wave[4] = -0.02;

    stepWaves(beer, still, 1 / 24);

    expect(beer.wave[4]).toBeCloseTo(-0.02, 9);
  });

  it('leaves a one-column glass with nowhere for a wave to go', () => {
    const beer = empty(FLAT, 1, 4);
    beer.waveV[0] = 1;
    stepWaves(beer, FLAT, 1 / 24);
    expect(beer.wave[0]).toBe(0);
  });

  it('does nothing on a stir with no reach', () => {
    const params: BeerParams = { ...FLAT, stirReach: 0 };
    const beer = empty(params);
    beer.bubbles.push(bubble(1, 1 - params.fill + 0.05, 0.02));

    stirBubbles(beer, params, [stir(1, 1 - params.fill + 0.05, 2)], 1 / 24, 0.55);

    for (const v of beer.waveV) expect(v).toBe(0);
  });

  it('does nothing on a stir with no life left to it', () => {
    const beer = empty(FLAT);
    const caught = bubble(1, 0.8, 0.02);
    beer.bubbles.push(caught);

    stirBubbles(beer, FLAT, [stir(1, 0.8, 2)], 1 / 24, 0);

    expect(caught.vx).toBe(0);
  });

  it('ploughs nothing into the column exactly a reach away', () => {
    // The bow wave walks whole columns from `ceil` to `floor` of its reach, so
    // an aligned stir puts a column at exactly the radius - where the falloff
    // is zero rather than merely small, this being a compact kernel.
    const beer = empty(FLAT);
    const [spanX] = cellSpansOf(beer);
    const at = 20;
    const columns = 6;
    const params: BeerParams = { ...FLAT, stirReach: columns * spanX };

    stirBubbles(beer, params, [stir(at * spanX, 1 - params.fill + 0.05, 2)], 1 / 24, 0.55);

    expect(beer.waveV[at - columns]).toBe(0);
    expect(beer.waveV[at + columns]).toBe(0);
    expect(beer.waveV[at - columns + 1]).not.toBe(0);
  });

  it('does not drift or settle on a step with no time in it', () => {
    const beer = empty(FLAT);
    const still = bubble(1, 0.8, 0.02, { vx: 1 });
    beer.bubbles.push(still);
    beer.head[3] = 0.05;

    driftBubbles(beer, FLAT, 0);
    settleHead(beer, FLAT, 0);

    expect(still.x).toBe(1);
    expect(still.vx).toBe(1);
    expect(beer.head[3]).toBeCloseTo(0.05, 7);
  });

  it('leaves the head alone when there is no levelling asked for', () => {
    const params: BeerParams = { ...FLAT, spread: 0, drain: 0 };
    const beer = empty(params);
    beer.head[3] = 0.05;

    settleHead(beer, params, 1 / 24);

    expect(beer.head[3]).toBeCloseTo(0.05, 6);
    expect(beer.head[4]).toBe(0);
  });

  it('seeds nothing into a glass whose bubbles cannot rise', () => {
    const beer = createBeer(W, H, makeRandom(3), { ...BEER_DEFAULTS, rise: 0 });
    expect(beer.bubbles).toHaveLength(0);
  });

  it('treats every bubble as mean-sized when the mean is zero', () => {
    // `radius: 0` is a caller saying "no fizz", and the ratios it appears in -
    // the rise law and the splash - must not become NaN and take the frame's
    // arithmetic with them.
    const params: BeerParams = { ...FLAT, radius: 0, splash: 0.2 };
    const beer = empty(params);
    const odd = bubble(1, 1 - params.fill + 0.01, 0.02);
    beer.bubbles.push(odd);

    driftBubbles(beer, params, 1 / 24);
    expect(Number.isFinite(odd.y)).toBe(true);
    expect(odd.y).toBeLessThan(1 - params.fill + 0.01);

    popBubbles(beer, params);
    for (const v of beer.waveV) expect(Number.isFinite(v)).toBe(true);
  });

  it('clamps a bubble hanging over the wall into the columns that exist', () => {
    const beer = empty(FLAT);
    beer.bubbles.push(bubble(0, 1 - FLAT.fill + 0.01, 0.05));
    beer.bubbles.push(bubble(aspectOf(beer), 1 - FLAT.fill + 0.01, 0.05));

    expect(popBubbles(beer, FLAT)).toBe(2);
    expect(beer.head[0]).toBeGreaterThan(0);
    expect(beer.head[beer.w - 1]).toBeGreaterThan(0);
  });

  it('takes a hard-edged bubble, where the ramp has no width to work across', () => {
    // `shoulder: 0` collapses the smoothstep to a step. Classic metaballs, and
    // at five greys a flat silhouette - which is the documented look, so it has
    // to work rather than divide by zero.
    const params: BeerParams = { ...FLAT, shoulder: 0, rate: 0 };
    const beer = empty(params);
    beer.bubbles.push(bubble(1, 0.7, 0.05));
    renderBeer(beer, params);

    const [spanX, spanY] = cellSpansOf(beer);
    const at = (x: number, y: number) => beer.field[Math.round(y / spanY) * beer.w + Math.round(x / spanX)];

    expect(at(1, 0.7)).toBeGreaterThan(at(1.5, 0.7));
    for (const v of beer.field) expect(Number.isFinite(v)).toBe(true);
  });

  it('steps a glass one row tall, where a bubble spans the whole height', () => {
    // `spanY` is zero at a single row, so a bubble's box is the whole column
    // rather than a range around it.
    const params = { ...BEER_DEFAULTS, rate: 0 };
    const beer = empty(params, 8, 1);
    beer.bubbles.push(bubble(0.5, 0.5, 0.05));

    expect(() => renderBeer(beer, params)).not.toThrow();
    for (const v of beer.field) expect(Number.isFinite(v)).toBe(true);
  });

  it('pops into the only column a width-less glass has', () => {
    // Zero columns leaves no span and no aspect either, so the deposit falls
    // back to a whole glass wide and lands nowhere - it must not divide by
    // zero on the way to deciding that.
    const params = { ...FLAT, rate: 0 };
    const beer = empty(params, 0, 4);
    beer.bubbles.push(bubble(0, 1 - params.fill + 0.01, 0.02));

    expect(() => popBubbles(beer, params)).not.toThrow();
    expect(beer.bubbles).toHaveLength(0);
  });

  it('reads a hard-edged ramp as fully outside below its threshold', () => {
    // The zero-width ramp is a step, and both sides of that step have to be
    // reachable: a bubble's own centre is inside it, the beer beside it is not.
    const params: BeerParams = { ...FLAT, shoulder: 0, rate: 0, bubble: 0.5 };
    const beer = empty(params);
    beer.bubbles.push(bubble(1, 0.7, 0.05));
    renderBeer(beer, params);

    const [spanX, spanY] = cellSpansOf(beer);
    const at = (x: number, y: number) => beer.field[Math.round(y / spanY) * beer.w + Math.round(x / spanX)];

    // Just outside the bubble: no bubble brightness at all, only the beer.
    expect(at(1 + 0.08, 0.7)).toBeCloseTo(at(1.5, 0.7), 6);
  });

  it('holds the brightest cell at one, however the levels are dialled', () => {
    // Nothing downstream would break - `shade` clamps too - but the field is
    // public and documented as 0 to 1, so it is clamped where it is written.
    const params: BeerParams = { ...FLAT, liquid: 1, bubble: 1, depthFade: 0, rate: 0 };
    const beer = empty(params);
    beer.bubbles.push(bubble(1, 0.5, 0.06), bubble(1, 0.9, 0.06));
    renderBeer(beer, params);

    let peak = 0;
    for (const v of beer.field) peak = Math.max(peak, v);
    expect(peak).toBe(1);
  });
});

describe('seeding', () => {
  it('opens with the population the loop would have settled at', () => {
    const beer = createBeer(W, H, makeRandom(3), BEER_DEFAULTS);
    const expected = (BEER_DEFAULTS.rate * aspectOf(beer) * BEER_DEFAULTS.fill) / BEER_DEFAULTS.rise;

    expect(beer.bubbles.length).toBeGreaterThan(expected * 0.7);
    expect(beer.bubbles.length).toBeLessThanOrEqual(expected * 1.3);
  });

  it('scatters them through the beer rather than along the bottom', () => {
    const beer = createBeer(W, H, makeRandom(3), BEER_DEFAULTS);
    const depths = beer.bubbles.map((b) => b.y);

    expect(Math.min(...depths)).toBeLessThan(1 - BEER_DEFAULTS.fill * 0.6);
    expect(Math.max(...depths)).toBeGreaterThan(1 - BEER_DEFAULTS.fill * 0.4);
  });

  it('repeats exactly for a given seed', () => {
    const one = createBeer(W, H, makeRandom(5), BEER_DEFAULTS);
    const two = createBeer(W, H, makeRandom(5), BEER_DEFAULTS);

    expect(one.bubbles.map((b) => b.x)).toEqual(two.bubbles.map((b) => b.x));
    expect(one.seed).toBe(two.seed);
  });

  it('adds nothing once the glass is full', () => {
    const params = { ...BEER_DEFAULTS, maxBubbles: 4 };
    const beer = createBeer(W, H, makeRandom(3), params);

    expect(beer.bubbles).toHaveLength(4);
    expect(addBubble(beer, params, makeRandom(3), 1, 1)).toBeNull();
  });
});
