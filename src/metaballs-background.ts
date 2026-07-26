// The metaballs background: canvas and loop. The implicit surface it draws lives
// in metaballs.ts, and the shading it hands the result to lives in render.ts.
//
// Stateless in time like the plasma - with one exception. The field is a pure
// function of elapsed time, so a frame can be drawn at any moment without having
// drawn the ones before it. A held or just-released ball is the exception: its
// blend weight is carried between frames, and is absent under reduced motion
// where a single still frame is drawn. That makes reduced motion a single draw, with no settling run and
// no fixed-timestep dance to keep a stalled tab from lurching.
//
// A smooth field, so it takes the renderer's interpolation and runs at half
// output resolution like the smoke, the plasma and unlike the line-art effects.

import { createDragSource, createDriver, prefersReducedMotion } from './driver';
import { withDefaults } from './options';
import { createSurface, defaultShading, type BackgroundHandle, type Shading } from './render';
import {
  METABALL_DEFAULTS,
  advanceThrow,
  createMetaballs,
  nearestBall,
  renderMetaballs,
  startThrow,
  type BallOverride,
  type MetaballParams,
  type Metaballs,
  type Throw,
} from './metaballs';

export interface MetaballsBackgroundOptions {
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
  /** Ordered-dither the output. Off posterises flat, showing the bands. */
  dither: boolean;
  /** Weights the field towards its dark end. See `darken` in dither.ts. */
  gamma: number;
  /** A multiplier on animation time. */
  speed: number;
  /** The greys the field is mapped onto. A function is re-read on theme changes. */
  shading: Shading | (() => Shading);
  /** Metaball parameters. Anything omitted falls back to `METABALL_DEFAULTS`. */
  metaballs: Partial<MetaballParams>;
  /**
   * Let a press take hold of the nearest blob and a drag carry it around, with
   * it easing back onto its own path when let go.
   *
   * Listened for on the window rather than the canvas, like every other
   * interaction here: a background canvas is `pointer-events: none`, so it never
   * sees a pointer itself.
   */
  interactive: boolean;
  /** Draw one frame and stop when the visitor has asked for less motion. */
  respectReducedMotion: boolean;
  /** Stop the loop while the tab is hidden. */
  pauseWhenHidden: boolean;
  /** Re-read `shading` when the `class` on `<html>` changes. */
  watchThemeClass: boolean;
  /** Re-read `shading` when the OS colour scheme changes. */
  watchColorScheme: boolean;
  /** Source of randomness. Pass a seeded generator for a repeatable arrangement. */
  random: () => number;
}

export const METABALLS_BACKGROUND_DEFAULTS: MetaballsBackgroundOptions = {
  pixelSize: 6,
  fieldScale: 2,
  maxPixels: 160_000,
  // Cheap per cell - the accumulation costs the sum of the ball areas, not
  // cells times balls - so this can be finer than the fluid solver's 8,000.
  maxFieldCells: 40_000,
  fps: 24,
  levels: 5,
  dither: true,
  // One. The surface threshold already decides what is dark, and biasing it
  // further only eats the shaded rim the shoulder exists to produce.
  gamma: 1,
  speed: 1,
  shading: defaultShading,
  metaballs: {},
  interactive: true,
  respectReducedMotion: true,
  pauseWhenHidden: true,
  watchThemeClass: true,
  watchColorScheme: true,
  random: Math.random,
};

/**
 * Mounts the metaballs on a canvas. The canvas keeps whatever size CSS gives it;
 * this only ever sets its backing-store dimensions.
 *
 * Returns null if the browser will not give up a 2D context, which is the one
 * failure worth handling: the page should carry on without a background rather
 * than throw.
 */
