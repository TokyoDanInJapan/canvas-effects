import { describe, expect, it } from 'vitest';

import { makeRandom } from './noise.js';
import {
  METABALL_DEFAULTS,
  ballsAt,
  advanceThrow,
  nearestBall,
  startThrow,
  type BallOverride,
  coverage,
  createMetaballs,
  falloff,
  fieldAt,
  randomizeMetaballs,
  renderMetaballs,
  surface,
  type Ball,
  type Metaballs,
} from './metaballs.js';

const W = 80;
const H = 60;

const seeded = (seed = 13, params = METABALL_DEFAULTS) => createMetaballs(W, H, makeRandom(seed), params);
const ball = (x: number, y: number, radius = 0.3, strength = 1): Ball => ({ x, y, radius, strength });

describe('falloff', () => {
  it('is one at the centre and zero at the radius', () => {
    expect(falloff(0, 0.5)).toBe(1);
    expect(falloff(0.25, 0.5)).toBe(0);
  });

  it('is exactly zero beyond the radius, not merely small', () => {
    // Compact support is what lets each ball be scattered over a bounding box
    // instead of every ball being summed at every cell.
    for (const d of [0.5, 0.9, 3, 100]) expect(falloff(d * d, 0.4)).toBe(0);
  });

  it('falls monotonically', () => {
    let previous = Infinity;
    for (let d = 0; d < 0.4; d += 0.01) {
      const v = falloff(d * d, 0.4);
      expect(v).toBeLessThan(previous);
      previous = v;
    }
  });

  it('meets the radius with a flat tangent, so blends have no crease', () => {
    // The cubic's derivative vanishes at the edge. Numerically: the last step
    // before the radius is far smaller than one in the middle.
    const r = 0.4;
    const step = (d: number) => falloff(d * d, r) - falloff((d + 0.001) * (d + 0.001), r);
    expect(step(0.399)).toBeLessThan(step(0.2) / 10);
  });
});

describe('surface', () => {
  it('is 0 well below the iso value and 1 well above', () => {
    expect(surface(0, METABALL_DEFAULTS)).toBe(0);
    expect(surface(5, METABALL_DEFAULTS)).toBe(1);
  });

  it('passes through a half at the iso value', () => {
    expect(surface(METABALL_DEFAULTS.iso, METABALL_DEFAULTS)).toBeCloseTo(0.5, 6);
  });

  it('rises monotonically across the shoulder', () => {
    const { iso, shoulder } = METABALL_DEFAULTS;
    let previous = -1;
    for (let v = iso - shoulder; v <= iso + shoulder; v += shoulder / 20) {
      const s = surface(v, METABALL_DEFAULTS);
      expect(s).toBeGreaterThanOrEqual(previous);
      previous = s;
    }
  });

  it('collapses to a hard step when the shoulder is zero', () => {
    const hard = { ...METABALL_DEFAULTS, shoulder: 0 };
    expect(surface(METABALL_DEFAULTS.iso - 0.01, hard)).toBe(0);
    expect(surface(METABALL_DEFAULTS.iso + 0.01, hard)).toBe(1);
  });

  it('spreads the rim across several palette levels when the shoulder is wide', () => {
    // Which is the reason for the wide default: a hard edge gives a two-value
    // field and the dither has nothing to do.
    const { iso, shoulder } = METABALL_DEFAULTS;
    const values = new Set<number>();
    for (let v = iso - shoulder; v <= iso + shoulder; v += shoulder / 12) {
      values.add(Math.round(surface(v, METABALL_DEFAULTS) * 4) / 4);
    }
    expect(values.size).toBeGreaterThanOrEqual(4);
  });
});

