// The half every effect shares: a coarse field interpolated up to a fat-pixel
// canvas and ordered-dithered on the way.
//
// TWO RESOLUTIONS
// ---------------
// What makes these cheap is that they render at two scales at once:
//
//   • The **field** - the expensive part, whatever generates it - is computed
//     at `pixelSize * fieldScale` CSS pixels per cell. The smooth fields here
//     gain nothing from more samples, and this is
//     where all the real work happens. It stays at a few thousand cells
//     whatever the window is doing.
//   • The **output** is `pixelSize` CSS pixels per pixel, interpolated up from
//     that field and then dithered. Per pixel that is a handful of
//     multiply-adds and a table lookup.
//
// Dithering at the fine scale is what stops a five-level palette looking like
// five flat plateaus: the Bayer threshold breaks each boundary into texture, so
// the eye integrates it back into a gradient. Posterising alone gives bands;
// posterising with an ordered dither gives the same tiny palette read as smooth.
//
// The output is greyscale and opaque. Every pixel is `base + level *
// amplitude`, so the effect modulates a page colour rather than replacing it -
// which is what lets body text sit directly on top of one of these.

import { orderedDither, quantise } from './dither.js';
import { withDefaults } from './options.js';

/** How the field's 0..1 levels are mapped onto actual greys. */
export interface Shading {
  /**
   * The page colour being modulated, 0-255. The canvas is opaque, so it has to
   * paint this itself rather than letting a CSS background show through -
   * which also means it must match whatever is behind it.
   */
  base: number;
  /**
   * How far the effect moves that colour, in 0-255 steps. Negative moves it
   * down, which is what a light theme wants.
   *
   * This is the readability dial. Keep it low if text sits on top: the effect
   * should modulate the page rather than become a picture.
   */
  amplitude: number;
  /**
   * Per-channel multipliers on `amplitude`, as `[r, g, b]`. Omit for greyscale,
   * which is what every effect here is designed around.
   *
   * Note what this does and does not colour. `base` stays untinted, because it
   * is the page's own colour and the canvas is opaque - it has to keep painting
   * that faithfully or the canvas edge shows a seam. Only the *modulation* is
   * tinted, so the effect reads as coloured light over the page rather than as
   * a coloured rectangle. `[0, 1, 0.25]` gives the obvious green.
   *
   * Tinting costs readability twice over: it adds chroma contrast on top of the
   * luminance contrast text already has to compete with, and a channel
   * multiplier below 1 means that channel moves less than `amplitude` suggests.
   * Check a long paragraph over it before shipping one.
   */
  tint?: readonly [number, number, number];
  /**
   * Colours to map the palette onto, as `[r, g, b]` triples in 0-255.
   *
   * Sampled evenly across the stops, so the ramp's length is independent of
   * `levels`: three stops across a nine-level palette interpolates, and nine
   * stops across a three-level palette takes the ends and the middle. `levels`
   * still decides how many distinct colours reach the screen; this decides which.
   *
   * Supersedes `base`, `amplitude` and `tint`, which is why the first stop has
   * to be your page colour - for exactly the reason `base` does, since the
   * canvas is opaque and paints the page colour itself.
   *
   * A ramp buys the one thing a greyscale palette cannot give: a steep
   * perceptual gradient - a black to red to orange to white ramp separates five
   * levels far more sharply than five greys can. It also costs readability more
   * than a tint does, so read a long paragraph over it.
   */
  ramp?: ReadonlyArray<readonly [number, number, number]>;
  /**
   * The slice of the spectrum the palette actually uses, as `[min, max]`
   * fractions of the full throw, each 0..1. `[0, 1]` - the default - is the
   * whole thing; `[0.15, 0.8]` pins the darkest level above the floor and the
   * lightest below the ceiling without touching `amplitude`.
   *
   * This is the dial for the two *ends* where `amplitude` is the dial for the
   * *distance*: softening only the extremes with `amplitude` alone means
   * retuning it and losing overall contrast. With a `ramp` it slices the ramp
   * the same way, so `[0.5, 1]` reads only its upper half.
   *
   * One caution: a `min` above 0 moves the empty field's colour off `base`, so
   * the canvas shows as a flat wash where there is no effect - which stops
   * being invisible against the page. Raise it knowingly.
   */
  range?: readonly [number, number];
}

