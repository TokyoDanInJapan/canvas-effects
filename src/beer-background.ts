// The beer background. The glass it draws lives in beer.ts, the shading it hands
// the result to lives in render.ts, and the canvas, loop and listeners it shares
// with every other effect live in background.ts.
//
// Stateful, so its timestep is fixed: every bubble's position is the last
// frame's moved on, and the head is what a few seconds of popping have left. A
// settling run in `rebuild` is what makes a still frame - the reduced-motion
// path, or the first paint - look like a poured pint rather than an empty glass.
// Unless `pour` is on, in which case an empty glass is the point: it opens dry
// and fills itself.
//
// The field carries small bubbles and a mottled head, so it runs at the output's
// own resolution like the line-art effects rather than at half of it: bilinear
// interpolation would soften exactly the two things worth seeing.

import {
  COMMON_BACKGROUND_DEFAULTS,
  createAgeingList,
  mountBackground,
  type CommonBackgroundOptions,
} from './background.js';
import {
  BEER_DEFAULTS,
  addBubble,
  carryBeer,
  createBeer,
  pressBeer,
  renderBeer,
  stepBeer,
  surfaceAt,
  type Beer,
  type BeerParams,
  type Stir,
} from './beer.js';
import { prefersReducedMotion } from './driver.js';
import { withDefaults } from './options.js';
import { type BackgroundHandle } from './render.js';

export interface BeerBackgroundOptions extends CommonBackgroundOptions {
  /** CSS pixels per rendered pixel - one dither cell, and the size of a bubble's edge. */
  pixelSize: number;
  /**
   * How much coarser the field is than the output, per axis.
   *
   * **One, like the rain and the ridges.** The bubbles are a couple of cells
   * across and the foam's mottling is one cell, and `shade` interpolates
   * bilinearly between cells: at two, the fizz blurs into a haze and the head
   * loses the ragged edge that makes it read as foam.
   */
  fieldScale: number;
  /** Ceiling on field cells. Matched to `maxPixels`, so it never interpolates. */
  maxFieldCells: number;
  /**
   * Steps run before the first paint, so the glass opens with a head on it.
   *
   * The bubbles are seeded at their settled population by `createBeer`, so this
   * only has to build the head - which takes a few seconds of popping, because
   * the head is a balance between the fizz and the drain rather than a thing
   * that is drawn. Ignored when `pour` is on: a glass about to be poured has
   * nothing to settle.
   */
  settleSteps: number;
  /**
   * Open on an empty glass and pour it, instead of opening poured.
   *
   * The level climbs to `fill` at the beer's `pourRate` - two seconds or so at
   * the defaults - fizzing hard on the way, and the head builds in the seconds
   * after, because the head is fed by pops rather than poured. Off by default:
   * a background that arrives mid-page should already be a pint. A visitor who
   * has asked for reduced motion gets the settled glass either way, because
   * their one still frame would otherwise be a picture of nothing.
   */
  pour: boolean;
  /** Beer parameters. Anything omitted falls back to `BEER_DEFAULTS`. */
  beer: Partial<BeerParams>;
  /**
   * Let a press or drag stir it.
   *
   * Three things at once, all from the one drag: the bubbles under the pointer
   * are carried along with it, the sideways sweep drives the body of the beer
   * - it piles against the leading wall and sloshes back - and the drag
   * scrapes fresh bubbles off the glass as it goes. A press is a jab instead:
   * a splash, a burst of spray, and the fizz it knocks loose.
   */
  interactive: boolean;
  /** Most stirs alive at once. */
  maxStirs: number;
  /** Seconds a stir keeps its hold on the liquid. */
  stirLifetime: number;
  /**
   * How likely each point along a drag is to nucleate a bubble, 0 to 1.
   *
   * Real, in the sense that this is how a bubble gets started in the first
   * place: it needs a rough spot to form on. Dragging through the beer leaves a
   * trail of fizz, which is the part of the stir you can see in still liquid.
   */
  scrape: number;
}

export const BEER_BACKGROUND_DEFAULTS: BeerBackgroundOptions = {
  ...COMMON_BACKGROUND_DEFAULTS,
  // Three, finer than any other effect. The fizz is genuinely small - a
  // bubble is a hundredth of the height - and at the field effects' six the
  // smallest of them are a single cell and read as dither noise.
  pixelSize: 3,
  fieldScale: 1,
  // Raised together with `maxPixels` so that three CSS pixels a cell is what a
  // 1080p window actually gets - at the shared 160k ceiling it would quietly
  // coarsen back to four.
  maxFieldCells: 260_000,
  maxPixels: 260_000,
  // Sixty-four, against the shared default of five. The depth fade is a
  // smooth gradient down the whole body of the pour, and five greys cut it
  // into bands the dither has to carry alone; with the palette this deep the
  // fade is a fade. Remember `amplitude` is the real ceiling on distinct
  // greys - see `levels` in the common options.
  levels: 64,
  // One. The liquid is already held at under half brightness so that text sits
  // on it, and biasing it further only eats the head.
  gamma: 1,
  // Six seconds at the default frame rate. The drain's time constant is about
  // three, and the head is fed by pops rather than poured, so it takes two of
  // those to arrive: at four seconds it opens visibly thinner than it ends up.
  settleSteps: 144,
  pour: false,
  beer: {},
  maxStirs: 12,
  stirLifetime: 0.55,
  scrape: 0.5,
};

