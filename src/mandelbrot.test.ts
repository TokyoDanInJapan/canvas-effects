import { describe, expect, it } from 'vitest';

import { makeRandom } from './noise.js';
import {
  MANDELBROT_DEFAULTS,
  aimAt,
  brightnessAt,
  cellToComplex,
  createMandelbrot,
  escapeAt,
  iterationsFor,
  patchAt,
  randomizeMandelbrot,
  renderMandelbrot,
  stepMandelbrot,
  type Mandelbrot,
  type MandelbrotParams,
} from './mandelbrot.js';

const W = 96;
const H = 64;
const params = MANDELBROT_DEFAULTS;

const seeded = (seed = 4, over: Partial<MandelbrotParams> = {}): Mandelbrot => {
  const p = { ...params, ...over };
  const m = createMandelbrot(W, H, makeRandom(seed), p);
  renderMandelbrot(m, p);
  return m;
};

/** What fraction of the frame the escape count could not tell from interior. */
const solidFraction = (m: Mandelbrot) => {
  let count = 0;
  for (const flag of m.inside) count += flag;
  return count / m.inside.length;
};

const spread = (field: Float32Array) => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of field) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo;
};

describe('escapeAt', () => {
  it('calls the obvious members of the set members', () => {
    // The origin, the centre of the period-2 bulb, and a point well inside the
    // main cardioid. All three are in the set for any budget at all.
    expect(escapeAt(0, 0, 500)).toBe(Infinity);
    expect(escapeAt(-1, 0, 500)).toBe(Infinity);
    expect(escapeAt(-0.2, 0.1, 500)).toBe(Infinity);
  });

  it('calls the obvious non-members non-members', () => {
    expect(escapeAt(2, 2, 500)).toBeLessThan(5);
    expect(escapeAt(-3, 0, 500)).toBeLessThan(5);
    expect(escapeAt(0.4, 0.4, 500)).toBeLessThan(30);
  });

  it('agrees with the iteration where the closed-form interior tests short-circuit', () => {
    // The cardioid and bulb tests exist to skip the loop for most of the set by
    // area. They are only worth having if they never disagree with it - a false
    // positive is a black patch where there should be a picture.
    for (let i = 0; i < 400; i++) {
      const cx = -2.2 + (i % 20) * 0.145;
      const cy = -1.2 + Math.floor(i / 20) * 0.12;
      const dx = cx - 0.25;
      const q = dx * dx + cy * cy;
      const inCardioid = q * (q + dx) <= 0.25 * cy * cy;
      const inBulb = (cx + 1) * (cx + 1) + cy * cy <= 0.0625;
      if (!inCardioid && !inBulb) continue;
      // 4,000 iterations is not proof, but a point the shortcut claims is
      // interior and that escapes would show up at a fraction of that.
      expect(escapeAt(cx, cy, 4000)).toBe(Infinity);
    }
  });

  it('is continuous across the bailout, which is what the smooth count is for', () => {
    // The whole picture is built on the *gradient* of this. An integer count
    // would step by a whole unit at each band boundary; the smooth one has to
    // cross a band without a jump, or every band edge reads as a boundary.
    let worst = 0;
    let previous = escapeAt(-0.75, 0.0999, 500);
    for (let i = 1; i <= 2000; i++) {
      const value = escapeAt(-0.75, 0.0999 + i * 1e-5, 500);
      if (value === Infinity || previous === Infinity) {
        previous = value;
        continue;
      }
      worst = Math.max(worst, Math.abs(value - previous));
      previous = value;
    }
    // A whole unit would be an integer count's step. This stays far below it.
    expect(worst).toBeLessThan(0.2);
  });

  it('spends no more than the budget', () => {
    // The count can exceed the budget slightly - the smooth term is added after
    // the loop - but not by more than the width of the escape annulus.
    for (let i = 0; i < 200; i++) {
      const value = escapeAt(-0.5 + i * 0.004, 0.6, 40);
      if (value !== Infinity) expect(value).toBeLessThan(41);
    }
  });
});