/**
 * Expands a shading into one RGB triple per palette level.
 *
 * Built once per frame rather than evaluated per pixel, which is what keeps the
 * inner loop to three array reads however the shading is specified - the tint
 * multiplies and any ramp interpolation happen `levels` times, not a hundred
 * thousand times.
 */
export function buildPalette(shading: Shading, levels: number): Uint8ClampedArray {
  const count = Math.max(1, levels);
  const out = new Uint8ClampedArray(count * 3);
  const last = count > 1 ? count - 1 : 1;

  // The ends of the used slice. Applied to the level, not the bytes, so it
  // means the same thing to a grey run, a tint and a ramp.
  const [rangeLo, rangeHi] = shading.range ?? [0, 1];

  if (shading.ramp && shading.ramp.length > 0) {
    const stops = shading.ramp;
    const span = stops.length - 1;

    for (let i = 0; i < count; i++) {
      const t = count > 1 ? i / last : 0;
      const at = (rangeLo + t * (rangeHi - rangeLo)) * span;
      const lo = Math.min(Math.floor(at), span);
      const hi = Math.min(lo + 1, span);
      const f = at - lo;

      for (let c = 0; c < 3; c++) {
        out[i * 3 + c] = stops[lo][c] + (stops[hi][c] - stops[lo][c]) * f;
      }
    }
    return out;
  }

  const { base, amplitude, tint } = shading;
  const scale = tint ?? [1, 1, 1];

  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / last : 0;
    const level = rangeLo + t * (rangeHi - rangeLo);
    for (let c = 0; c < 3; c++) out[i * 3 + c] = base + level * amplitude * scale[c];
  }
  return out;
}

/**
 * True if two shadings would paint the same picture.
 *
 * What it is for: a theme change hands back a shading that is usually identical
 * to the one already in force, because most theme changes are not about the
 * canvas. Comparing before repainting is what keeps an unrelated class change on
 * `<html>` - which is most of them - from costing a full pass over the output.
 *
 * All four fields, deliberately. Comparing only `base` and `amplitude` looks
 * sufficient and is not: a page whose light and dark themes share a page colour
 * and differ only in `ramp` or `tint` - a dark page changing its accent, say -
 * would return an unequal shading that compares equal, and the theme change
 * would silently do nothing.
 */
export function sameShading(a: Shading, b: Shading): boolean {
  if (a.base !== b.base || a.amplitude !== b.amplitude) return false;

  if (a.tint !== b.tint) {
    if (!a.tint || !b.tint) return false;
    for (let c = 0; c < 3; c++) if (a.tint[c] !== b.tint[c]) return false;
  }

  // Compared by value rather than by identity, because the natural way to write
  // a `shading` callback builds its ramp fresh on every call.
  if (a.ramp !== b.ramp) {
    if (!a.ramp || !b.ramp || a.ramp.length !== b.ramp.length) return false;
    for (let i = 0; i < a.ramp.length; i++) {
      for (let c = 0; c < 3; c++) if (a.ramp[i][c] !== b.ramp[i][c]) return false;
    }
  }

  // An absent range and an explicit [0, 1] paint the same picture, which is
  // the whole question this function answers.
  const aRange = a.range ?? FULL_RANGE;
  const bRange = b.range ?? FULL_RANGE;
  if (aRange[0] !== bRange[0] || aRange[1] !== bRange[1]) return false;

  return true;
}

const FULL_RANGE: readonly [number, number] = [0, 1];

