// The tunnel background. The projection it draws lives in tunnel.ts, the shading
// it hands the result to lives in render.ts, and the canvas, loop and listeners it
// shares with every other effect live in background.ts.
//
// Stateless in time like the plasma, so the timestep comes off the clock and
// reduced motion is a single frame. Steering is the one exception: the blend
// between the tunnel's own drift and wherever the pointer is dragging it is
// carried between frames, and is absent under reduced motion where there is
// nothing to steer.

import {
  COMMON_BACKGROUND_DEFAULTS,
  approach,
  aspectOf,
  mountBackground,
  type CommonBackgroundOptions,
} from './background.js';
import { withDefaults } from './options.js';
import { type BackgroundHandle } from './render.js';
import { TUNNEL_DEFAULTS, createTunnel, renderTunnel, tunnelCentre, type Tunnel, type TunnelParams } from './tunnel.js';

export interface TunnelBackgroundOptions extends CommonBackgroundOptions {
  /**
   * How much coarser the field is than the output, per axis. One, by default -
   * see the note on the default.
   */
  fieldScale: number;
  /** Ceiling on field cells. */
  maxFieldCells: number;
  /** A multiplier on animation time. */
  speed: number;
  /** Tunnel parameters. Anything omitted falls back to `TUNNEL_DEFAULTS`. */
  tunnel: Partial<TunnelParams>;
  /**
   * Let a press or drag steer the tunnel, pulling the vanishing point towards
   * the pointer and easing it back on release.
   */
  interactive: boolean;
  /** Seconds to take the vanishing point to the pointer, and to give it back. */
  steerEase: number;
}

/**
 * Cost: an `atan2`, a square root and a reciprocal per cell, plus a second square
 * root and a table lookup where the tunnel bends. Measured on a full
 * 160,000-cell field at 3.9 ms a frame straight and 6.2 ms bent - 9% and 15% of
 * one core at 24fps, between the plasma and the fluid solver. That ceiling is
 * only reached above about 3200x1800; at 1280x800 the bend costs nothing
 * measurable against the frame clock's own quantisation.
 */
export const TUNNEL_BACKGROUND_DEFAULTS: TunnelBackgroundOptions = {
  ...COMMON_BACKGROUND_DEFAULTS,
  // 1, not 2. The rings are fine radial structure and interpolating a coarse
  // field smooths them away - the same reason the rain and the ridges want it.
  // See the note on undersampling in tunnel.ts.
  fieldScale: 1,
  // Matched to `maxPixels`, because at `fieldScale: 1` the field *is* the output
  // and a lower cap here would coarsen the picture rather than protect anything.
  maxFieldCells: 160_000,
  // The vignette already decides what is dark, and biasing further only eats the
  // wall detail near the edges where most of the picture is.
  gamma: 1,
  speed: 1,
  tunnel: {},
  steerEase: 0.5,
};

/**
 * Mounts the tunnel on a canvas. The canvas keeps whatever size CSS gives it;
 * this only ever sets its backing-store dimensions.
 *
 * Returns null if the browser will not give up a 2D context, which is the one
 * failure worth handling: the page should carry on without a background rather
 * than throw.
 */
export function createTunnelBackground(
  canvas: HTMLCanvasElement,
  options: Partial<TunnelBackgroundOptions> = {}
): BackgroundHandle | null {
  const config: TunnelBackgroundOptions = withDefaults(TUNNEL_BACKGROUND_DEFAULTS, options);
  const params: TunnelParams = withDefaults(TUNNEL_DEFAULTS, config.tunnel);

  let tunnel: Tunnel | null = null;
  let elapsed = 0;

  // Where the pointer is steering, and how much of that steer is in force.
  // Eases in while held and out on release, like the metaballs' grab.
  let steering = false;
  let steerX = 0;
  let steerY = 0;
  let weight = 0;
  // A plain tuple rather than a Float32Array, because it is also what `steer`
  // returns - reused across frames, so steering allocates nothing per frame.
  const blended: [number, number] = [0, 0];
  const natural = new Float32Array(2);

  /** The steer to draw with, or null to leave the tunnel on its own drift. */
  function steer(): readonly [number, number] | null {
    if (!tunnel || weight <= 0) return null;
    tunnelCentre(elapsed, aspectOf(tunnel), params, tunnel.state, natural);
    // Blended rather than switched, so taking hold of the tunnel and letting go
    // of it are both gradual.
    blended[0] = natural[0] + (steerX - natural[0]) * weight;
    blended[1] = natural[1] + (steerY - natural[1]) * weight;
    return blended;
  }

  return mountBackground(canvas, config, {
    maxFieldCells: config.maxFieldCells,
    gamma: config.gamma,
    timestep: 'clock',

    rebuild(fieldW, fieldH) {
      // A resize rebuilds the field but keeps `elapsed`, so the flight does not
      // jump back to the mouth of the tunnel on a window drag - and the state,
      // which is resolution-independent, is carried over the same way so the
      // whole picture does not teleport into a freshly rolled corridor. Only
      // the first build randomizes.
      const state = tunnel?.state;
      tunnel = createTunnel(fieldW, fieldH, config.random, params);
      if (state) tunnel.state = state;
      renderTunnel(tunnel, params, elapsed, steer());
    },

    field: () => tunnel?.field ?? null,

    step(dt) {
      elapsed += dt * config.speed;

      // Real seconds, unscaled by `speed`: taking hold of the tunnel should not
      // take longer because the flight happens to be slow.
      if (weight > 0 || steering) {
        weight = approach(weight, steering ? 1 : 0, dt, config.steerEase);
        if (!steering && weight < 0.002) weight = 0;
      }

      if (tunnel) renderTunnel(tunnel, params, elapsed, steer());
    },

    drag: {
      // Fine, because the steer simply *is* wherever the pointer last was -
      // nothing is emitted, so this is only how often it is refreshed.
      spacing: 0.004,
      maxPerMove: 4,
      onEmit(u, v) {
        if (!tunnel) return;
        steerX = u * aspectOf(tunnel);
        steerY = v;
        steering = true;
      },

      // Letting go: the vanishing point eases back onto its own drift.
      onRelease() {
        steering = false;
      },
    },

    destroy() {
      tunnel = null;
    },
  });
}
