import { describe, expect, it } from 'vitest';

import { makeRandom } from './noise';
import {
  TUNNEL_DEFAULTS,
  axisAt,
  axisFromTable,
  createAxisTable,
  fillAxisTable,
  buildTunnelTile,
  createTunnel,
  randomizeTunnel,
  renderTunnel,
  sampleTile,
  tunnelCentre,
  vignetteAt,
  wallCoords,
  type Tunnel,
  type TunnelParams,
  type TunnelState,
} from './tunnel';

const W = 90;
const H = 60;
const params = TUNNEL_DEFAULTS;

const seeded = (seed = 8) => createTunnel(W, H, makeRandom(seed), params);
const at = (t: Tunnel, x: number, y: number) => t.field[y * t.w + x];

/** Radius of a cell from the tunnel's centre, in field units. */
const radiusOf = (t: Tunnel, x: number, y: number, cx: number, cy: number) => {
  const aspect = t.w / t.h;
  return Math.hypot((x / (t.w - 1)) * aspect - cx, y / (t.h - 1) - cy);
};

describe('buildTunnelTile', () => {
  const SIZE = 64;
  const tile = buildTunnelTile(SIZE);

  it('normalises to 0..1, touching both ends', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of tile) {
      expect(Number.isFinite(v)).toBe(true);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    expect(lo).toBeCloseTo(0, 6);
    expect(hi).toBeCloseTo(1, 6);
  });

  it('wraps on both axes, so the tunnel has no seam down its length', () => {
    // Every frequency is a whole number of cycles across the tile, which is the
    // reason a built tile is used instead of fbm: the angular coordinate comes
    // back around every turn and would otherwise show a join.
    for (let i = 0; i < SIZE; i++) {
      expect(sampleTile(tile, SIZE, 0, i / SIZE)).toBe(sampleTile(tile, SIZE, 1, i / SIZE));
      expect(sampleTile(tile, SIZE, i / SIZE, 0)).toBe(sampleTile(tile, SIZE, i / SIZE, 1));
    }
  });

  it('is structured rather than flat, so motion past it is legible', () => {
    const values = new Set(Array.from(tile).map((v) => Math.round(v * 20)));
    expect(values.size).toBeGreaterThan(8);
  });
});