/**
 * Mounts the beer on a canvas. The canvas keeps whatever size CSS gives it; this
 * only ever sets its backing-store dimensions.
 *
 * Returns null if the browser will not give up a 2D context, which is the one
 * failure worth handling: the page should carry on without a background rather
 * than throw.
 */
export function createBeerBackground(
  canvas: HTMLCanvasElement,
  options: Partial<BeerBackgroundOptions> = {}
): BackgroundHandle | null {
  const config: BeerBackgroundOptions = withDefaults(BEER_BACKGROUND_DEFAULTS, options);
  const params: BeerParams = withDefaults(BEER_DEFAULTS, config.beer);
  const dt = 1 / (config.fps > 0 ? config.fps : 1);

  let beer: Beer | null = null;

  // Live stirs, aged by the same fixed step the glass is, so a stalled tab does
  // not expire a drag that is still happening.
  const stirs = createAgeingList<Stir>(config.maxStirs, config.stirLifetime);

  // Pointer speed in field units a second, smoothed. This is what a stir carries,
  // and the whole interaction depends on it: a slow drag should push the fizz
  // along gently and a fast one should throw it.
  let velocityX = 0;
  let velocityY = 0;
  let lastX = 0;
  let lastY = 0;
  let lastMoveAt = 0;

  return mountBackground(canvas, config, {
    maxFieldCells: config.maxFieldCells,
    gamma: config.gamma,
    timestep: 'fixed',

    rebuild(fieldW, fieldH) {
      // The bubbles, the clock and the waves are all in height units, so a resize
      // carries them over rather than pouring a fresh glass - and the head is
      // resampled with them. Only the first build settles or pours, because by
      // definition there is nothing to carry then.
      const previous = beer;
      beer = createBeer(fieldW, fieldH, config.random, params);

      if (previous) {
        carryBeer(previous, beer);
      } else if (config.pour && !(config.respectReducedMotion && prefersReducedMotion())) {
        // Emptied rather than built empty, because the seeded bubbles assume a
        // poured glass: the loop pours it from here, and the fizz arrives with
        // the beer. Reduced motion falls through to the settle - its one still
        // frame has to be a pint, not the second before one.
        beer.level = 0;
        beer.bubbles.length = 0;
      } else {
        for (let i = 0; i < config.settleSteps; i++) {
          stepBeer(beer, params, config.random, dt);
        }
      }

      renderBeer(beer, params);
    },

    field: () => beer?.field ?? null,

    step(elapsed) {
      if (!beer) return;
      stepBeer(beer, params, config.random, elapsed, stirs.items, config.stirLifetime);
      stirs.advance(elapsed);
      renderBeer(beer, params);
    },

    drag: {
      // Fine, because a stir is a position and a speed rather than something
      // emitted into the field: this is how often the liquid is told where the
      // pointer is, not how much of anything is being added.
      spacing: 0.012,
      maxPerMove: 8,
      onEmit(u, v) {
        if (!beer) return;

        const aspect = beer.h > 0 ? beer.w / beer.h : 1;
        const x = u * aspect;
        const y = v;
        const now = performance.now();

        if (lastMoveAt) {
          // Smoothed rather than taken raw: emissions are spaced by distance, so
          // a single short interval can imply an absurd speed - and this one is
          // handed straight to the liquid.
          const gap = Math.max(0.004, (now - lastMoveAt) / 1000);
          velocityX += ((x - lastX) / gap - velocityX) * 0.35;
          velocityY += ((y - lastY) / gap - velocityY) * 0.35;
        } else {
          // A press is not a stir. Starting from the last drag's speed would
          // have a single click throw the beer across the glass - what it is
          // instead is a jab: a splash, a burst of spray, and the fizz it
          // knocks loose.
          velocityX = 0;
          velocityY = 0;
          pressBeer(beer, params, config.random, x, y);
        }

        lastMoveAt = now;
        lastX = x;
        lastY = y;

        stirs.add({ x, y, vx: velocityX, vy: velocityY, age: 0 });

        // Below the surface, a drag scrapes bubbles into being. Above it there
        // is nothing to nucleate in - stirring the air over the head does
        // nothing, which is as it should be.
        if (config.random() < config.scrape && y > surfaceAt(beer, x)) {
          addBubble(beer, params, config.random, x, y);
        }
      },

      onRelease() {
        // The live stirs are left to age out, so letting go mid-sweep lets the
        // liquid carry on rather than stopping dead with the pointer.
        lastMoveAt = 0;
        velocityX = 0;
        velocityY = 0;
      },
    },

    destroy() {
      stirs.clear();
      beer = null;
    },
  });
}