/**
 * The greys used when nothing else is specified: near-black behind a dark page,
 * near-white behind a light one, moving about a tenth of the range either way.
 *
 * Dark mode is taken from a `dark` class on `<html>` if there is one, and from
 * the OS otherwise. Replace this wholesale if your page decides differently -
 * the canvas is opaque, so `base` has to match the page colour behind it or the
 * two will visibly disagree.
 */
export function defaultShading(): Shading {
  const dark =
    document.documentElement.classList.contains('dark') ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  return dark ? { base: 18, amplitude: 26 } : { base: 255, amplitude: -22 };
}

/** What mounting either effect hands back. */
export interface BackgroundHandle {
  /** Stops the loop and removes every listener. Idempotent. */
  destroy(): void;
  /** Starts the loop, if it is not already running and motion is allowed. */
  start(): void;
  /** Stops the loop without tearing anything down. */
  stop(): void;
  /** Re-reads the shading and repaints. Call after changing the theme by hand. */
  refresh(): void;
  /**
   * True while the loop is actually drawing - false when stopped, paused by a
   * hidden tab, or held still by reduced motion. A host building a play/pause
   * control reads this rather than shadowing the state itself.
   */
  readonly running: boolean;
  /**
   * True while the effect is a single still frame because the visitor asked for
   * less motion. Distinct from `running`, because `start()` silently refusing is
   * otherwise indistinguishable from the loop merely not having begun.
   */
  readonly still: boolean;
  readonly canvas: HTMLCanvasElement;
}

export interface SurfaceOptions {
  /** CSS pixels per rendered pixel - the size of one dither cell. */
  pixelSize: number;
  /** How much coarser the field is than the output, per axis. */
  fieldScale: number;
  /** Ceiling on rendered pixels; raises `pixelSize` on large windows. */
  maxPixels: number;
  /** Ceiling on field cells. `Infinity` to let the field scale freely. */
  maxFieldCells: number;
  /**
   * Palette size. Small on purpose - the dither is what makes it smooth.
   *
   * Up to 256. Past `|amplitude| + 1` the entries start repeating, because the
   * palette is bytes - see `levels` in `CommonBackgroundOptions`.
   */
  levels: number;
  /**
   * Ordered-dither the output, rather than posterising it flat.
   *
   * True is the whole point of the library, and off is mostly useful for seeing
   * why: the palette is unchanged either way, so switching it off shows the same
   * handful of greys as hard bands with visible steps between them. That is what
   * the Bayer threshold is preventing.
   *
   * `'auto'` is true above one CSS pixel a cell and false at one, and is the
   * default. It is a choice about *look* rather than a correction, and worth
   * being straight about, because the obvious reasoning for it is wrong: at one
   * CSS pixel a cell the Bayer pattern is at the display's own pitch, which is
   * where dithering works best, and rendering the same view both ways shows it
   * blending into a genuinely smooth gradient.
   *
   * What turning it off buys at that size is the other look - crisp posterised
   * regions with clean curved boundaries between them, which is a deliberate
   * thing to want and is unavailable at any coarser size, where undithered
   * output is just visible steps. Above one CSS pixel a cell the dither is
   * doing the job it was written for and stays on.
   *
   * So this is the default and not a rule: `dither: true` keeps it at any size,
   * and is the better setting if you want smooth gradient at native resolution.
   *
   * Resolved from the *effective* size rather than the requested one, because
   * `maxPixels` raises it: asking for one on a large window and being given
   * three should still dither, and does.
   *
   * It is not a performance dial. Both paths quantise once per pixel; the dither
   * adds an array lookup and an add.
   */
  dither: boolean | 'auto';
  /**
   * Read the field round a centre rather than straight across the canvas.
   * `true` for the defaults, omitted or `false` for the plain lookup.
   */
  polar?: PolarOption;
}