describe('sampleTile', () => {
  const SIZE = 8;
  const tile = buildTunnelTile(SIZE);

  it('wraps negative coordinates rather than reading out of bounds', () => {
    for (const [u, v] of [
      [-0.25, 0.5],
      [-3.75, -9.5],
      [12.5, -0.125],
    ]) {
      const value = sampleTile(tile, SIZE, u, v);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('is periodic in both axes', () => {
    expect(sampleTile(tile, SIZE, 0.3, 0.7)).toBe(sampleTile(tile, SIZE, 3.3, -2.3));
  });
});

describe('vignetteAt', () => {
  it('is nothing at the centre and full beyond its radius', () => {
    expect(vignetteAt(0, params)).toBe(0);
    expect(vignetteAt(params.vignette, params)).toBe(1);
    expect(vignetteAt(params.vignette * 3, params)).toBe(1);
  });

  it('rises monotonically', () => {
    let previous = -1;
    for (let r = 0; r <= params.vignette; r += params.vignette / 20) {
      const v = vignetteAt(r, params);
      expect(v).toBeGreaterThanOrEqual(previous);
      previous = v;
    }
  });

  it('arrives flat, so no ring marks where it ends', () => {
    // Smoothstep, not a linear ramp: the last step before full brightness is
    // far smaller than one in the middle.
    const step = (r: number) => vignetteAt(r + 0.001, params) - vignetteAt(r, params);
    expect(step(params.vignette - 0.002)).toBeLessThan(step(params.vignette / 2) / 5);
  });

  it('is a no-op when switched off', () => {
    expect(vignetteAt(0, { ...params, vignette: 0 })).toBe(1);
  });
});

describe('tunnelCentre', () => {
  const state = randomizeTunnel(makeRandom(3));
  const out = new Float32Array(2);
  const centreAt = (time: number, aspect = 1.5) => {
    tunnelCentre(time, aspect, params, state, out);
    return [out[0], out[1]];
  };

  it('sits in the middle when the sway is off', () => {
    tunnelCentre(9, 1.5, { ...params, sway: 0 }, state, out);
    expect(out[0]).toBeCloseTo(0.75, 6);
    expect(out[1]).toBeCloseTo(0.5, 6);
  });

  it('drifts over time', () => {
    expect(centreAt(0)).not.toEqual(centreAt(30));
  });

  it('stays within the sway of centre', () => {
    for (let t = 0; t < 400; t += 0.7) {
      const [x, y] = centreAt(t, 1.5);
      // Float32Array, so 0.06 comes back as 0.059999998 - the tolerance has to
      // be a float32 one, not a float64 one.
      expect(Math.abs(x - 0.75)).toBeLessThanOrEqual(params.sway + 1e-6);
      expect(Math.abs(y - 0.5)).toBeLessThanOrEqual(params.sway + 1e-6);
    }
  });

  it('drifts the same distance either way on a wide window', () => {
    // Isotropic: x spans 0..aspect, so a sway of 0.06 is 0.06 of the *height*
    // whichever axis it is on.
    const narrow = randomizeTunnel(makeRandom(3));
    tunnelCentre(7, 1, params, narrow, out);
    const [nx] = [out[0] - 0.5];
    tunnelCentre(7, 3, params, narrow, out);
    const wx = out[0] - 1.5;
    expect(wx).toBeCloseTo(nx, 6);
  });

  it('does not fall into a short common period', () => {
    // Two sines on independent random rates will pass near any given point now
    // and then, so "never comes back" is not the property worth asserting - it
    // holds or fails on the seed. What a reader would actually notice is a
    // *beat*: the vanishing point returning to where it started on a regular
    // interval. So collect the near-returns and check they are neither frequent
    // nor evenly spaced.
    const first = centreAt(0);
    const returns: number[] = [];
    for (let t = 1; t < 400; t += 1) {
      const now = centreAt(t);
      if (Math.abs(now[0] - first[0]) < 0.002 && Math.abs(now[1] - first[1]) < 0.002) returns.push(t);
    }

    // A genuine short period would bring it back scores of times in 400 seconds.
    expect(returns.length).toBeLessThan(10);

    const gaps = returns.slice(1).map((t, i) => t - returns[i]);
    if (gaps.length >= 2) {
      const spread = Math.max(...gaps) - Math.min(...gaps);
      expect(spread).toBeGreaterThan(1);
    }
  });

  it('drifts on two incommensurable rates', () => {
    // The reason the above holds: the axes are not locked to one another.
    expect(state.swayRateX).not.toBeCloseTo(state.swayRateY, 3);
  });
});

/**
 * An axis source covering the depths a frame at these params can see - the same
 * span `renderTunnel` fills. The table is only meaningful over that span, which is
 * the point of it: a few hundred samples across a couple of tile-lengths.
 */
function axisFor(state: TunnelState, travel = 0, p: TunnelParams = params) {
  const source = { table: createAxisTable(), scratch: new Float32Array(2) };
  const near = Math.max(p.vignette, p.coreRadius);
  fillAxisTable(source.table, p.depth / 1.5 + travel, p.depth / near + travel, p, state, new Float32Array(2));
  return source;
}

describe('renderTunnel', () => {
  it('fills the field with values in 0..1', () => {
    const t = seeded();
    renderTunnel(t, params, 3);
    expect(t.field).toHaveLength(W * H);
    for (const v of t.field) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('survives the singularity at the exact centre', () => {
    // `1 / radius` runs to infinity there. `coreRadius` floors it and the
    // vignette hides it, but the arithmetic still has to come out finite.
    const t = seeded();
    renderTunnel(t, { ...params, sway: 0 }, 0, null);
    for (const v of t.field) expect(Number.isFinite(v)).toBe(true);

    // Dead centre of the field, with the sway off.
    const cx = Math.round((W - 1) / 2);
    const cy = Math.round((H - 1) / 2);
    expect(Number.isFinite(at(t, cx, cy))).toBe(true);
  });

  it('darkens towards the vanishing point', () => {
    const t = seeded();
    const flat = { ...params, sway: 0 };
    renderTunnel(t, flat, 0);

    const aspect = W / H;
    const cx = aspect / 2;
    const cy = 0.5;

    // Mean brightness of cells inside the throat against those outside it.
    let inner = 0;
    let innerN = 0;
    let outer = 0;
    let outerN = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const r = radiusOf(t, x, y, cx, cy);
        if (r < flat.vignette * 0.4) {
          inner += at(t, x, y);
          innerN++;
        } else if (r > flat.vignette * 1.5) {
          outer += at(t, x, y);
          outerN++;
        }
      }
    }
    expect(innerN).toBeGreaterThan(0);
    expect(outerN).toBeGreaterThan(0);
    expect(inner / innerN).toBeLessThan(outer / outerN);
  });

  it('is a pure function of time', () => {
    const a = seeded(5);
    const b = seeded(5);
    renderTunnel(a, params, 12.25);
    renderTunnel(b, params, 12.25);
    expect(Array.from(a.field)).toEqual(Array.from(b.field));
  });

  it('does not drift when stepped versus jumped to the same time', () => {
    const stepped = seeded(5);
    for (let i = 1; i <= 40; i++) renderTunnel(stepped, params, i * 0.25);
    const jumped = seeded(5);
    renderTunnel(jumped, params, 10);
    expect(Array.from(stepped.field)).toEqual(Array.from(jumped.field));
  });

  it('travels: the projection sweeps the wall outward', () => {
    // Asserted on the projection rather than on the rendered rings. The rings do
    // not translate - they stretch, moving further the further out they already
    // are - so cross-correlating a ray against a later one finds no single shift
    // that fits, and reports zero however well the effect is working.
    //
    // Measured: over 1.4s at the defaults, a feature at radius 0.15 moves 0.007
    // but one at 0.5 moves 0.091 - twelve times as far.
    const out = new Float32Array(3);
    const v = (radius: number, travel: number) => {
      wallCoords(radius, 0, params, travel, 0, out);
      return out[1];
    };

    // Falls with radius: the far wall is compressed into the middle.
    let previous = Infinity;
    for (let r = 0.05; r < 0.8; r += 0.05) {
      const now = v(r, 0);
      expect(now).toBeLessThan(previous);
      previous = now;
    }

    // Rises with travel: the viewer moves down the tunnel.
    expect(v(0.3, 1)).toBeGreaterThan(v(0.3, 0));

    // The two together: whatever radius held a given coordinate before, a larger
    // one holds it now.
    const phase = v(0.3, 0);
    let moved = 0;
    for (let r = 0.3; r < 2; r += 0.001) {
      if (v(r, 0.308) <= phase) {
        moved = r;
        break;
      }
    }
    expect(moved).toBeGreaterThan(0.3);
  });

  it('spins with twist, and holds still without it', () => {
    const still = seeded(7);
    renderTunnel(still, { ...params, sway: 0, speed: 0, twist: 0 }, 0);
    const later = seeded(7);
    renderTunnel(later, { ...params, sway: 0, speed: 0, twist: 0 }, 5);
    expect(Array.from(later.field)).toEqual(Array.from(still.field));

    // 1 second at 0.3 turns, so the wall shifts 0.6 of a tile. Five seconds
    // would be 1.5 turns, which with two repeats is a whole tile and therefore
    // invisible - real rotational symmetry of order `repeats`, and a trap for
    // this test rather than a bug.
    const spun = seeded(7);
    renderTunnel(spun, { ...params, sway: 0, speed: 0, twist: 0.3 }, 1);
    expect(Array.from(spun.field)).not.toEqual(Array.from(still.field));
  });

  it('repeats the wall around the circumference as asked', () => {
    // With two repeats, opposite sides of the tunnel show the same wall.
    // Steered exactly onto a cell. Left to its own centre, the vanishing point
    // sits at aspect/2 = 0.75 while the nearest cell sits at 0.7584, and cx ± d
    // are then not symmetric about it at all.
    const t = seeded(9);
    // `bend: 0` as well as the rest: a winding axis leans the corridor to one
    // side, so left-right symmetry is exactly what it is there to break.
    const flat = { ...params, sway: 0, twist: 0, bend: 0, repeats: 2 };
    const cx = Math.round((W - 1) / 2);
    const cy = Math.round((H - 1) / 2);
    const aspect = W / H;
    renderTunnel(t, flat, 0, [(cx * aspect) / (W - 1), cy / (H - 1)]);

    for (const d of [8, 12, 16]) {
      expect(at(t, cx + d, cy)).toBeCloseTo(at(t, cx - d, cy), 6);
    }
  });

  it('follows a steer, overriding the drift', () => {
    const drifting = seeded(4);
    renderTunnel(drifting, params, 6);
    const steered = seeded(4);
    renderTunnel(steered, params, 6, [0.4, 0.2]);
    expect(Array.from(steered.field)).not.toEqual(Array.from(drifting.field));
  });

  it('puts the throat where it is steered', () => {
    // Compared as two discs, not as a dark centroid over the whole field: the
    // wall's own dark bands are everywhere and swamp the vignette, so a weighted
    // centroid lands near the middle whatever the steer is doing.
    const t = seeded(4);
    const steer: [number, number] = [0.35, 0.25];
    renderTunnel(t, params, 6, steer);

    const aspect = W / H;
    const meanAround = (px: number, py: number) => {
      let total = 0;
      let n = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const r = Math.hypot((x / (W - 1)) * aspect - px, y / (H - 1) - py);
          if (r < params.vignette * 0.5) {
            total += at(t, x, y);
            n++;
          }
        }
      }
      return n ? total / n : 1;
    };

    expect(meanAround(steer[0], steer[1])).toBeLessThan(meanAround(aspect / 2, 0.5));
  });

  it('copes with a degenerate one-cell field', () => {
    for (const [w, h] of [
      [1, 40],
      [40, 1],
      [1, 1],
    ]) {
      const t = createTunnel(w, h, makeRandom(2), params);
      renderTunnel(t, params, 2);
      for (const v of t.field) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('copes with a field of no height at all', () => {
    // The aspect is `w / h`, so this is the one shape that would divide by zero
    // and put NaN through the whole field - and a NaN reaches the canvas as a
    // silent black rectangle rather than as an error.
    const t = createTunnel(4, 0, makeRandom(3), params);
    renderTunnel(t, params, 2);
    expect(t.field.length).toBe(0);

    const one = createTunnel(4, 1, makeRandom(3), params);
    renderTunnel(one, params, 2);
    for (const v of one.field) expect(Number.isFinite(v)).toBe(true);
  });

  it('winds: the axis stays bounded by `bend`', () => {
    // Bounded is the property that matters. An axis that wandered without limit
    // would take the far end of the tunnel off-screen, and there is nothing
    // behind it to show.
    const state = randomizeTunnel(makeRandom(11));
    const out = new Float32Array(2);
    for (let v = 0; v < 400; v += 0.37) {
      axisAt(v, params, state, out);
      expect(Math.abs(out[0])).toBeLessThanOrEqual(params.bend + 1e-6);
      expect(Math.abs(out[1])).toBeLessThanOrEqual(params.bend + 1e-6);
    }
  });

  it('winds: the bend moves the wall, and `bend: 0` is a straight tunnel', () => {
    const straight = seeded(12);
    renderTunnel(straight, { ...params, bend: 0 }, 4);
    const bent = seeded(12);
    renderTunnel(bent, params, 4);
    expect(Array.from(bent.field)).not.toEqual(Array.from(straight.field));

    // And a straight tunnel is what the effect was before the bend existed, so
    // passing no state must give the same field as asking for no bend.
    const out = new Float32Array(3);
    const withoutState = new Float32Array(3);
    wallCoords(0.3, 0.2, params, 1, 0, out, axisFor(straight.state, 1));
    wallCoords(
      0.3,
      0.2,
      { ...params, bend: 0 },
      1,
      0,
      withoutState,
      axisFor(straight.state, 1, { ...params, bend: 0 })
    );
    const bare = new Float32Array(3);
    wallCoords(0.3, 0.2, params, 1, 0, bare);
    expect(Array.from(bare)).toEqual(Array.from(withoutState));
    expect(Array.from(bare)).not.toEqual(Array.from(out));
  });

  it('winds: the correction is proportional to the apparent radius', () => {
    // `R * X`, not `X` - a lateral offset subtends less the further away it is,
    // so the correction vanishes at the centre of the screen and is largest at
    // the edges. That is what makes the near wall sweep past while the far end
    // holds still, rather than the whole picture sliding sideways.
    //
    // Asserted on the displacement, not on the depth it samples: `v = depth / r`,
    // so `dv/dr` runs away towards the middle and a *smaller* nudge there shows
    // up as a far larger change in `v`. Measuring that instead says the
    // correction is biggest at the centre, which is the opposite of the truth.
    const state = randomizeTunnel(makeRandom(13));
    const source = axisFor(state, 1);
    const bent = new Float32Array(3);
    const flat = new Float32Array(3);

    const shiftAt = (r: number) => {
      wallCoords(r, 0, params, 1, 0, bent, source);
      wallCoords(r, 0, { ...params, bend: 0 }, 1, 0, flat, source);
      // Both distances are measured from the same screen point, so the change in
      // radius is bounded by the correction that was applied to it.
      return Math.abs(bent[2] - flat[2]);
    };

    // Bounded by `|axis| * radius` at every radius - the triangle inequality on a
    // correction of exactly that. `bend` bounds each component of the axis rather
    // than its length, so the bound carries a root two.
    const reach = params.bend * Math.SQRT2;
    for (const r of [0.01, 0.05, 0.1, 0.2, 0.4, 0.7]) {
      expect(shiftAt(r)).toBeLessThanOrEqual(reach * Math.max(r, params.coreRadius) + 1e-6);
    }

    // And it really does go to nothing at the centre rather than merely being
    // bounded there.
    expect(shiftAt(0.002)).toBeLessThan(shiftAt(0.7));
    expect(shiftAt(0.002)).toBeLessThan(reach * params.coreRadius + 1e-6);
  });

  it('banks into the turn', () => {
    const state = randomizeTunnel(makeRandom(14));
    const source = axisFor(state, 1);
    const rolled = new Float32Array(3);
    const level = new Float32Array(3);
    wallCoords(0.4, 0.1, { ...params, bank: 0.3 }, 1, 0, rolled, source);
    wallCoords(0.4, 0.1, { ...params, bank: 0 }, 1, 0, level, source);
    // Same depth, different angle: a roll turns the wall without moving it.
    expect(rolled[1]).toBeCloseTo(level[1], 6);
    expect(rolled[0]).not.toBeCloseTo(level[0], 4);
  });

  it('samples the axis from a table that matches the exact function', () => {
    // The table exists to replace two sines per cell. It is only worth having if
    // it agrees with what it replaces, over the span a frame actually queries.
    const state = randomizeTunnel(makeRandom(15));
    const source = axisFor(state, 3);
    const near = Math.max(params.vignette, params.coreRadius);
    const from = params.depth / 1.5 + 3;
    const to = params.depth / near + 3;

    const exact = new Float32Array(2);
    const lerped = new Float32Array(2);
    let worst = 0;
    for (let k = 0; k <= 400; k++) {
      const v = from + ((to - from) * k) / 400;
      axisAt(v, params, state, exact);
      axisFromTable(source.table, v, lerped);
      worst = Math.max(worst, Math.abs(exact[0] - lerped[0]), Math.abs(exact[1] - lerped[1]));
    }
    // Five palette levels over an amplitude of 30 cannot show a 1e-4 difference in
    // a lateral offset that is itself scaled by the radius.
    expect(worst).toBeLessThan(1e-4);
  });

  it('holds the axis at the ends of the table rather than wrapping', () => {
    // Outside the span is the region the frame cannot see. Wrapping there would
    // put the far wall's bend on the near wall.
    const state = randomizeTunnel(makeRandom(16));
    const source = axisFor(state, 0);
    const low = new Float32Array(2);
    const high = new Float32Array(2);
    axisFromTable(source.table, -1000, low);
    axisFromTable(source.table, source.table.from, high);
    expect(Array.from(low)).toEqual(Array.from(high));

    const top = source.table.from + source.table.step * 511;
    axisFromTable(source.table, 1e6, low);
    axisFromTable(source.table, top, high);
    expect(Array.from(low)).toEqual(Array.from(high));
  });

  it('copes with a table of no span', () => {
    // Happens whenever the visible depth range collapses, which a one-cell field
    // does. Every lookup has to land on the single sample rather than divide by a
    // step of zero.
    const state = randomizeTunnel(makeRandom(17));
    const table = createAxisTable();
    fillAxisTable(table, 4, 4, params, state, new Float32Array(2));
    const out = new Float32Array(2);
    for (const v of [-9, 4, 900]) {
      axisFromTable(table, v, out);
      expect(Number.isFinite(out[0])).toBe(true);
      expect(Number.isFinite(out[1])).toBe(true);
    }
  });

  it('normalises a tile with no range in it', () => {
    // One sample has nothing to normalise against, so the range would be zero.
    const tile = buildTunnelTile(1);
    expect(tile.length).toBe(1);
    expect(Number.isFinite(tile[0])).toBe(true);
  });
});
