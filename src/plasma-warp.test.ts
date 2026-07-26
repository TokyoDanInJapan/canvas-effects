import { describe, expect, it } from 'vitest';

import {
  WARP_GRID_X,
  WARP_GRID_Y,
  PLASMA_WARP_DEFAULTS,
  buildPlasmaTile,
  fillDisplacementGrid,
  randomizePlasmaWarp,
  sampleDisplacementGrid,
  samplePlasma,
} from './plasma-warp';
import { makeRandom } from './noise';

const grid = () => new Float32Array(WARP_GRID_X * WARP_GRID_Y * 2);
const seeded = () => randomizePlasmaWarp(makeRandom(12345));

describe('randomizePlasmaWarp', () => {
  it('is reproducible when given a seeded generator', () => {
    expect(seeded()).toEqual(seeded());
  });

  it('gives the four noise fields different seeds', () => {
    for (let seed = 1; seed < 30; seed++) {
      expect(new Set(randomizePlasmaWarp(makeRandom(seed)).seeds).size).toBe(4);
    }
  });

  it('drifts slowly, in either direction', () => {
    const directions = new Set<number>();

    for (let seed = 1; seed < 40; seed++) {
      const state = randomizePlasmaWarp(makeRandom(seed));
      for (const d of state.drift) {
        expect(Math.abs(d)).toBeGreaterThan(0);
        expect(Math.abs(d)).toBeLessThan(0.05);
        directions.add(Math.sign(d));
      }
      expect(state.churn).toBeGreaterThan(0);
      expect(state.churn).toBeLessThan(0.1);
    }

    expect(directions).toEqual(new Set([-1, 1]));
  });
});

describe('the grid dimensions', () => {
  // How much x is stretched by in fillDisplacementGrid. Duplicated here on
  // purpose: this test exists to catch that constant and the grid drifting
  // apart, so importing the real one would defeat it.
  const DOMAIN_ASPECT = 4 / 3;

  it('samples the stretched domain near-isotropically', () => {
    // Domain covered per cell on each axis, at frequency 1.
    const perCellX = DOMAIN_ASPECT / (WARP_GRID_X - 1);
    const perCellY = 1 / (WARP_GRID_Y - 1);

    // Square cells in domain space. A 32x32 grid would be 33% out here, and the
    // warp would read as smeared along x.
    expect(perCellX / perCellY).toBeCloseTo(1, 1);
  });

  it('stays inside the ~1,000-sample budget the coarse grid exists for', () => {
    expect(WARP_GRID_X * WARP_GRID_Y).toBeLessThanOrEqual(1100);
  });
});