// POLAR
// -----
// Every effect here draws on a rectangle, and the rectangle is the only thing
// this bends. One axis of the field becomes the angle about a centre and the
// other the distance from it, so the rain falls outwards from the middle of the
// page, the ridges stack into rings, and the plasma turns about a point. No
// effect knows about any of it: the field is built exactly as before, and only
// the lookup that reads it changes.
//
// That is why it lives here rather than in seven places. It is also why it
// costs a table: the plain lookup is separable - a row of x weights and a
// column of y ones - and a polar one is not, because the field cell an output
// pixel reads depends on both of its coordinates at once. So the transform is
// evaluated once per pixel on resize and the frame path stays two array reads
// and a blend, which is what the separable version costs anyway.

/** Reading the field round a centre. See `polar` in `CommonBackgroundOptions`. */
export interface Polar {
  /**
   * The point everything turns about, as fractions of the canvas box.
   *
   * Outside `0..1` is allowed and useful: a centre beyond one edge gives a fan
   * rather than a wheel, and takes the sparkle at the middle off screen with it.
   */
  centre?: readonly [number, number];
  /**
   * Copies of the field in one revolution. 1 is once round, 3 gives three-fold
   * symmetry.
   *
   * Keep it whole. A fraction leaves the field part-way through itself where it
   * comes back round, which is a join even under `'mirror'`.
   */
  turns?: number;
  /**
   * Where the field's leading edge sits, in turns of the *picture* rather than
   * of the field - 0.25 is a quarter turn clockwise however many `turns` there
   * are. With `'wrap'` this is the dial that moves the join somewhere less
   * conspicuous.
   */
  rotate?: number;
  /**
   * How far the radius axis reaches, as a fraction of the distance to the
   * farthest corner.
   *
   * 1 - the default - is exactly far enough to fill the canvas. Below it the
   * field runs out before the corners do and its last row is stretched across
   * them; above it, the outermost rows are never seen.
   */
  radius?: number;
  /**
   * What happens where the angle axis meets itself again.
   *
   * A field is a rectangle, and its left and right edges have no reason to
   * agree - so wrapping one round a circle leaves a join along a radius.
   * `'mirror'`, the default, reflects at each edge instead of wrapping. It has
   * no join anywhere, at the cost of a picture symmetric about the fold, and it
   * puts a mirrored copy beside each of the `turns`. `'wrap'` keeps the field
   * the right way round throughout and shows the join, which is what you want
   * for a field that is already seamless in x - the plasma samples a seamless
   * tile - or when the join is wanted.
   */
  seam?: 'mirror' | 'wrap';
  /**
   * Which axis of the field carries the angle, leaving the other the radius.
   *
   * `'x'` - the default - lays the field's rows out as rings, so anything
   * travelling down the field travels outwards: rain falls away from the
   * centre. `'y'` lays its columns out as spokes, and the same motion becomes a
   * rotation about the centre instead.
   */
  angleAxis?: 'x' | 'y';
}

/** A polar setting, or the two ways of saying there is not one. */
export type PolarOption = Polar | boolean | null;

export const POLAR_DEFAULTS: Required<Polar> = {
  centre: [0.5, 0.5],
  turns: 1,
  rotate: 0,
  radius: 1,
  // Seamless by default. A background is meant to go unnoticed, and a hard
  // radial join is the one thing here that a reader's eye does catch.
  seam: 'mirror',
  angleAxis: 'x',
};

/**
 * Fills in a partial polar setting, or answers null for one that is off.
 *
 * Both `false` and `null` mean off, because both are what a host toggling this
 * from its own config naturally produces.
 */
export function resolvePolar(polar: PolarOption | undefined): Required<Polar> | null {
  if (!polar) return null;
  return polar === true ? POLAR_DEFAULTS : withDefaults(POLAR_DEFAULTS, polar);
}

const TAU = Math.PI * 2;

const CORNERS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

