// The half both effects share: a coarse field interpolated up to a fat-pixel
// canvas and ordered-dithered on the way.
//
// TWO RESOLUTIONS
// ---------------
// What makes these cheap is that they render at two scales at once:
//
//   • The **field** - the expensive part, whatever generates it - is computed
//     at `pixelSize * fieldScale` CSS pixels per cell. Both fields here are
//     soft and low-frequency and gain nothing from more samples, and this is
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

import { darken, orderedDither } from './dither';

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
}

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
  /** Palette size. Small on purpose - the dither is what makes it smooth. */
  levels: number;
}

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
    fieldW = Math.max(2, Math.round(fieldW / shrink));
    fieldH = Math.max(2, Math.round(fieldH / shrink));
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

    canvas.width = width;
    canvas.height = height;
    image = ctx.createImageData(width, height);

    // Opaque canvas: every alpha byte is set once here and never touched again.
    const data = image.data;
    for (let i = 3; i < data.length; i += 4) data[i] = 255;

    mapX = mapAxis(width, fieldW);
    mapY = mapAxis(height, fieldH);
    return true;
  }

  function shade(field: Float32Array, shading: Shading, gamma: number): void {
    if (!image) return;
    const data = image.data;
    const { base, amplitude, tint } = shading;
    const { levels } = options;

    // Folded into the amplitude once, out here, rather than multiplied per
    // pixel. Untinted shading leaves all three equal, which is the greyscale
    // the other effects expect.
    const ampR = tint ? amplitude * tint[0] : amplitude;
    const ampG = tint ? amplitude * tint[1] : amplitude;
    const ampB = tint ? amplitude * tint[2] : amplitude;

    const x0s = mapX.i0;
    const x1s = mapX.i1;
    const txs = mapX.t;

    for (let y = 0; y < height; y++) {
      const rowA = mapY.i0[y] * fieldW;
      const rowB = mapY.i1[y] * fieldW;
      const ty = mapY.t[y];
      const rowOffset = y * width * 4;

      for (let x = 0; x < width; x++) {
        const x0 = x0s[x];
        const x1 = x1s[x];
        const tx = txs[x];

        const top = field[rowA + x0] + (field[rowA + x1] - field[rowA + x0]) * tx;
        const bottom = field[rowB + x0] + (field[rowB + x1] - field[rowB + x0]) * tx;
        const value = darken(top + (bottom - top) * ty, gamma);

        const level = orderedDither(value, x, y, levels);
        const offset = rowOffset + x * 4;
        data[offset] = base + level * ampR;
        data[offset + 1] = base + level * ampG;
        data[offset + 2] = base + level * ampB;
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
