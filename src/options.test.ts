import { describe, expect, it } from 'vitest';

import { withDefaults } from './options';

const DEFAULTS = { gamma: 1, levels: 5, label: 'smoke', flag: true };

describe('withDefaults', () => {
  it('applies the defaults when nothing is given', () => {
    expect(withDefaults(DEFAULTS, {})).toEqual(DEFAULTS);
  });

  it('lets a caller override', () => {
    expect(withDefaults(DEFAULTS, { gamma: 2.5 }).gamma).toBe(2.5);
  });

  it('ignores an explicit undefined, which plain spread does not', () => {
    // The whole reason this function exists. Forwarding a caller's own optional
    // config passes `undefined` for anything they did not set, and a bare
    // spread would overwrite the default with it.
    expect({ ...DEFAULTS, ...{ gamma: undefined } }.gamma).toBeUndefined();
    expect(withDefaults(DEFAULTS, { gamma: undefined }).gamma).toBe(1);
  });

  it('ignores undefined without discarding the keys either side of it', () => {
    const merged = withDefaults(DEFAULTS, { gamma: undefined, levels: 3 });
    expect(merged).toEqual({ ...DEFAULTS, levels: 3 });
  });

  it('keeps falsy values that are not undefined', () => {
    // 0 and false are real settings; only "absent" should fall back.
    const merged = withDefaults(DEFAULTS, { gamma: 0, flag: false, label: '' });
    expect(merged.gamma).toBe(0);
    expect(merged.flag).toBe(false);
    expect(merged.label).toBe('');
  });

  it('does not mutate either argument', () => {
    const defaults = { ...DEFAULTS };
    const options = { gamma: 2 };
    withDefaults(defaults, options);
    expect(defaults).toEqual(DEFAULTS);
    expect(options).toEqual({ gamma: 2 });
  });

  it('guards the failure that motivated it: no NaN reaches the canvas', () => {
    // undefined -> Math.pow -> NaN -> Uint8ClampedArray -> 0, silently.
    const { gamma } = withDefaults(DEFAULTS, { gamma: undefined });
    const shaded = Math.pow(0.5, gamma);
    expect(Number.isNaN(shaded)).toBe(false);

    const pixel = new Uint8ClampedArray(1);
    pixel[0] = 18 + shaded * 26;
    expect(pixel[0]).toBeGreaterThan(0);
  });
});