export function createMetaballsBackground(
  canvas: HTMLCanvasElement,
  options: Partial<MetaballsBackgroundOptions> = {}
): BackgroundHandle | null {
  const config: MetaballsBackgroundOptions = withDefaults(METABALLS_BACKGROUND_DEFAULTS, options);
  const params: MetaballParams = withDefaults(METABALL_DEFAULTS, config.metaballs);

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

  let metaballs: Metaballs | null = null;
  let shading: Shading = { base: 0, amplitude: 0 };
  let elapsed = 0;

  // Which ball the pointer has hold of, where it is being held, and how much of
  // that hold is currently in force. `weight` eases in on grab and out on
  // release; see `BallOverride` for why releasing has to be a blend.
  let heldIndex = -1;
  let holding = false;
  let holdX = 0;
  let holdY = 0;
  let weight = 0;

  // Drag velocity, in field-height units a second, smoothed so one jittery
  // sample cannot decide the throw. Handed to `startThrow` on release.
  let velocityX = 0;
  let velocityY = 0;
  let lastMoveAt = 0;

  // The coast after letting go. Null while held or once settled.
  let flight: Throw | null = null;

  function readShading() {
    shading = typeof config.shading === 'function' ? config.shading() : config.shading;
  }

  function shade() {
    if (metaballs) surface.shade(metaballs.field, shading, config.gamma);
  }

  /** The current hold, or null when there is nothing to apply. */
  function override(): BallOverride | null {
    if (heldIndex < 0 || weight <= 0) return null;
    return { index: heldIndex, x: holdX, y: holdY, weight };
  }

  function rebuild() {
    // The arrangement is rerolled on resize, but `elapsed` carries over so the
    // motion does not jump back to the start on a window drag. A hold does not
    // survive it: the ball it referred to no longer exists.
    heldIndex = -1;
    holding = false;
    weight = 0;
    flight = null;
    metaballs = createMetaballs(surface.fieldW, surface.fieldH, config.random, params);
    renderMetaballs(metaballs, params, elapsed);
  }

  let lastNow = 0;

  const driver = createDriver(canvas, {
    fps: config.fps,
    onFrame() {
      const now = performance.now();
      // Accumulated rather than read off the clock, so pausing resumes where it
      // stopped. Clamped, so a backgrounded tab does not lurch on return.
      // Clamped, so a backgrounded tab does not lurch on return.
      const dt = lastNow ? Math.min(now - lastNow, 100) * 0.001 : 0;
      elapsed += dt * config.speed;
      lastNow = now;

      // Real seconds, unscaled by `speed`: picking a blob up should not take
      // four times as long because the arrangement happens to be drifting slowly.
      if (heldIndex >= 0) {
        const towards = holding ? 1 : 0;
        const rate = holding ? params.grabEase : params.releaseEase;
        weight += (towards - weight) * (rate > 0 ? Math.min(1, dt / rate) : 1);

        // Let go: the ball coasts on in the direction it was thrown while the
        // blend reels it back, so the two together read as an elastic tether
        // rather than a spring snapping shut.
        if (flight && metaballs) {
          const aspect = metaballs.h > 0 ? metaballs.w / metaballs.h : 1;
          advanceThrow(flight, params, dt, aspect);
          holdX = flight.x;
          holdY = flight.y;
        }

        // Settled back on its path: stop overriding it at all.
        if (!holding && weight < 0.002) {
          heldIndex = -1;
          weight = 0;
          flight = null;
        }
      }

      if (metaballs) renderMetaballs(metaballs, params, elapsed, override());
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
          // Fine, because the held ball simply *is* wherever the pointer last was
          // - there is nothing being emitted, so this is only how often the hold
          // position is refreshed.
          spacing: 0.004,
          maxPerMove: 4,
          onEmit(u, v) {
            if (!metaballs) return;
            const aspect = metaballs.h > 0 ? metaballs.w / metaballs.h : 1;
            const nextX = u * aspect;
            const nextY = v;
            const now = performance.now();

            if (holding && lastMoveAt) {
              // Smoothed rather than taken raw: emissions are spaced by distance,
              // so a single short interval can imply an absurd speed.
              const gap = Math.max(0.004, (now - lastMoveAt) / 1000);
              velocityX += ((nextX - holdX) / gap - velocityX) * 0.35;
              velocityY += ((nextY - holdY) / gap - velocityY) * 0.35;
            }
            lastMoveAt = now;

            holdX = nextX;
            holdY = nextY;

            // Only the first emission of a drag chooses a ball; the rest move
            // whichever one was picked up, or nothing if the press missed.
            if (!holding) {
              holding = true;
              heldIndex = nearestBall(metaballs.balls, holdX, holdY, params.grabReach);
              weight = 0;
              velocityX = 0;
              velocityY = 0;
              flight = null;
            }
          },
        })
      : null;

  // `createDragSource` has no notion of release, since every other effect only
  // cares where a pointer *was*. This one has to know when it stops.
  function onRelease() {
    if (!holding) return;
    holding = false;
    lastMoveAt = 0;
    // Hand the drag's velocity over, so the ball carries on rather than being
    // pulled straight back to its path.
    flight = startThrow(holdX, holdY, velocityX, velocityY, params);
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
        // The clock moved on while stopped; do not credit that to the animation.
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
      metaballs = null;
    },
  };
}
