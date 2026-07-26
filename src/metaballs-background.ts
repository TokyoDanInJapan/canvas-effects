// The metaballs background. The implicit surface it draws lives in metaballs.ts,
// the shading it hands the result to lives in render.ts, and the canvas, loop and
// listeners it shares with every other effect live in background.ts.
//
// Stateless in time like the plasma, so the timestep comes off the clock and
// reduced motion is a single frame with no settling run. A held or just-released
// ball is the one exception: its blend weight is carried between frames, and is
// absent under reduced motion where nothing can be picked up in the first place.
//
// A smooth field, so it takes the renderer's interpolation and runs at half
// output resolution - like the plasma, and unlike the line-art effects.

import { COMMON_BACKGROUND_DEFAULTS, aspectOf, mountBackground, type CommonBackgroundOptions } from './background';
import { withDefaults } from './options';
import { type BackgroundHandle } from './render';
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

export interface MetaballsBackgroundOptions extends CommonBackgroundOptions {
  /** Ceiling on field cells. */
  maxFieldCells: number;
  /** A multiplier on animation time. */
  speed: number;
  /** Metaball parameters. Anything omitted falls back to `METABALL_DEFAULTS`. */
  metaballs: Partial<MetaballParams>;
  /**
   * Let a press take hold of the nearest blob and a drag carry it around, with
   * it easing back onto its own path when let go.
   */
  interactive: boolean;
}

export const METABALLS_BACKGROUND_DEFAULTS: MetaballsBackgroundOptions = {
  ...COMMON_BACKGROUND_DEFAULTS,
  // Cheap per cell - the accumulation costs the sum of the ball areas, not
  // cells times balls - so this can be finer than the fluid solver's 8,000.
  maxFieldCells: 40_000,
  // One. The surface threshold already decides what is dark, and biasing it
  // further only eats the shaded rim the shoulder exists to produce.
  gamma: 1,
  speed: 1,
  metaballs: {},
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

  let metaballs: Metaballs | null = null;
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

  /** The current hold, or null when there is nothing to apply. */
  function override(): BallOverride | null {
    if (heldIndex < 0 || weight <= 0) return null;
    return { index: heldIndex, x: holdX, y: holdY, weight };
  }

  return mountBackground(canvas, config, {
    maxFieldCells: config.maxFieldCells,
    gamma: config.gamma,
    timestep: 'clock',

    rebuild(fieldW, fieldH) {
      // The arrangement is rerolled on resize, but `elapsed` carries over so the
      // motion does not jump back to the start on a window drag. A hold does not
      // survive it: the ball it referred to no longer exists.
      heldIndex = -1;
      holding = false;
      weight = 0;
      flight = null;
      metaballs = createMetaballs(fieldW, fieldH, config.random, params);
      renderMetaballs(metaballs, params, elapsed);
    },

    field: () => metaballs?.field ?? null,

    step(dt) {
      elapsed += dt * config.speed;

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
          advanceThrow(flight, params, dt, aspectOf(metaballs));
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
    },

    drag: {
      // Fine, because the held ball simply *is* wherever the pointer last was -
      // there is nothing being emitted, so this is only how often the hold
      // position is refreshed.
      spacing: 0.004,
      maxPerMove: 4,
      onEmit(u, v) {
        if (!metaballs) return;
        const nextX = u * aspectOf(metaballs);
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

      /** Letting go: the ball keeps the speed it was thrown at. */
      onRelease() {
        holding = false;
        lastMoveAt = 0;
        // Hand the drag's velocity over, so the ball carries on rather than being
        // pulled straight back to its path.
        flight = startThrow(holdX, holdY, velocityX, velocityY, params);
      },
    },

    destroy() {
      metaballs = null;
    },
  });
}
