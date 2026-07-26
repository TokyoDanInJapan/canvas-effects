// Turning a continuous field into a handful of greys, shared by every background.
//
// Ordered dithering with a 4x4 Bayer matrix, plus the quantisation it is built
// on and the tonal bias that goes with it. Every background here renders a field
// and then posterises it hard; this is the half that makes the result read as
// smooth rather than as bands.

/**
 * Weights the field towards its dark end.
 *
 * A gamma of 1 leaves it alone; above 1 pushes values down, so more of the
 * background sits in the darker levels. Both ends are fixed points, so this
 * redistributes the field *within* the palette without changing the palette
 * itself - the lightest and darkest greys stay exactly where they were, and
 * only the balance between them moves.
 *
 * The defaults are solved rather than guessed - see `gamma` in
 * `PLASMA_BACKGROUND_DEFAULTS` and `SMOKE_BACKGROUND_DEFAULTS`, and the
 * "Tuning" section of the README.
 */
export function darken(value: number, gamma: number): number {
  const clamped = value < 0 ? 0 : value > 1 ? 1 : value;
  return gamma === 1 ? clamped : Math.pow(clamped, gamma);
}

/** Flattens a 0..1 value onto `levels` evenly spaced steps, endpoints included. */
export function quantise(value: number, levels: number): number {
  if (levels <= 1) return 0;
  const clamped = value < 0 ? 0 : value > 1 ? 1 : value;
  return Math.round(clamped * (levels - 1)) / (levels - 1);
}

/**
 * The classic 4x4 Bayer matrix, normalised to `(m + 0.5) / 16` so the values
 * are evenly spread across `(0, 1)` with a mean of exactly 0.5.
 *
 * A mean of 0.5 is the whole trick: the offset it adds to a pixel averages out
 * to nothing, so dithering shifts *which* level each pixel lands on without
 * shifting the average brightness of the region.
 */
export const BAYER_4X4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((m) => (m + 0.5) / 16);

/**
 * Ordered dithering: quantise, but let the pixel's position decide which way it
 * rounds.
 *
 * Posterising a smooth field on its own gives flat plateaus with visible steps
 * between them. Nudging each pixel by its cell's Bayer threshold first means a
 * value halfway between two levels lands on the lower one for half the pixels
 * in the cell and the higher one for the other half - so the region reads as
 * the intermediate shade, and a gradient crossing it breaks up into texture
 * rather than a band. It is what makes a four-level palette look smooth.
 *
 * `x` and `y` are pixel coordinates; only their low two bits matter.
 */
export function orderedDither(value: number, x: number, y: number, levels: number): number {
  if (levels <= 1) return 0;
  const threshold = BAYER_4X4[(y & 3) * 4 + (x & 3)];
  const step = 1 / (levels - 1);
  return quantise(value + step * (threshold - 0.5), levels);
}
