// A black-and-white plasma pushed around by a domain warp.
//
// The warp is fractal Brownian motion folded into itself - fbm(p + fbm(p +
// fbm(p))) - which is the standard way to make a smooth field look like it is
// flowing. Two stages of it here: the first displaces the sampling position,
// the second is evaluated at that displaced position, and the result is where
// the plasma gets read from. Nothing dramatic happens; it drifts.
//
// Domain warping is a well-known technique. The layers under it are in
// noise.ts - an integer hash, value noise built on that hash, and fbm built on
// the noise.
//
// The field it produces is deliberately calm, which is a choice rather than a
// limitation. A warp like this can be made to reorganise itself periodically -
// into a tunnel, a rotation, a polar churn - and that is worth doing when the
// effect is meant to be watched. This one was written to sit behind a page of
// body text, and wants the opposite.
//
// Kept DOM-free so it can be unit-tested; the canvas and the loop live in
// plasma-background.ts.

import { fbm } from './noise';

/**
 * How much wider than tall the sampled domain is, before the warp touches it.
 *
 * `fillDisplacementGrid` stretches x by this so the field is not squashed on a
 * wide window. Written as the ratio it is rather than as a decimal, because
 * that is what it means: a fixed 4:3, not the window's actual aspect. The field
 * is abstract and only has to look unstretched, and making it follow the window
 * would mean the pattern changed shape every time the window did.
 */
const DOMAIN_ASPECT = 4 / 3;

/**
 * The warp is evaluated on a coarse grid and interpolated per pixel, which is
 * what makes it cheap: the noise runs ~1,000 times a frame instead of once per
 * pixel. 36 x 28 = 1,008.
 *
 * THE GRID IS RECTANGULAR BECAUSE THE DOMAIN IS
 * ---------------------------------------------
 * These two are not free to be tidied into a square. `DOMAIN_ASPECT` stretches
 * x, so the grid spans 4/3 units of noise horizontally against 1 vertically.
 * Sampling that with a square grid would cover a third more domain per cell in
 * x than in y - the interpolation error and the apparent scale of the features
 * would differ by axis, and the warp would read as smeared sideways.
 *
 * Making the grid wider by the same factor cancels it. 36/28 = 1.286 against a
 * domain ratio of 1.333 puts the cells within 2.8% of square; a 32 x 32 grid at
 * the same cost would be 33% out.
 *
 * So the pairing is what matters, not either number: change one and the other
 * has to follow, and changing `DOMAIN_ASPECT` means changing both. Note that
 * 2.8% is close rather than exact - 37 x 28 would be 1.0000 - because 2.8% is
 * far below anything two fbm folds and a nearest-neighbour tile lookup could
 * show, and 36 is the rounder number.
 */
export const WARP_GRID_X = 36;
export const WARP_GRID_Y = 28;

export interface PlasmaWarpConfig {
  /** Spatial frequency of the field - how much of it fits across the screen. */
  frequency: number;
  /** How far the first warp stage displaces the domain. */
  warp1: number;
  /** How far the second does. This is the one that produces the marbling. */
  warp2: number;
  /** fbm octaves. Three is plenty at this grid size; more is invisible. */
  octaves: number;
  /** How much of the unwarped position survives, spreading the tile out. */
  spread: number;
}

export const PLASMA_WARP_DEFAULTS: PlasmaWarpConfig = {
  frequency: 1.45,
  warp1: 1.9,
  warp2: 0.85,
  octaves: 3,
  spread: 0.34,
};

/** The seeds and offsets that give one run of the warp its character. */
export interface PlasmaWarpSeed {
  /** Independent noise seeds, so the four fbm fields are unrelated. */
  seeds: [number, number, number, number];
  /** Domain offsets, so two runs with the same seeds still differ. */
  offsets: [number, number, number, number];
  /** Slow translation of the whole field, in domain units per second. */
  drift: [number, number];
  /** Rate the warp evolves in place, as distinct from sliding past. */
  churn: number;
}

/**
 * Rolls a fresh warp state.
 *
 * `rand` is injectable so a seeded generator can produce a repeatable
 * background - the tests rely on it, and it means a given page can look the
 * same twice if that is ever wanted.
 */
export function randomizePlasmaWarp(rand: () => number = Math.random): PlasmaWarpSeed {
  const sign = () => (rand() < 0.5 ? 1 : -1);

  return {
    seeds: [
      Math.floor(rand() * 100000) + 1,
      Math.floor(rand() * 100000) + 1,
      Math.floor(rand() * 100000) + 1,
      Math.floor(rand() * 100000) + 1,
    ],
    offsets: [rand() * 64, rand() * 64, rand() * 64, rand() * 64],
    drift: [(0.012 + rand() * 0.02) * sign(), (0.012 + rand() * 0.02) * sign()],
    churn: 0.05 + rand() * 0.04,
  };
}

