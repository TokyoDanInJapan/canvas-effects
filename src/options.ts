// Merging caller options over defaults, without letting `undefined` through.
//
// WHY THIS EXISTS
// ---------------
// `{ ...DEFAULTS, ...options }` looks like it applies defaults, and does not
// quite: a key present with the value `undefined` overwrites the default with
// `undefined` rather than falling back to it. That is ordinary spread
// behaviour, and a menace for an options object, because the natural way to
// forward a caller's own optional config -
//
//   createSmokeBackground(canvas, { gamma: theirConfig.gamma })
//
// - passes `gamma: undefined` whenever they did not set it.
//
// The failure that follows is silent and hard to trace. `undefined` reaches
// `Math.pow`, which returns `NaN`; `NaN` propagates through the shading; and
// assigning `NaN` to a `Uint8ClampedArray` writes `0` rather than throwing. The
// result is a black canvas, no console error, and nothing to grep for.
//
// Found exactly that way: a dial was missing from the demo's list, the whole
// background went black, and nothing anywhere reported a problem.

/**
 * Applies `options` over `defaults`, ignoring keys whose value is `undefined`.
 *
 * An explicit `null` is *not* ignored - that is a caller saying something,
 * whereas `undefined` is almost always a caller saying nothing.
 */
export function withDefaults<T extends object>(defaults: T, options: Partial<T>): T {
  const merged = { ...defaults };

  for (const key of Object.keys(options) as Array<keyof T>) {
    const value = options[key];
    if (value !== undefined) merged[key] = value;
  }

  return merged;
}
