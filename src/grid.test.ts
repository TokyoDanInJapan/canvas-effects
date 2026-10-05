import { describe, expect, it } from 'vitest';

import { wrapCell } from './grid.js';

describe('wrapCell', () => {
  it('leaves an index already on the grid alone', () => {
    for (let n = 0; n < 7; n++) expect(wrapCell(n, 7)).toBe(n);
  });

  it('wraps one lap off either end', () => {
    expect(wrapCell(-1, 7)).toBe(6);
    expect(wrapCell(7, 7)).toBe(0);
    expect(wrapCell(9, 7)).toBe(2);
  });

  it('agrees with the double modulo however far out it starts', () => {
    for (let n = -100; n <= 100; n++) expect(wrapCell(n, 7)).toBe(((n % 7) + 7) % 7);
  });

  it('reads NaN as cell 0 rather than an index off the array', () => {
    expect(wrapCell(NaN, 7)).toBe(0);
  });
});