/**
 * Fills the warp grid for one frame: `WARP_GRID_X * WARP_GRID_Y * 2` floats, row-major,
 * packed `[u0, v0, u1, v1, ...]`, in source-texture space.
 *
 * The domain warp proper. `q` is the first displacement, `r` is the second
 * evaluated at the position `q` moved us to, and the output is the original
 * position plus that second displacement. Folding it twice is what turns
 * plain cloudy noise into something with filaments and swirls in it.
 *
 * Time enters twice, and it needs to. `drift` slides the whole domain, which
 * on its own would look like a photograph being panned; `churn` moves the
 * inner fields against each other, which is what makes it evolve in place.
 *
 * The output routinely leaves `[0, 1]`; the caller is expected to wrap it.
 */
export function fillDisplacementGrid(
  animTime: number,
  params: PlasmaWarpConfig,
  state: PlasmaWarpSeed,
  gridOut: Float32Array
): void {
  const { frequency, warp1, warp2, octaves, spread } = params;
  const { seeds, offsets, drift, churn } = state;

  const driftX = drift[0] * animTime;
  const driftY = drift[1] * animTime;
  const churnA = churn * animTime;
  const churnB = churn * animTime * 0.73;

  // y spans one unit and x spans `DOMAIN_ASPECT` of them - which is why the
  // grid is 36 x 28 rather than square. See the note on `WARP_GRID_X`.
  for (let j = 0; j < WARP_GRID_Y; j++) {
    const py = (j / (WARP_GRID_Y - 1) - 0.5) * frequency + driftY;

    for (let i = 0; i < WARP_GRID_X; i++) {
      const px = (i / (WARP_GRID_X - 1) - 0.5) * DOMAIN_ASPECT * frequency + driftX;

      // First fold: where does this point get pushed to?
      const qx = fbm(px + offsets[0], py + offsets[1], seeds[0], octaves) - 0.5;
      const qy = fbm(px + offsets[2], py + offsets[3], seeds[1], octaves) - 0.5;

      // Second fold, sampled at that pushed position, with the two fields
      // sliding against each other over time.
      const wx = px + warp1 * qx;
      const wy = py + warp1 * qy;
      const rx = fbm(wx + churnA, wy, seeds[2], octaves) - 0.5;
      const ry = fbm(wx, wy - churnB, seeds[3], octaves) - 0.5;

      const idx = (j * WARP_GRID_X + i) * 2;
      gridOut[idx] = px * spread + warp2 * rx + 0.5;
      gridOut[idx + 1] = py * spread + warp2 * ry + 0.5;
    }
  }
}

/**
 * Bilinear lookup into the warp grid, writing `[u, v]` into `out`.
 *
 * Bilinear is enough: the output is quantised to a handful of grey levels and
 * drawn in fat pixels, so nothing downstream can show anything smoother.
 */
export function sampleDisplacementGrid(grid: Float32Array, s: number, t: number, out: Float32Array): void {
  const x = Math.min(Math.max(s, 0), 1) * (WARP_GRID_X - 1);
  const y = Math.min(Math.max(t, 0), 1) * (WARP_GRID_Y - 1);

  const x0 = Math.min(Math.floor(x), WARP_GRID_X - 2);
  const y0 = Math.min(Math.floor(y), WARP_GRID_Y - 2);
  const fx = x - x0;
  const fy = y - y0;

  const i00 = (y0 * WARP_GRID_X + x0) * 2;
  const i10 = i00 + 2;
  const i01 = i00 + WARP_GRID_X * 2;
  const i11 = i01 + 2;

  const mix = (a: number, b: number, k: number) => a + (b - a) * k;

  out[0] = mix(mix(grid[i00], grid[i10], fx), mix(grid[i01], grid[i11], fx), fy);
  out[1] = mix(mix(grid[i00 + 1], grid[i10 + 1], fx), mix(grid[i01 + 1], grid[i11 + 1], fx), fy);
}

/**
 * A seamless greyscale plasma tile, values in 0..1.
 *
 * This is what the warp reads from. Every frequency is an integer number of
 * cycles across the tile, which is what makes it wrap without a seam - and it
 * has to wrap, because warped coordinates wander a long way outside `[0, 1]`
 * and are read back modulo the tile.
 */
export function buildPlasmaTile(size: number): Float32Array {
  const tile = new Float32Array(size * size);
  const tau = Math.PI * 2;
  let lo = Infinity;
  let hi = -Infinity;

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;

      const value =
        Math.sin(tau * (2 * u)) +
        Math.sin(tau * (3 * v)) +
        Math.sin(tau * (u + v)) +
        Math.sin(tau * (2 * u - 3 * v)) +
        0.6 * Math.sin(tau * (5 * u + 2 * v)) +
        0.6 * Math.sin(tau * (4 * v - u));

      tile[y * size + x] = value;
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
  }

  const range = hi - lo || 1;
  for (let i = 0; i < tile.length; i++) tile[i] = (tile[i] - lo) / range;

  return tile;
}

/**
 * Nearest-neighbour sample of the tile, wrapping in both axes.
 *
 * Nearest rather than bilinear on purpose: it is cheaper, and the hard edges
 * are the point. Note the double modulo - a single `%` keeps the sign in
 * JavaScript, and the warp produces plenty of negative coordinates.
 */
export function samplePlasma(tile: Float32Array, size: number, u: number, v: number): number {
  const x = (((Math.floor(u * size) % size) + size) % size) | 0;
  const y = (((Math.floor(v * size) % size) + size) % size) | 0;
  return tile[y * size + x];
}
