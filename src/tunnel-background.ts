// The tunnel background: canvas and loop. The projection it draws lives in
// tunnel.ts, and the shading it hands the result to lives in render.ts.
//
// Stateless in time like the plasma - with one exception. The field is a pure
// function of elapsed time, so a frame can be drawn at any moment without having
// drawn the ones before it. Steering is the exception: the blend between the
// tunnel's own drift and wherever the pointer is dragging it is carried between
// frames, and is absent under reduced motion where a single still frame is drawn.

import { createDragSource, createDriver, prefersReducedMotion } from './driver';
import { withDefaults } from './options';
import { createSurface, defaultShading, type BackgroundHandle, type Shading } from './render';
import { TUNNEL_DEFAULTS, createTunnel, renderTunnel, tunnelCentre, type Tunnel, type TunnelParams } from './tunnel';

export interface TunnelBackgroundOptions {
  /** CSS pixels per rendered pixel - one dither cell. */
  pixelSize: number;
  /** How much coarser the field is than the output, per axis. */
  fieldScale: number;
  /** Ceiling on rendered pixels, so a 4K window is not four times a 1080p one. */
  maxPixels: number;
  /** Ceiling on field cells. */
  maxFieldCells: number;
  /** Redraw rate. */
  fps: number;
  /** Palette size. Small on purpose - the dither is what makes it look smooth. */
  levels: number;
  /** Weights the field towards its dark end. See `darken` in dither.ts. */
  gamma: number;
  /** Ordered-dither the output. Off posterises flat, showing the bands. */
  dither: boolean;
  /** A multiplier on animation time. */
  speed: number;
  /** The greys the field is mapped onto. A function is re-read on theme changes. */
  shading: Shading | (() => Shading);
  /** Tunnel parameters. Anything omitted falls back to `TUNNEL_DEFAULTS`. */
  tunnel: Partial<TunnelParams>;
  /**
   * Let a press or drag steer the tunnel, pulling the vanishing point towards
   * the pointer and easing it back on release.
   *
   * Listened for on the window rather than the canvas, like every other
   * interaction here: a background canvas is `pointer-events: none`, so it never
   * sees a pointer itself.
   */
  interactive: boolean;
  /** Seconds to take the vanishing point to the pointer, and to give it back. */
  steerEase: number;
  /** Draw one frame and stop when the visitor has asked for less motion. */
  respectReducedMotion: boolean;
  /** Stop the loop while the tab is hidden. */
  pauseWhenHidden: boolean;
  /** Re-read `shading` when the `class` on `<html>` changes. */
  watchThemeClass: boolean;
  /** Re-read `shading` when the OS colour scheme changes. */
  watchColorScheme: boolean;
  /** Source of randomness. Pass a seeded generator for a repeatable tunnel. */
  random: () => number;
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
  pixelSize: 6,
  // 1, not 2. The rings are fine radial structure and interpolating a coarse
  // field smooths them away - the same reason the rain and the ridges want it.
  // See the note on undersampling in tunnel.ts.
  fieldScale: 1,
  maxPixels: 160_000,
  // Matched to `maxPixels`, because at `fieldScale: 1` the field *is* the output
  // and a lower cap here would coarsen the picture rather than protect anything.
  maxFieldCells: 160_000,
  fps: 24,
  levels: 5,
  // The vignette already decides what is dark, and biasing further only eats the
  // wall detail near the edges where most of the picture is.
  gamma: 1,
  dither: true,
  speed: 1,
  shading: defaultShading,
  tunnel: {},
  interactive: true,
  steerEase: 0.5,
  respectReducedMotion: true,
  pauseWhenHidden: true,
  watchThemeClass: true,
  watchColorScheme: true,
  random: Math.random,
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

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return null;

  const still = config.respectReducedMotion && prefersReducedMotion();

  const surface = createSurface(canvas, ctx, {
    pixelSize: config.pixelSize,
    fieldScale: config.fieldScale,
    maxPixels: config.maxPixels,
    maxFieldCells: config.maxFieldCells,
    levels: config.levels,
    dither: config.dither,
  });

  let tunnel: Tunnel | null = null;
  let shading: Shading = { base: 0, amplitude: 0 };
  let elapsed = 0;