/**
 * How far the radius axis reaches, in the units `polarSample` measures in -
 * canvas fractions with x scaled by the aspect, so that a circle comes out
 * round rather than as an ellipse.
 *
 * Measured to the farthest corner rather than the nearest edge, because
 * anything shorter leaves the corners past the end of the field, where there is
 * nothing left to read but its last row smeared across them.
 */
export function polarReach(aspect: number, polar: Required<Polar>): number {
  const [cx, cy] = polar.centre;
  let far = 0;
  for (const [x, y] of CORNERS) far = Math.max(far, Math.hypot((x - cx) * aspect, y - cy));
  return far * polar.radius;
}

/**
 * A triangle wave: 0 up to 1 and back down, with period 2.
 *
 * This is what makes `'mirror'` seamless. Wrapping is discontinuous wherever it
 * comes back round; folding is continuous everywhere, so the field simply
 * reverses at each edge and there is nothing to see.
 */
function fold(t: number): number {
  const cycle = t - Math.floor(t / 2) * 2;
  return cycle > 1 ? 2 - cycle : cycle;
}

/**
 * Where an output point reads from, as fractions of the field's own two axes.
 *
 * `u` and `v` are the point on the canvas, 0..1 on each axis, and `aspect` is
 * its width over its height. `reach` is `polarReach`, taken as an argument so
 * that a loop over every pixel works it out once rather than per pixel.
 *
 * Shared by the lookup table and the pointer, which is the point of it being a
 * function at all: a drag has to be bent by exactly the transform the picture
 * is read through, or it disturbs the field somewhere other than where it was
 * aimed.
 */
export function polarSample(
  u: number,
  v: number,
  aspect: number,
  polar: Required<Polar>,
  reach: number = polarReach(aspect, polar)
): [number, number] {
  const dx = (u - polar.centre[0]) * aspect;
  const dy = v - polar.centre[1];

  // Clamped rather than allowed past the end: `radius` above 1 puts the corners
  // beyond the field, and reading its last row there beats reading past it.
  const distance = Math.hypot(dx, dy);
  const radius = reach > 0 ? (distance < reach ? distance / reach : 1) : 0;

  // `atan2` runs -pi..pi. The half turn added is what makes `rotate: 0` put the
  // field's leading edge at nine o'clock. `rotate` comes off the *revolution*
  // rather than off the field position, so that it turns the picture by the
  // amount it says whatever `turns` is set to - and it is subtracted rather than
  // added because the field moving one way round is the picture moving the
  // other, and a positive `rotate` should turn the picture clockwise.
  const revolution = Math.atan2(dy, dx) / TAU + 0.5 - polar.rotate;
  const along = revolution * polar.turns;

  // Doubled under a fold, because one revolution then covers the field out and
  // back - `turns` copies each with a mirrored twin, and no join at either end.
  const angle = polar.seam === 'wrap' ? along - Math.floor(along) : fold(along * 2);

  return polar.angleAxis === 'x' ? [angle, radius] : [radius, angle];
}

/** As far along an axis as the polar map is allowed to land. See `buildPolarMap`. */
const JUST_INSIDE = 1 - 1e-7;

/** One axis of the output-to-field lookup. */
interface AxisMap {
  i0: Int32Array;
  i1: Int32Array;
  t: Float32Array;
}

/**
 * Builds one axis of the output-to-field lookup.
 *
 * Precomputed per axis on resize so the inner loop is array lookups rather
 * than a divide and two floors per pixel.
 */
function mapAxis(out: number, cells: number): AxisMap {
  const i0 = new Int32Array(out);
  const i1 = new Int32Array(out);
  const t = new Float32Array(out);
  const span = out > 1 ? (cells - 1) / (out - 1) : 0;

  for (let i = 0; i < out; i++) {
    const f = i * span;
    const lo = Math.min(Math.floor(f), cells - 1);
    i0[i] = lo;
    i1[i] = Math.min(lo + 1, cells - 1);
    t[i] = f - lo;
  }
  return { i0, i1, t };
}