describe('fillDisplacementGrid', () => {
  it('fills the whole grid with finite numbers', () => {
    const out = grid();
    fillDisplacementGrid(3.5, PLASMA_WARP_DEFAULTS, seeded(), out);

    expect(out).toHaveLength(WARP_GRID_X * WARP_GRID_Y * 2);
    for (const value of out) expect(Number.isFinite(value)).toBe(true);
  });

  it('is a pure function of its inputs', () => {
    const a = grid();
    const b = grid();
    fillDisplacementGrid(2.25, PLASMA_WARP_DEFAULTS, seeded(), a);
    fillDisplacementGrid(2.25, PLASMA_WARP_DEFAULTS, seeded(), b);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('moves over time', () => {
    const state = seeded();
    const a = grid();
    const b = grid();
    fillDisplacementGrid(0, PLASMA_WARP_DEFAULTS, state, a);
    fillDisplacementGrid(1.5, PLASMA_WARP_DEFAULTS, state, b);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('evolves in place, not only sliding past', () => {
    // Drift alone would make every frame a rigid translation of the last. With
    // drift switched off the field must still change - that is `churn`, and it
    // is the difference between a living background and a panning photograph.
    const state = { ...seeded(), drift: [0, 0] as [number, number] };
    const a = grid();
    const b = grid();
    fillDisplacementGrid(0, PLASMA_WARP_DEFAULTS, state, a);
    fillDisplacementGrid(4, PLASMA_WARP_DEFAULTS, state, b);

    let moved = 0;
    for (let i = 0; i < a.length; i++) moved += Math.abs(a[i] - b[i]);
    expect(moved / a.length).toBeGreaterThan(0.005);
  });

  it('changes smoothly across the grid, so interpolating it is meaningful', () => {
    const out = grid();
    fillDisplacementGrid(1.2, PLASMA_WARP_DEFAULTS, seeded(), out);

    // Neighbouring cells stay close together; a warp that jumped between them
    // would alias badly once bilinearly upsampled to the output.
    let worst = 0;
    for (let j = 0; j < WARP_GRID_Y; j++) {
      for (let i = 1; i < WARP_GRID_X; i++) {
        const a = (j * WARP_GRID_X + i) * 2;
        worst = Math.max(worst, Math.abs(out[a] - out[a - 2]), Math.abs(out[a + 1] - out[a - 1]));
      }
    }
    expect(worst).toBeLessThan(0.2);
  });

  it('leaves the unit square, which is why the caller must wrap', () => {
    // Not a defect - the warp addresses source texture space and relies on the
    // sampler tiling. A version of this that stayed in 0..1 would be broken.
    const state = seeded();
    const out = grid();
    let outside = 0;

    for (let t = 0; t < 200; t += 5) {
      fillDisplacementGrid(t, PLASMA_WARP_DEFAULTS, state, out);
      for (const value of out) if (value < 0 || value > 1) outside++;
    }

    expect(outside).toBeGreaterThan(0);
  });

  it('actually warps - turning the displacement off changes the field', () => {
    const state = seeded();
    const warped = grid();
    const flat = grid();
    fillDisplacementGrid(1, PLASMA_WARP_DEFAULTS, state, warped);
    fillDisplacementGrid(1, { ...PLASMA_WARP_DEFAULTS, warp1: 0, warp2: 0 }, state, flat);
    expect(Array.from(warped)).not.toEqual(Array.from(flat));
  });

  it('folds twice - the second stage depends on the first', () => {
    // If `warp1` did nothing the outer fbm would be sampled at the plain
    // position, and the whole point of a domain warp would be lost.
    const state = seeded();
    const folded = grid();
    const once = grid();
    fillDisplacementGrid(1, PLASMA_WARP_DEFAULTS, state, folded);
    fillDisplacementGrid(1, { ...PLASMA_WARP_DEFAULTS, warp1: 0 }, state, once);
    expect(Array.from(folded)).not.toEqual(Array.from(once));
  });
});

describe('sampleDisplacementGrid', () => {
  const out = new Float32Array(2);

  it('returns the grid exactly at its corners', () => {
    const g = grid();
    for (let i = 0; i < g.length; i++) g[i] = i;

    sampleDisplacementGrid(g, 0, 0, out);
    expect(Array.from(out)).toEqual([g[0], g[1]]);

    sampleDisplacementGrid(g, 1, 1, out);
    const last = (WARP_GRID_Y - 1) * WARP_GRID_X + (WARP_GRID_X - 1);
    expect(out[0]).toBeCloseTo(g[last * 2], 3);
    expect(out[1]).toBeCloseTo(g[last * 2 + 1], 3);
  });

  it('interpolates between neighbours', () => {
    const g = grid();
    g[0] = 0;
    g[2] = 10; // the cell to the right
    sampleDisplacementGrid(g, 0.5 / (WARP_GRID_X - 1), 0, out);
    expect(out[0]).toBeCloseTo(5, 6);
  });

  it('clamps rather than reading outside the grid', () => {
    const g = grid();
    for (let i = 0; i < g.length; i++) g[i] = 1;

    for (const [s, t] of [
      [-5, -5],
      [9, 9],
      [-1, 2],
    ]) {
      sampleDisplacementGrid(g, s, t, out);
      expect(Number.isFinite(out[0])).toBe(true);
      expect(Number.isFinite(out[1])).toBe(true);
      expect(out[0]).toBeCloseTo(1, 6);
    }
  });
});

describe('buildPlasmaTile', () => {
  const SIZE = 64;
  const tile = buildPlasmaTile(SIZE);

  it('normalises to 0..1, touching both ends', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const value of tile) {
      expect(Number.isFinite(value)).toBe(true);
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
    expect(lo).toBeCloseTo(0, 6);
    expect(hi).toBeCloseTo(1, 6);
  });

  it('is not flat', () => {
    expect(new Set(Array.from(tile)).size).toBeGreaterThan(100);
  });

  it('tiles seamlessly, which the wrapped sampling depends on', () => {
    // The step across the wrap-around seam must be no worse than the largest
    // step inside the tile; a non-periodic frequency would show as a hard line.
    const step = (a: number, b: number) => Math.abs(a - b);

    let worstInside = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 1; x < SIZE; x++) {
        worstInside = Math.max(worstInside, step(tile[y * SIZE + x], tile[y * SIZE + x - 1]));
      }
    }

    for (let y = 0; y < SIZE; y++) {
      expect(step(tile[y * SIZE], tile[y * SIZE + SIZE - 1])).toBeLessThanOrEqual(worstInside * 1.5);
    }

    for (let x = 0; x < SIZE; x++) {
      expect(step(tile[x], tile[(SIZE - 1) * SIZE + x])).toBeLessThanOrEqual(worstInside * 1.5);
    }
  });
});

describe('samplePlasma', () => {
  const SIZE = 8;
  const tile = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < tile.length; i++) tile[i] = i / (tile.length - 1);

  it('reads the expected cell inside the tile', () => {
    expect(samplePlasma(tile, SIZE, 0, 0)).toBe(tile[0]);
    expect(samplePlasma(tile, SIZE, 2.5 / SIZE, 1.5 / SIZE)).toBe(tile[1 * SIZE + 2]);
  });

  it('wraps above one', () => {
    expect(samplePlasma(tile, SIZE, 1.25, 3.5)).toBe(samplePlasma(tile, SIZE, 0.25, 0.5));
  });

  it('wraps below zero - the case a bare % gets wrong', () => {
    expect(samplePlasma(tile, SIZE, -0.75, -0.5)).toBe(samplePlasma(tile, SIZE, 0.25, 0.5));
    expect(samplePlasma(tile, SIZE, -12.75, -8.5)).toBe(samplePlasma(tile, SIZE, 0.25, 0.5));
  });

  it('never reads outside the buffer, however far the warp wanders', () => {
    for (let u = -50; u <= 50; u += 0.37) {
      for (let v = -20; v <= 20; v += 0.71) {
        expect(Number.isFinite(samplePlasma(tile, SIZE, u, v))).toBe(true);
      }
    }
  });
});