  // Where the pointer is steering, and how much of that steer is in force.
  // Eases in while held and out on release, like the metaballs' grab.
  let steering = false;
  let steerX = 0;
  let steerY = 0;
  let weight = 0;
  const blended = new Float32Array(2);
  const natural = new Float32Array(2);

  function readShading() {
    shading = typeof config.shading === 'function' ? config.shading() : config.shading;
  }

  /** The steer to draw with, or null to leave the tunnel on its own drift. */
  function steer(): [number, number] | null {
    if (!tunnel || weight <= 0) return null;
    const aspect = tunnel.h > 0 ? tunnel.w / tunnel.h : 1;
    tunnelCentre(elapsed, aspect, params, tunnel.state, natural);
    // Blended rather than switched, so taking hold of the tunnel and letting go
    // of it are both gradual.
    blended[0] = natural[0] + (steerX - natural[0]) * weight;
    blended[1] = natural[1] + (steerY - natural[1]) * weight;
    return [blended[0], blended[1]];
  }

  function shade() {
    if (tunnel) surface.shade(tunnel.field, shading, config.gamma);
  }

  function rebuild() {
    // A resize rebuilds the field but keeps `elapsed`, so the flight does not
    // jump back to the mouth of the tunnel on a window drag.
    tunnel = createTunnel(surface.fieldW, surface.fieldH, config.random, params);
    renderTunnel(tunnel, params, elapsed, steer());
  }

  let lastNow = 0;

  const driver = createDriver(canvas, {
    fps: config.fps,
    onFrame() {
      const now = performance.now();
      // Clamped, so a backgrounded tab does not lurch on return.
      const dt = lastNow ? Math.min(now - lastNow, 100) * 0.001 : 0;
      elapsed += dt * config.speed;
      lastNow = now;

      // Real seconds, unscaled by `speed`: taking hold of the tunnel should not
      // take longer because the flight happens to be slow.
      if (weight > 0 || steering) {
        const towards = steering ? 1 : 0;
        const rate = config.steerEase;
        weight += (towards - weight) * (rate > 0 ? Math.min(1, dt / rate) : 1);
        if (!steering && weight < 0.002) weight = 0;
      }

      if (tunnel) renderTunnel(tunnel, params, elapsed, steer());
      shade();
    },
    onResize() {
      if (surface.resize()) rebuild();
      shade();
    },
    onThemeChange() {
      const previous = shading;
      readShading();
      // The field has not changed, only what greys it maps onto.
      if (shading.base !== previous.base || shading.amplitude !== previous.amplitude) shade();
    },
    pauseWhenHidden: config.pauseWhenHidden,
    watchThemeClass: config.watchThemeClass,
    watchColorScheme: config.watchColorScheme,
  });

  const stopDragging =
    config.interactive && !still
      ? createDragSource(canvas, {
          // Fine, because the steer simply *is* wherever the pointer last was -
          // nothing is emitted, so this is only how often it is refreshed.
          spacing: 0.004,
          maxPerMove: 4,
          onEmit(u, v) {
            if (!tunnel) return;
            const aspect = tunnel.h > 0 ? tunnel.w / tunnel.h : 1;
            steerX = u * aspect;
            steerY = v;
            steering = true;
          },
        })
      : null;

  // `createDragSource` has no notion of release; this one needs to know when the
  // pointer lets go so the tunnel can drift back.
  function onRelease() {
    steering = false;
  }

  if (config.interactive && !still) {
    window.addEventListener('pointerup', onRelease, { passive: true });
    window.addEventListener('pointercancel', onRelease, { passive: true });
    window.addEventListener('blur', onRelease);
  }

  readShading();
  surface.resize();
  rebuild();
  shade();
  if (!still) driver.start();

  return {
    canvas,
    start() {
      if (!still) {
        lastNow = 0;
        driver.start();
      }
    },
    stop() {
      driver.stop();
      lastNow = 0;
    },
    refresh() {
      readShading();
      shade();
    },
    destroy() {
      driver.destroy();
      stopDragging?.();
      window.removeEventListener('pointerup', onRelease);
      window.removeEventListener('pointercancel', onRelease);
      window.removeEventListener('blur', onRelease);
      tunnel = null;
    },
  };
}