describe('merging - the whole point', () => {
  it('joins two balls that individually fall short of the surface', () => {
    // Neither ball reaches the iso value at the midpoint on its own; together
    // they cross it. Nothing in the code knows about necks - this is only the
    // sum doing it.
    const gap = 0.34;
    const left = ball(0.5 - gap / 2, 0.5);
    const right = ball(0.5 + gap / 2, 0.5);
    const { iso } = METABALL_DEFAULTS;

    expect(fieldAt([left], 0.5, 0.5)).toBeLessThan(iso);
    expect(fieldAt([right], 0.5, 0.5)).toBeLessThan(iso);
    expect(fieldAt([left, right], 0.5, 0.5)).toBeGreaterThan(iso);
  });

  it('parts again when they separate, with no seam left behind', () => {
    const midpoint = (gap: number) => fieldAt([ball(0.5 - gap / 2, 0.5), ball(0.5 + gap / 2, 0.5)], 0.5, 0.5);

    expect(midpoint(0.2)).toBeGreaterThan(METABALL_DEFAULTS.iso);
    // Beyond the sum of the radii there is nothing between them at all - not a
    // small residue, exactly zero, because the falloff has compact support.
    expect(midpoint(0.62)).toBe(0);
  });

  it('bulges towards a neighbour before touching it', () => {
    // The field between two approaching balls rises smoothly rather than
    // snapping when they meet, which is what makes the join look elastic.
    let previous = -1;
    for (let gap = 0.58; gap > 0.1; gap -= 0.02) {
      const value = fieldAt([ball(0.5 - gap / 2, 0.5), ball(0.5 + gap / 2, 0.5)], 0.5, 0.5);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });
});

describe('ballsAt', () => {
  const state = randomizeMetaballs(makeRandom(4));

  it('is a pure function of time - no accumulated state', () => {
    // The property that lets a frame be drawn at any moment, and the
    // reduced-motion path be a single draw.
    const a: Ball[] = [];
    const b: Ball[] = [];
    ballsAt(12.5, 1.5, METABALL_DEFAULTS, state, a);
    ballsAt(12.5, 1.5, METABALL_DEFAULTS, state, b);
    expect(a).toEqual(b);
  });

  it('moves them over time', () => {
    const a: Ball[] = [];
    const b: Ball[] = [];
    ballsAt(0, 1.5, METABALL_DEFAULTS, state, a);
    ballsAt(6, 1.5, METABALL_DEFAULTS, state, b);
    expect(a).not.toEqual(b);
  });

  it('keeps them inside the field, clear of the edges', () => {
    const aspect = 1.6;
    const out: Ball[] = [];
    for (let t = 0; t < 400; t += 0.7) {
      ballsAt(t, aspect, METABALL_DEFAULTS, state, out);
      for (const b of out) {
        expect(b.x).toBeGreaterThan(0);
        expect(b.x).toBeLessThan(aspect);
        expect(b.y).toBeGreaterThan(0);
        expect(b.y).toBeLessThan(1);
      }
    }
  });

  it('scales positions with the aspect, so blobs stay round', () => {
    // x spans 0..aspect and y spans 0..1, so distance is isotropic. Working in
    // 0..1 on both axes would stretch every blob into an ellipse.
    const narrow: Ball[] = [];
    const wide: Ball[] = [];
    ballsAt(3, 1, METABALL_DEFAULTS, state, narrow);
    ballsAt(3, 2, METABALL_DEFAULTS, state, wide);

    // Same fraction across, twice the extent.
    expect(wide[0].x / 2).toBeCloseTo(narrow[0].x, 6);
    expect(wide[0].y).toBeCloseTo(narrow[0].y, 6);
    expect(wide[0].radius).toBe(narrow[0].radius);
  });

  it('reuses the output array objects across calls', () => {
    // The balls are recomputed every frame for the life of the page, so the
    // array is a scratch buffer like the field: fresh objects on every call
    // would be a small but steady trickle of garbage.
    const out: Ball[] = [];
    ballsAt(1, 1.5, METABALL_DEFAULTS, state, out);
    const first = out[0];
    ballsAt(2, 1.5, METABALL_DEFAULTS, state, out);
    expect(out[0]).toBe(first);
  });

  it('shrinks the output rather than leaving stale balls behind', () => {
    const fewer = randomizeMetaballs(makeRandom(4), { ...METABALL_DEFAULTS, count: 2 });
    const out: Ball[] = [];
    ballsAt(1, 1.5, METABALL_DEFAULTS, state, out);
    expect(out).toHaveLength(METABALL_DEFAULTS.count);
    ballsAt(1, 1.5, METABALL_DEFAULTS, fewer, out);
    expect(out).toHaveLength(2);
  });

  it('does not fall into a short common period', () => {
    // Simple frequency ratios would return the whole set to its starting
    // arrangement on a visible cycle.
    const first: Ball[] = [];
    ballsAt(0, 1.5, METABALL_DEFAULTS, state, first);

    let repeats = 0;
    const later: Ball[] = [];
    for (let t = 1; t < 300; t += 1) {
      ballsAt(t, 1.5, METABALL_DEFAULTS, state, later);
      const same = later.every((b, i) => Math.abs(b.x - first[i].x) < 0.01 && Math.abs(b.y - first[i].y) < 0.01);
      if (same) repeats++;
    }
    expect(repeats).toBe(0);
  });
});

describe('renderMetaballs', () => {
  const render = (m: Metaballs, time = 5, params = METABALL_DEFAULTS) => {
    renderMetaballs(m, params, time);
    return m;
  };

  it('fills the field with values in 0..1', () => {
    const m = render(seeded());
    expect(m.field).toHaveLength(W * H);
    for (const v of m.field) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('draws blobs that cover part of the field but not all of it', () => {
    const c = coverage(render(seeded()));
    expect(c).toBeGreaterThan(0.03);
    expect(c).toBeLessThan(0.85);
  });

  it('agrees with a direct per-cell sum', () => {
    // The scatter-over-bounding-boxes loop is an optimisation, and this is what
    // says it is only that: it must match the naive gather exactly.
    const m = render(seeded(7));
    const aspect = W / H;
    const spanX = aspect / (W - 1);
    const spanY = 1 / (H - 1);

    for (let j = 0; j < H; j += 7) {
      for (let i = 0; i < W; i += 9) {
        const direct = surface(fieldAt(m.balls, i * spanX, j * spanY), METABALL_DEFAULTS);
        expect(m.field[j * W + i]).toBeCloseTo(direct, 6);
      }
    }
  });

  it('is a pure function of time, so it can be drawn at any moment', () => {
    const a = render(seeded(9), 21.25);
    const b = render(seeded(9), 21.25);
    expect(Array.from(a.field)).toEqual(Array.from(b.field));
  });

  it('does not drift when stepped versus jumped to the same time', () => {
    // Statelessness, stated as the thing that actually matters: arriving at t by
    // many small renders must equal arriving there in one.
    const stepped = seeded(9);
    for (let i = 1; i <= 40; i++) renderMetaballs(stepped, METABALL_DEFAULTS, i * 0.25);
    const jumped = render(seeded(9), 10);
    expect(Array.from(stepped.field)).toEqual(Array.from(jumped.field));
  });

  it('leaves cells beyond every ball at exactly zero', () => {
    const m = seeded();
    renderMetaballs(m, { ...METABALL_DEFAULTS, count: 1, radius: 0.1, wander: 0 }, 0);
    // One small ball parked in the middle: the corners must be untouched.
    expect(m.field[0]).toBe(0);
    expect(m.field[W - 1]).toBe(0);
    expect(m.field[(H - 1) * W]).toBe(0);
  });

  it('grows with radius and with count', () => {
    const at = (over: Partial<typeof METABALL_DEFAULTS>) => {
      const params = { ...METABALL_DEFAULTS, ...over };
      const m = createMetaballs(W, H, makeRandom(5), params);
      renderMetaballs(m, params, 5);
      return coverage(m);
    };
    expect(at({ radius: 0.34 })).toBeGreaterThan(at({ radius: 0.18 }));
    expect(at({ count: 12 })).toBeGreaterThan(at({ count: 3 }));
  });

  it('renders blobs round rather than stretched on a wide field', () => {
    // One ball, centred, no motion: its lit extent should measure the same
    // number of *screen* units across as it does down.
    const params = { ...METABALL_DEFAULTS, count: 1, radius: 0.3, wander: 0, iso: 0.5, shoulder: 0.01 };
    const wide = createMetaballs(160, 60, makeRandom(2), params);
    renderMetaballs(wide, params, 0);

    const aspect = 160 / 60;
    let minI = Infinity;
    let maxI = -Infinity;
    let minJ = Infinity;
    let maxJ = -Infinity;
    for (let j = 0; j < 60; j++) {
      for (let i = 0; i < 160; i++) {
        if (wide.field[j * 160 + i] < 0.5) continue;
        minI = Math.min(minI, i);
        maxI = Math.max(maxI, i);
        minJ = Math.min(minJ, j);
        maxJ = Math.max(maxJ, j);
      }
    }
    const widthInHeights = ((maxI - minI) / (160 - 1)) * aspect;
    const heightInHeights = (maxJ - minJ) / (60 - 1);
    expect(widthInHeights).toBeCloseTo(heightInHeights, 1);
  });

  it('survives a degenerate one-cell-wide or one-cell-tall field', () => {
    // The span guards exist for this: a field with a single row or column makes
    // the cell spacing zero, and dividing a bounding box by it would give NaN
    // indices - which, being neither < 0 nor > w, would sail through the clamps.
    for (const [w, h] of [
      [1, 40],
      [40, 1],
      [1, 1],
    ]) {
      const m = createMetaballs(w, h, makeRandom(2));
      renderMetaballs(m, METABALL_DEFAULTS, 3);
      expect(m.field).toHaveLength(w * h);
      for (const v of m.field) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('shows a shaded rim rather than a cut-out at the default shoulder', () => {
    const m = render(seeded());
    const partial = Array.from(m.field).filter((v) => v > 0.02 && v < 0.98).length;
    const solid = Array.from(m.field).filter((v) => v >= 0.98).length;
    // Plenty of the field is mid-tone, which is what the dither works on.
    expect(partial).toBeGreaterThan(solid * 0.2);
  });
});

describe('nearestBall', () => {
  const balls = [ball(0.2, 0.2), ball(1.0, 0.5), ball(0.3, 0.9)];

  it('finds the closest one', () => {
    expect(nearestBall(balls, 0.25, 0.22, 1)).toBe(0);
    expect(nearestBall(balls, 0.95, 0.55, 1)).toBe(1);
    expect(nearestBall(balls, 0.35, 0.85, 1)).toBe(2);
  });

  it('returns -1 when nothing is within reach', () => {
    // A press in empty space should take hold of nothing rather than yanking a
    // blob in from the far side of the screen.
    expect(nearestBall(balls, 5, 5, 0.4)).toBe(-1);
  });

  it('measures isotropically, so a press does not favour the horizontal', () => {
    // Balls live in height units - x spans 0..aspect - so this is a plain
    // Euclidean distance and equal screen distances weigh the same.
    const two = [ball(0.5, 0.5)];
    const across = nearestBall(two, 0.5 + 0.3, 0.5, 0.35);
    const down = nearestBall(two, 0.5, 0.5 + 0.3, 0.35);
    expect(across).toBe(0);
    expect(down).toBe(0);
    expect(nearestBall(two, 0.5 + 0.4, 0.5, 0.35)).toBe(-1);
    expect(nearestBall(two, 0.5, 0.5 + 0.4, 0.35)).toBe(-1);
  });

  it('copes with no balls at all', () => {
    expect(nearestBall([], 0.5, 0.5, 1)).toBe(-1);
  });
});

describe('grabbing a ball', () => {
  const state = randomizeMetaballs(makeRandom(4));
  const natural = (time: number) => {
    const out: Ball[] = [];
    ballsAt(time, 1.5, METABALL_DEFAULTS, state, out);
    return out;
  };
  const held = (time: number, override: BallOverride) => {
    const out: Ball[] = [];
    ballsAt(time, 1.5, METABALL_DEFAULTS, state, out, override);
    return out;
  };

  it('puts a fully held ball exactly at the pointer', () => {
    const out = held(5, { index: 2, x: 0.7, y: 0.3, weight: 1 });
    expect(out[2].x).toBeCloseTo(0.7, 6);
    expect(out[2].y).toBeCloseTo(0.3, 6);
  });

  it('leaves a fully released ball on its own path', () => {
    const out = held(5, { index: 2, x: 0.7, y: 0.3, weight: 0 });
    expect(out[2].x).toBeCloseTo(natural(5)[2].x, 6);
    expect(out[2].y).toBeCloseTo(natural(5)[2].y, 6);
  });

  it('blends part way through a release', () => {
    const free = natural(5)[2];
    const out = held(5, { index: 2, x: 0.7, y: 0.3, weight: 0.5 });
    expect(out[2].x).toBeCloseTo(free.x + (0.7 - free.x) * 0.5, 6);
    expect(out[2].y).toBeCloseTo(free.y + (0.3 - free.y) * 0.5, 6);
  });

  it('eases onto a moving target, which is the whole point of the blend', () => {
    // A ball's natural position keeps moving while it is held, so a release has
    // to converge on a target that is itself still travelling. Held at a fixed
    // point and decaying the weight, the gap to the free position must shrink
    // even though that free position is different at every step.
    const grip = { index: 2, x: 0.7, y: 0.3 };
    let previousGap = Infinity;

    for (let i = 0; i <= 8; i++) {
      const time = 5 + i * 0.4;
      const weight = 1 - i / 8;
      const free = natural(time)[2];
      const now = held(time, { ...grip, weight })[2];
      const gap = Math.hypot(now.x - free.x, now.y - free.y);
      expect(gap).toBeLessThanOrEqual(previousGap + 1e-9);
      previousGap = gap;
    }
    expect(previousGap).toBeCloseTo(0, 6);
  });

  it('leaves every other ball alone', () => {
    const free = natural(5);
    const out = held(5, { index: 2, x: 0.7, y: 0.3, weight: 1 });
    for (let i = 0; i < out.length; i++) {
      if (i === 2) continue;
      expect(out[i].x).toBeCloseTo(free[i].x, 6);
      expect(out[i].y).toBeCloseTo(free[i].y, 6);
    }
  });

  it('ignores an index that is not a ball', () => {
    for (const index of [-1, 99]) {
      const out = held(5, { index, x: 0.7, y: 0.3, weight: 1 });
      const free = natural(5);
      for (let i = 0; i < out.length; i++) expect(out[i].x).toBeCloseTo(free[i].x, 6);
    }
  });

  it('clamps a weight above 1 rather than overshooting past the pointer', () => {
    const out = held(5, { index: 2, x: 0.7, y: 0.3, weight: 4 });
    expect(out[2].x).toBeCloseTo(0.7, 6);
  });

  it('keeps its radius and strength while held', () => {
    const out = held(5, { index: 2, x: 0.7, y: 0.3, weight: 1 });
    expect(out[2].radius).toBe(natural(5)[2].radius);
    expect(out[2].strength).toBe(natural(5)[2].strength);
  });

  describe('through the render', () => {
    it('changes nothing when nothing is held', () => {
      const a = seeded(11);
      renderMetaballs(a, METABALL_DEFAULTS, 4);
      const b = seeded(11);
      renderMetaballs(b, METABALL_DEFAULTS, 4, null);
      expect(Array.from(b.field)).toEqual(Array.from(a.field));
    });

    it('moves the blob when one is held', () => {
      const plain = seeded(11);
      renderMetaballs(plain, METABALL_DEFAULTS, 4);
      const dragged = seeded(11);
      renderMetaballs(dragged, METABALL_DEFAULTS, 4, { index: 1, x: 0.4, y: 0.5, weight: 1 });
      expect(Array.from(dragged.field)).not.toEqual(Array.from(plain.field));
    });

    it('still merges while held - dragging one into another fuses them', () => {
      // The reason this interaction suits metaballs at all: a dragged ball is
      // just another contribution to the sum, so it reaches for its neighbours
      // exactly as the others do.
      const m = seeded(11);
      renderMetaballs(m, METABALL_DEFAULTS, 4);
      const target = m.balls[0];

      // Drop ball 1 close beside ball 0 and check the midpoint crosses the iso.
      const near = { index: 1, x: target.x + 0.2, y: target.y, weight: 1 };
      renderMetaballs(m, METABALL_DEFAULTS, 4, near);
      const midpoint = fieldAt(m.balls, target.x + 0.1, target.y);
      expect(midpoint).toBeGreaterThan(METABALL_DEFAULTS.iso);
    });

    it('keeps the field inside 0..1 while held', () => {
      const m = seeded(11);
      renderMetaballs(m, METABALL_DEFAULTS, 4, { index: 0, x: 0.5, y: 0.5, weight: 1 });
      for (const v of m.field) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });
  });
});

describe('throwing a released ball', () => {
  const params = METABALL_DEFAULTS;

  describe('startThrow', () => {
    it('keeps a modest velocity as given', () => {
      const t = startThrow(0.5, 0.5, 0.4, -0.3, params);
      expect(t.vx).toBeCloseTo(0.4, 6);
      expect(t.vy).toBeCloseTo(-0.3, 6);
    });

    it('caps a hard flick without changing its direction', () => {
      // Unclamped, a flick hands over many screen heights a second and the ball
      // is gone before the blend can reel it back.
      const t = startThrow(0.5, 0.5, 30, 40, params);
      expect(Math.hypot(t.vx, t.vy)).toBeCloseTo(params.throwMaxSpeed, 6);
      // 3:4 in, 3:4 out.
      expect(t.vx / t.vy).toBeCloseTo(30 / 40, 6);
    });

    it('copes with no velocity at all', () => {
      const t = startThrow(0.5, 0.5, 0, 0, params);
      expect(t.vx).toBe(0);
      expect(t.vy).toBe(0);
    });
  });

  describe('advanceThrow', () => {
    it('carries the ball along its velocity', () => {
      const t = startThrow(0.5, 0.5, 1, 0, params);
      advanceThrow(t, params, 0.1, 1.8);
      expect(t.x).toBeGreaterThan(0.5);
      expect(t.y).toBeCloseTo(0.5, 6);
    });

    it('bleeds the speed off', () => {
      const t = startThrow(0.5, 0.5, 1, 0, params);
      advanceThrow(t, params, 0.25, 1.8);
      expect(t.vx).toBeLessThan(1);
      expect(t.vx).toBeGreaterThan(0);
    });

    it('damps frame-rate independently', () => {
      // Exponential, not a flat subtraction: two half-steps must leave the same
      // speed as one whole one, or the throw would behave differently at 24fps
      // and 60fps.
      const coarse = startThrow(0.5, 0.5, 1, 0, params);
      advanceThrow(coarse, params, 0.2, 1.8);

      const fine = startThrow(0.5, 0.5, 1, 0, params);
      advanceThrow(fine, params, 0.1, 1.8);
      advanceThrow(fine, params, 0.1, 1.8);

      expect(fine.vx).toBeCloseTo(coarse.vx, 9);
    });

    it('comes to a stop rather than drifting forever', () => {
      const t = startThrow(0.5, 0.5, 2, 0, params);
      for (let i = 0; i < 200; i++) advanceThrow(t, params, 1 / 60, 1.8);
      expect(Math.hypot(t.vx, t.vy)).toBeLessThan(0.001);
    });

    it('stays on screen, sliding along an edge rather than leaving', () => {
      const aspect = 1.8;
      const t = startThrow(0.1, 0.1, -5, -5, params);
      for (let i = 0; i < 60; i++) advanceThrow(t, params, 1 / 60, aspect);
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeGreaterThanOrEqual(0);

      const far = startThrow(aspect - 0.1, 0.9, 5, 5, params);
      for (let i = 0; i < 60; i++) advanceThrow(far, params, 1 / 60, aspect);
      expect(far.x).toBeLessThanOrEqual(aspect);
      expect(far.y).toBeLessThanOrEqual(1);
    });

    it('goes further for a harder throw', () => {
      const distance = (speed: number) => {
        const t = startThrow(0.9, 0.5, speed, 0, params);
        for (let i = 0; i < 30; i++) advanceThrow(t, params, 1 / 60, 4);
        return t.x - 0.9;
      };
      expect(distance(2)).toBeGreaterThan(distance(0.4));
    });

    it('stays put when it was not thrown', () => {
      const t = startThrow(0.6, 0.4, 0, 0, params);
      for (let i = 0; i < 30; i++) advanceThrow(t, params, 1 / 60, 1.8);
      expect(t.x).toBeCloseTo(0.6, 9);
      expect(t.y).toBeCloseTo(0.4, 9);
    });
  });
});