/**
 * Works out the output and field dimensions for a given CSS size.
 *
 * Pure, and exported because it is the bit worth testing: the two ceilings
 * interact, and getting either wrong is only visible as a frame rate.
 */
export function planSurface(
  cssWidth: number,
  cssHeight: number,
  options: SurfaceOptions
): { width: number; height: number; fieldW: number; fieldH: number } {
  let pixel = options.pixelSize;
  let width = Math.max(2, Math.ceil(cssWidth / pixel));
  let height = Math.max(2, Math.ceil(cssHeight / pixel));

  // Raise the pixel size rather than let the per-pixel loop grow without limit:
  // a 4K window would otherwise be four times the work of a 1080p one.
  if (width * height > options.maxPixels) {
    pixel = Math.ceil(pixel * Math.sqrt((width * height) / options.maxPixels));
    width = Math.max(2, Math.ceil(cssWidth / pixel));
    height = Math.max(2, Math.ceil(cssHeight / pixel));
  }

  let fieldW = Math.max(2, Math.ceil(width / options.fieldScale));
  let fieldH = Math.max(2, Math.ceil(height / options.fieldScale));

  // A separate, much harder ceiling. For a solver this matters far more than
  // the pixel count: it touches every cell a dozen or more times a frame where
  // the shading touches each output pixel once.
  if (fieldW * fieldH > options.maxFieldCells) {
    const shrink = Math.sqrt((fieldW * fieldH) / options.maxFieldCells);
    // Floored, not rounded: rounding can nudge both axes up and land a cell or
    // two over the ceiling this promises to be. The cost is at most one cell
    // per axis under budget, which the ceiling was never precise about anyway.
    fieldW = Math.max(2, Math.floor(fieldW / shrink));
    fieldH = Math.max(2, Math.floor(fieldH / shrink));
  }

  return { width, height, fieldW, fieldH };
}

/**
 * The canvas, its backing `ImageData`, and the lookup tables that map one onto
 * the other. Owns nothing about *how* the field is produced.
 */
export interface Surface {
  readonly width: number;
  readonly height: number;
  readonly fieldW: number;
  readonly fieldH: number;
  /**
   * Re-measures the canvas and reallocates if it changed shape. Returns true
   * if it did, which is the caller's cue to rebuild whatever the field lives
   * in - the buffers it handed over last time are the wrong size now.
   */
  resize(): boolean;
  /** Interpolates the field up, dithers it, and puts it on the canvas. */
  shade(field: Float32Array, shading: Shading, gamma: number): void;
}