describe('iterationsFor', () => {
  it('spends the base budget at the home view', () => {
    expect(iterationsFor(params.homeSpan, params)).toBe(params.iterations);
  });

  it('adds its per-doubling allowance as it descends', () => {
    expect(iterationsFor(params.homeSpan / 2, params)).toBe(params.iterations + params.iterationsPerDoubling);
    expect(iterationsFor(params.homeSpan / 16, params)).toBe(params.iterations + 4 * params.iterationsPerDoubling);
  });

  it('never exceeds the ceiling, which is what the frame budget is', () => {
    expect(iterationsFor(params.minSpan, params)).toBeLessThanOrEqual(params.maxIterations);
    expect(iterationsFor(1e-300, params)).toBe(params.maxIterations);
  });

  it('does not go below the base above the home view', () => {
    expect(iterationsFor(params.homeSpan * 4, params)).toBe(params.iterations);
  });
});

describe('brightnessAt', () => {
  it('stays inside 0..1 across everything it will ever be handed', () => {
    for (const distance of [0, 0.01, 0.5, 1, 4, 40, 1e9]) {
      for (const escape of [0, 3.5, 90, 299.9]) {
        const value = brightnessAt(distance, escape, params);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is brightest on the boundary and fades away from it', () => {
    const bare = { ...params, bands: 0 };
    expect(brightnessAt(0, 50, bare)).toBe(1);
    let previous = 1;
    for (const distance of [0.5, 1, 2, 4, 8, 32]) {
      const value = brightnessAt(distance, 50, bare);
      expect(value).toBeLessThan(previous);
      previous = value;
    }
    expect(previous).toBeLessThan(0.15);
  });

  it('fades the contours out where they would alias rather than where they look busy', () => {
    // Contours repeat every `bandWidth` iterations and the count changes by
    // `1 / (ln2 * d)` per cell, so below about `2 / (bandWidth * ln2)` cells
    // they are finer than the sampling. Taking them out there is the difference
    // between texture and noise.
    const near = brightnessAt(0.05, 0, params) - brightnessAt(0.05, params.bandWidth / 2, params);
    const far = brightnessAt(20, 0, params) - brightnessAt(20, params.bandWidth / 2, params);
    expect(Math.abs(near)).toBeLessThan(0.02);
    expect(Math.abs(far)).toBeGreaterThan(0.2);
  });

  it('leaves only the glow when the contours are off', () => {
    const bare = { ...params, bands: 0 };
    expect(brightnessAt(3, 17, bare)).toBeCloseTo(params.glow / (3 + params.glow), 10);
  });
});

describe('renderMandelbrot', () => {
  it('fills the field with values a palette can take', () => {
    const m = seeded();
    for (const v of m.field) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('draws the set at the home view rather than a flat rectangle', () => {
    const m = seeded();
    expect(spread(m.field)).toBeGreaterThan(0.5);
    // The set covers a real fraction of the home view and nothing like all of it.
    expect(solidFraction(m)).toBeGreaterThan(0.05);
    expect(solidFraction(m)).toBeLessThan(0.4);
  });

  it('puts the set where the set is', () => {
    const m = seeded();
    const at = (x: number, y: number) => m.inside[Math.round(y * (H - 1)) * W + Math.round(x * (W - 1))];
    const centre = cellFor(m, -0.2, 0);
    const outside = cellFor(m, -1.9, 0.9);
    expect(m.inside[centre]).toBe(1);
    expect(m.inside[outside]).toBe(0);
    // A corner of the home view is a long way outside it.
    expect(at(0, 0)).toBe(0);
  });

  it('darkens the interior and lights the boundary', () => {
    // The tonal decision the whole effect rests on: the set is a silhouette and
    // the boundary is what glows, so the picture modulates a page rather than
    // becoming one.
    const m = seeded();
    const interior = m.field[cellFor(m, -0.2, 0)];
    const boundary = m.field[cellFor(m, -0.7435, 0.1318)];
    const empty = m.field[cellFor(m, -2.05, 1.1)];
    expect(interior).toBe(0);
    expect(boundary).toBeGreaterThan(empty);
    expect(boundary).toBeGreaterThan(0.4);
  });

  it('measures distance in cells, so halving the cell doubles it', () => {
    // The claim the whole effect rests on. Shading on escape count alone would
    // crowd the bands together without limit as the view descends; shading on a
    // distance measured in *cells* cannot, because the cell shrinks with the
    // view.
    //
    // Square fields, so the aspect is 1 in both and cell (2i, 2j) of the fine
    // grid samples exactly the complex point cell (i, j) of the coarse one
    // does. Same view, same escape counts, half the cell - so the distance
    // reported in cells should be twice.
    const N = 65;
    const coarse = createMandelbrot(N, N, makeRandom(1), params);
    const fine = createMandelbrot(2 * N - 1, 2 * N - 1, makeRandom(1), params);
    renderMandelbrot(coarse, params);
    renderMandelbrot(fine, params);

    const ratios: number[] = [];
    for (let j = 4; j < N - 4; j += 3) {
      for (let i = 4; i < N - 4; i += 3) {
        const near = coarse.distance[j * N + i];
        // Away from the boundary and away from the flat far field, where the
        // finite difference is measuring something either way.
        if (coarse.inside[j * N + i] || near < 2 || near > 1e8) continue;
        ratios.push(fine.distance[2 * j * (2 * N - 1) + 2 * i] / near);
      }
    }

    expect(ratios.length).toBeGreaterThan(50);
    for (const ratio of ratios) expect(ratio).toBeGreaterThan(1.9);
    const median = ratios.sort((a, b) => a - b)[ratios.length >> 1];
    expect(median).toBeCloseTo(2, 1);
  });

  it('uses the whole palette at every magnification', () => {
    // What the previous test buys, stated as a picture. The field runs the full
    // 0..1 at the home view and sixteen doublings down alike, so descending
    // neither washes the effect out nor fills it in.
    for (const doublings of [0, 8, 16]) {
      const m = seeded();
      m.state.cx = -0.743643887037151;
      m.state.cy = 0.13182590420533;
      m.state.span = params.homeSpan / Math.pow(2, doublings);
      renderMandelbrot(m, params);
      expect(spread(m.field), `${doublings} doublings`).toBeGreaterThan(0.9);
    }
  });

  it('holds the aspect, so a wide field is not a stretched set', () => {
    const wide = createMandelbrot(120, 40, makeRandom(1), params);
    renderMandelbrot(wide, params);
    const scratch = new Float64Array(2);
    cellToComplex(wide, 119, 20, scratch);
    // Half the width either side of the centre, and the width is the height
    // times the aspect.
    expect(scratch[0] - wide.state.cx).toBeCloseTo((params.homeSpan * (120 / 40)) / 2, 10);
  });
});

describe('cellToComplex', () => {
  it('agrees with the coordinates the render loop walks', () => {
    // The render loop steps a running coordinate for speed; this recomputes one
    // from scratch. They have to be the same mapping or the autopilot aims at a
    // different point from the one it scored.
    const m = seeded();
    const scratch = new Float64Array(2);
    cellToComplex(m, 0, 0, scratch);
    expect(scratch[0]).toBeCloseTo(m.state.cx - (params.homeSpan * (W / H)) / 2, 10);
    expect(scratch[1]).toBeCloseTo(m.state.cy - params.homeSpan / 2, 10);
    cellToComplex(m, W - 1, H - 1, scratch);
    expect(scratch[0]).toBeCloseTo(m.state.cx + (params.homeSpan * (W / H)) / 2, 10);
    expect(scratch[1]).toBeCloseTo(m.state.cy + params.homeSpan / 2, 10);
  });
});

describe('patchAt', () => {
  it('calls a patch of open interior solid and flat', () => {
    const m = seeded();
    const out = new Float64Array(2);
    patchAt(m, ...cellXY(m, -0.2, 0), out);
    expect(out[1]).toBe(1);
    expect(out[0]).toBe(0);
  });

  it('finds variety at the boundary and none far from it', () => {
    const m = seeded();
    const boundary = new Float64Array(2);
    const empty = new Float64Array(2);
    patchAt(m, ...cellXY(m, -0.7435, 0.1318), boundary);
    patchAt(m, ...cellXY(m, -2.05, 1.15), empty);
    expect(boundary[0]).toBeGreaterThan(empty[0]);
  });
});

describe('aimAt', () => {
  it('lands somewhere the picture has something', () => {
    const m = seeded();
    expect(aimAt(m, params, (W - 1) / 2, (H - 1) / 2)).toBe(true);
    // Inside the view it was chosen from, and not in the middle of a lake.
    const spanX = params.homeSpan * (W / H);
    expect(Math.abs(m.aim[0] - m.state.cx)).toBeLessThanOrEqual(spanX / 2 + 1e-9);
    expect(Math.abs(m.aim[1] - m.state.cy)).toBeLessThanOrEqual(params.homeSpan / 2 + 1e-9);
    expect(escapeAt(m.aim[0], m.aim[1], iterationsFor(m.state.span, params))).not.toBe(Infinity);
  });

  it('prefers what it is pointed at', () => {
    const m = seeded();
    aimAt(m, params, (W - 1) * 0.15, (H - 1) * 0.15);
    const upperLeft = [m.aim[0], m.aim[1]];
    aimAt(m, params, (W - 1) * 0.85, (H - 1) * 0.85);
    expect(m.aim[0]).toBeGreaterThan(upperLeft[0]);
    expect(m.aim[1]).toBeGreaterThan(upperLeft[1]);
  });

  it('gives up rather than aiming into a void', () => {
    // Deep inside the set: every cell interior, nothing to steer towards. The
    // caller's cue to turn round, and the reason a run cannot get stuck
    // magnifying a black rectangle.
    const m = seeded();
    m.state.cx = -0.2;
    m.state.cy = 0;
    m.state.span = 1e-4;
    renderMandelbrot(m, params);
    expect(solidFraction(m)).toBe(1);
    expect(aimAt(m, params, (W - 1) / 2, (H - 1) / 2)).toBe(false);
  });

  it('looks past its reach rather than failing, when the filigree is off to one side', () => {
    const m = seeded();
    // Pointed at a corner of the home view, which is empty exterior for a long
    // way in every direction it is allowed to look first.
    expect(aimAt(m, { ...params, aimReach: 0.05 }, 0, 0)).toBe(true);
  });
});

describe('stepMandelbrot', () => {
  const fly = (m: Mandelbrot, seconds: number, p: MandelbrotParams = params, dt = 1 / 24) => {
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      stepMandelbrot(m, p, dt);
      renderMandelbrot(m, p);
    }
  };

  /**
   * Steps until `done`, and fails rather than spins if the cycle never gets
   * there. Bounded on purpose: every one of these waits on a phase of the
   * cycle, and a phase that never arrives is the bug being tested for.
   */
  const until = (m: Mandelbrot, p: MandelbrotParams, done: () => boolean, limit = 3000): void => {
    for (let i = 0; i < limit; i++) {
      stepMandelbrot(m, p, 1 / 24);
      if (done()) return;
    }
    throw new Error(`never got there in ${limit} frames`);
  };

  it('starts at the whole set, which is the still frame reduced motion gets', () => {
    const state = randomizeMandelbrot(makeRandom(2), params);
    expect(state.span).toBe(params.homeSpan);
    expect(state.cx).toBe(params.homeX);
    expect(state.direction).toBe(-1);
  });

  it('magnifies at the rate it says it does', () => {
    const m = seeded();
    // One second at half a doubling a second is a factor of the square root of
    // two, whatever the frame rate chops it into.
    fly(m, 1);
    expect(params.homeSpan / m.state.span).toBeCloseTo(Math.SQRT2, 2);
  });

  it('turns round at the precision floor rather than past it', () => {
    // Past `minSpan` neighbouring cells land on the same double and the picture
    // goes blocky, so this is a limit of the arithmetic and not of taste.
    const fast = { ...params, speed: 20 };
    const m = seeded(4, fast);
    until(m, fast, () => m.state.direction > 0);
    expect(m.state.span).toBeGreaterThanOrEqual(params.minSpan);
  });

  it('comes back to the home view exactly, framed and centred', () => {
    const fast = { ...params, speed: 20, dwell: 0 };
    const m = seeded(4, fast);
    until(m, fast, () => m.state.direction > 0);
    until(m, fast, () => m.state.direction < 0);
    expect(m.state.span).toBe(params.homeSpan);
    expect(m.state.cx).toBe(params.homeX);
    expect(m.state.cy).toBe(params.homeY);
  });

  it('does not jump when it turns', () => {
    // The pull-out is a function of the span rather than an ease of its own,
    // and this is the property that buys: it is exactly where it turned round
    // at the moment it turns round.
    const fast = { ...params, speed: 20, dwell: 0 };
    const m = seeded(4, fast);
    until(m, fast, () => m.state.direction > 0);
    const [wasX, wasY] = [m.state.cx, m.state.cy];
    stepMandelbrot(m, fast, 1 / 24);
    // A step of the pull-out moves the centre by a fraction of the span it is
    // at, not by a fraction of the home span.
    expect(Math.hypot(m.state.cx - wasX, m.state.cy - wasY)).toBeLessThan(m.state.span);
  });

  it('keeps the point it left at a fixed place on screen while it pulls out', () => {
    // What stops the pull-out reading as an enormous sideways pan. The deep
    // point sits still in screen units for all but the last instant of it.
    const fast = { ...params, speed: 20, dwell: 0 };
    const m = seeded(4, fast);
    until(m, fast, () => m.state.direction > 0);

    const offsets: number[] = [];
    for (let i = 0; i < 20 && m.state.direction > 0; i++) {
      stepMandelbrot(m, fast, 1 / 24);
      if (m.state.direction < 0) break;
      offsets.push(Math.hypot(m.state.deepX - m.state.cx, m.state.deepY - m.state.cy) / m.state.span);
    }
    expect(offsets.length).toBeGreaterThan(4);
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThan(0.02);
  });

  it('holds still at each end of the cycle', () => {
    const fast = { ...params, speed: 20 };
    const m = seeded(4, fast);
    until(m, fast, () => m.state.direction > 0);
    expect(m.state.held).toBeGreaterThan(0);
    const span = m.state.span;
    stepMandelbrot(m, fast, 1 / 24);
    expect(m.state.span).toBe(span);
  });

  it('heads somewhere different on each pass', () => {
    // The bias is advanced by the golden angle at each turn rather than
    // rerolled, so successive runs never repeat and nothing has to reach for a
    // generator mid-flight.
    const fast = { ...params, speed: 20, dwell: 0 };
    const m = seeded(4, fast);
    const before = m.state.biasAngle;
    until(m, fast, () => m.state.direction > 0);
    until(m, fast, () => m.state.direction < 0);
    expect(m.state.biasAngle).not.toBe(before);
  });

  it('never spends a run staring at a black rectangle, a grey wash, or nothing', () => {
    // The autopilot's whole job, and the three ways it has been seen to fail.
    // Steering by "closest to the set" put the view most of the way inside it
    // for ten seconds at a time; taking only that out left it in hair too fine
    // for the sampling, a flat mid-grey; taking that out too sent it into open
    // exterior with the set out of shot.
    //
    // Stepped a fifth of a second at a time rather than a frame, because what
    // is under test is the trajectory over a whole run and fifty seconds of it
    // at 24fps is a minute of test. The budget is trimmed for the same reason.
    const p = { ...params, maxIterations: 220 };
    const m = createMandelbrot(100, 60, makeRandom(11), p);
    renderMandelbrot(m, p);

    let dark = 0;
    let washed = 0;
    let empty = 0;
    let frames = 0;

    for (let i = 0; i < 5 * 50 && m.state.direction < 0; i++) {
      stepMandelbrot(m, p, 1 / 5);
      renderMandelbrot(m, p);
      frames++;

      const solid = solidFraction(m);
      const mean = m.field.reduce((a, b) => a + b, 0) / m.field.length;
      if (solid > 0.8) dark++;
      if (mean > 0.75) washed++;
      if (solid < 0.02) empty++;

      // And never a flat field, whatever else it is doing.
      expect(spread(m.field), `frame ${i}`).toBeGreaterThan(0.2);
    }

    // A descent, not four seconds of one: the empty-scan counter exists so a
    // single unlucky frame does not end the run.
    expect(frames).toBeGreaterThan(100);
    expect(dark / frames).toBeLessThan(0.1);
    expect(washed / frames).toBeLessThan(0.1);
    expect(empty / frames).toBeLessThan(0.1);
  });

  it('gives a descent three empty scans before abandoning it', () => {
    // One empty scan is a moment, not a verdict. Turning round on the first
    // made a small canvas - where the patch window is a large fraction of the
    // frame and harder to satisfy - descend for four seconds at a time and
    // spend the rest of its life pulling out again.
    //
    // Deep inside the cardioid, so every scan fails, and re-aiming every frame
    // with a step small enough that nothing else about the state moves.
    const p = { ...params, aimInterval: 0 };
    const m = seeded(4, p);
    m.state.cx = -0.2;
    m.state.cy = 0;
    m.state.span = 1e-4;
    renderMandelbrot(m, p);
    expect(solidFraction(m)).toBe(1);

    stepMandelbrot(m, p, 1 / 2400);
    expect(m.state.direction).toBe(-1);
    stepMandelbrot(m, p, 1 / 2400);
    expect(m.state.direction).toBe(-1);
    stepMandelbrot(m, p, 1 / 2400);
    expect(m.state.direction).toBe(1);
  });

  it('follows a pointer, and lands on something rather than where it was told', () => {
    // A pointer parked over the middle of a lake should not take the view into
    // the dark: it chooses roughly, and `aimAt` chooses exactly.
    const m = seeded();
    stepMandelbrot(m, params, 1 / 24, [0.9, 0.9]);
    const towardsCorner = m.state.cx;
    expect(escapeAt(m.state.aimX, m.state.aimY, params.iterations)).not.toBe(Infinity);

    const other = seeded();
    stepMandelbrot(other, params, 1 / 24, [0.1, 0.1]);
    expect(other.state.cx).toBeLessThan(towardsCorner);
  });

  it('answers a drag faster than it steers itself', () => {
    const m = seeded();
    const held = seeded();
    stepMandelbrot(m, params, 1 / 24);
    stepMandelbrot(held, params, 1 / 24, [0.9, 0.5]);
    // Same frame, same field; the steered one has moved further because
    // `steerEase` is shorter than `aimEase`.
    expect(Math.abs(held.state.cx - params.homeX)).toBeGreaterThan(Math.abs(m.state.cx - params.homeX));
  });

  it('is reproducible from a seeded generator', () => {
    const a = seeded(77);
    const b = seeded(77);
    for (let i = 0; i < 60; i++) {
      stepMandelbrot(a, params, 1 / 24);
      renderMandelbrot(a, params);
      stepMandelbrot(b, params, 1 / 24);
      renderMandelbrot(b, params);
    }
    expect(a.state.cx).toBe(b.state.cx);
    expect(Array.from(a.field)).toEqual(Array.from(b.field));
  });
});

/** The index of the cell nearest a complex coordinate in the current view. */
function cellFor(m: Mandelbrot, x: number, y: number): number {
  const [i, j] = cellXY(m, x, y);
  return j * m.w + i;
}

function cellXY(m: Mandelbrot, x: number, y: number): [number, number] {
  const spanY = m.state.span;
  const spanX = spanY * (m.w / m.h);
  const i = Math.round(((x - m.state.cx) / spanX + 0.5) * (m.w - 1));
  const j = Math.round(((y - m.state.cy) / spanY + 0.5) * (m.h - 1));
  return [Math.min(m.w - 1, Math.max(0, i)), Math.min(m.h - 1, Math.max(0, j))];
}