export function createSurface(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  options: SurfaceOptions
): Surface {
  let image: ImageData | null = null;
  let width = 0;
  let height = 0;
  let fieldW = 0;
  let fieldH = 0;

  let mapX: AxisMap = { i0: new Int32Array(0), i1: new Int32Array(0), t: new Float32Array(0) };
  let mapY: AxisMap = mapX;

  // The polar lookup, when there is one: field coordinates per output pixel,
  // already scaled to the field's axes so the frame path has no multiply in it.
  // Two floats a pixel rather than the four indices and two weights the blend
  // actually wants - a floor is cheaper than three more megabytes.
  const polar = resolvePolar(options.polar);
  let polarX: Float32Array | null = null;
  let polarY: Float32Array | null = null;

  // Resolved on resize rather than per frame, because it depends on the size
  // the surface settled at. See `dither` in `SurfaceOptions`.
  let dithering = options.dither !== false;

  // The palette only changes when the shading does - a handful of times in a
  // page's life - so rebuilding it per frame was the one steady-state allocation
  // in the frame path. Cached against a *copy* of the shading, because the
  // natural way to drive `shade` is to mutate one shading object in place, and
  // comparing an object against itself would wave every change through.
  let palette: Uint8ClampedArray | null = null;
  let paletteShading: Shading | null = null;
  let paletteLevels = 0;

  function paletteFor(shading: Shading, levels: number): Uint8ClampedArray {
    if (palette && paletteLevels === levels && paletteShading && sameShading(shading, paletteShading)) {
      return palette;
    }
    palette = buildPalette(shading, levels);
    paletteShading = {
      base: shading.base,
      amplitude: shading.amplitude,
      tint: shading.tint ? [shading.tint[0], shading.tint[1], shading.tint[2]] : undefined,
      ramp: shading.ramp ? shading.ramp.map((stop) => [stop[0], stop[1], stop[2]] as const) : undefined,
      range: shading.range ? [shading.range[0], shading.range[1]] : undefined,
    };
    paletteLevels = levels;
    return palette;
  }

  // Gamma via a table rather than `Math.pow` per pixel, which was the dominant
  // per-pixel cost for the effects that use it - millions of transcendentals a
  // second. A thousand entries is far below what the 5-level quantise plus
  // dither can distinguish. Identity gamma skips the table entirely, so the
  // effects that bias their own fields lose nothing to it.
  const GAMMA_STEPS = 1024;
  let gammaTable: Float32Array | null = null;
  let gammaFor = 1;

  function gammaTableFor(gamma: number): Float32Array {
    if (!gammaTable || gammaFor !== gamma) {
      gammaTable = new Float32Array(GAMMA_STEPS);
      for (let i = 0; i < GAMMA_STEPS; i++) gammaTable[i] = Math.pow(i / (GAMMA_STEPS - 1), gamma);
      gammaFor = gamma;
    }
    return gammaTable;
  }

  /**
   * Evaluates the polar transform once per output pixel.
   *
   * The angle axis spans a whole cell more under `'wrap'` than under
   * `'mirror'`, because its last cell blends back into its first rather than
   * stopping at it - which is the difference between a seam a cell wide and a
   * seam that is merely where the field's two edges meet.
   *
   * Every axis is scaled to stop a hair inside its own end. That is what lets
   * the frame path treat a step past the last cell as a wrap and nothing else:
   * a fraction a ten-millionth short of 1 is indistinguishable on screen, and
   * without it one that rounded up to exactly 1 on its way into a `Float32Array`
   * would index a cell off the end of the field.
   */
  function buildPolarMap(): void {
    if (!polar) {
      polarX = null;
      polarY = null;
      return;
    }

    const aspect = height > 0 ? width / height : 1;
    const reach = polarReach(aspect, polar);
    const angleIsX = polar.angleAxis === 'x';
    const wraps = polar.seam === 'wrap';

    const angleCells = angleIsX ? fieldW : fieldH;
    const angleSpan = wraps ? angleCells : angleCells - 1;
    const radiusSpan = (angleIsX ? fieldH : fieldW) - 1;

    const spanX = angleIsX ? angleSpan : radiusSpan;
    const spanY = angleIsX ? radiusSpan : angleSpan;

    polarX = new Float32Array(width * height);
    polarY = new Float32Array(width * height);

    for (let y = 0; y < height; y++) {
      // Cell centres rather than corners, so the picture is not half a pixel
      // off the centre it was asked to turn about.
      const v = (y + 0.5) / height;
      for (let x = 0; x < width; x++) {
        const [fx, fy] = polarSample((x + 0.5) / width, v, aspect, polar, reach);
        const p = y * width + x;
        polarX[p] = Math.min(fx, JUST_INSIDE) * spanX;
        polarY[p] = Math.min(fy, JUST_INSIDE) * spanY;
      }
    }
  }

  function resize(): boolean {
    // The element's own box rather than the viewport, so a canvas that is not
    // full-screen still renders at its true size.
    const cssWidth = canvas.clientWidth || window.innerWidth;
    const cssHeight = canvas.clientHeight || window.innerHeight;

    const plan = planSurface(cssWidth, cssHeight, options);
    if (plan.width === width && plan.height === height) return false;

    width = plan.width;
    height = plan.height;
    fieldW = plan.fieldW;
    fieldH = plan.fieldH;
    // The size it actually settled at, which `maxPixels` may have coarsened.
    dithering = options.dither === 'auto' ? cssWidth > width : options.dither;

    canvas.width = width;
    canvas.height = height;
    image = ctx.createImageData(width, height);

    // Opaque canvas: every alpha byte is set once here and never touched again.
    const data = image.data;
    for (let i = 3; i < data.length; i += 4) data[i] = 255;

    mapX = mapAxis(width, fieldW);
    mapY = mapAxis(height, fieldH);
    buildPolarMap();
    return true;
  }

  function shade(field: Float32Array, shading: Shading, gamma: number): void {
    if (!image) return;
    const data = image.data;
    const { levels } = options;

    // One triple per level, resolved out here. Greyscale, tinted and ramped
    // shadings all collapse to the same table, so the inner loop does not care
    // which was asked for.
    const palette = paletteFor(shading, levels);
    const steps = levels > 1 ? levels - 1 : 1;

    const gammaLut = gamma === 1 ? null : gammaTableFor(gamma);

    const x0s = mapX.i0;
    const x1s = mapX.i1;
    const txs = mapX.t;

    // The polar lookup, hoisted so the inner loop's test is against a local.
    const px = polarX;
    const py = polarY;
    const maxX = fieldW - 1;
    const maxY = fieldH - 1;

    for (let y = 0; y < height; y++) {
      // The row-invariant half of the plain lookup. The polar path has no
      // row-invariant half - which field row it reads changes along the row as
      // well as down it - so it reads its own table per pixel instead.
      const rowA = mapY.i0[y] * fieldW;
      const rowB = mapY.i1[y] * fieldW;
      const ty = mapY.t[y];
      const rowStart = y * width;
      const rowOffset = rowStart * 4;

      for (let x = 0; x < width; x++) {
        let value: number;

        if (px && py) {
          const gx = px[rowStart + x];
          const gy = py[rowStart + x];

          // Stepping past the last cell can only be a wrapped angle axis coming
          // back round to its first: every axis is scaled to stop a hair inside
          // its own end, so nothing else ever reaches here. See `buildPolarMap`.
          const ax = gx | 0;
          let bx = ax + 1;
          if (bx > maxX) bx = 0;

          const ay = gy | 0;
          let by = ay + 1;
          if (by > maxY) by = 0;

          const above = ay * fieldW;
          const below = by * fieldW;
          const fx = gx - ax;
          const top = field[above + ax] + (field[above + bx] - field[above + ax]) * fx;
          const bottom = field[below + ax] + (field[below + bx] - field[below + ax]) * fx;
          value = top + (bottom - top) * (gy - ay);
        } else {
          const x0 = x0s[x];
          const x1 = x1s[x];
          const tx = txs[x];

          const top = field[rowA + x0] + (field[rowA + x1] - field[rowA + x0]) * tx;
          const bottom = field[rowB + x0] + (field[rowB + x1] - field[rowB + x0]) * tx;
          value = top + (bottom - top) * ty;
        }

        value = value < 0 ? 0 : value > 1 ? 1 : value;
        if (gammaLut) value = gammaLut[(value * (GAMMA_STEPS - 1) + 0.5) | 0];

        // Both branches return a value already snapped to the palette, so this
        // index is exact rather than a re-quantisation. The condition is
        // loop-invariant; splitting the loop in two to hoist it by hand would
        // duplicate the body for no measurable gain.
        const level = dithering ? orderedDither(value, x, y, levels) : quantise(value, levels);
        const index = Math.round(level * steps) * 3;
        const offset = rowOffset + x * 4;
        data[offset] = palette[index];
        data[offset + 1] = palette[index + 1];
        data[offset + 2] = palette[index + 2];
      }
    }

    ctx.putImageData(image, 0, 0);
  }

  return {
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    get fieldW() {
      return fieldW;
    },
    get fieldH() {
      return fieldH;
    },
    resize,
    shade,
  };
}
