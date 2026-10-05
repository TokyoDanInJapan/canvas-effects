// Index arithmetic on wrapped grids, shared by the effects that wrap.
//
// The smoke wraps both axes, the rain wraps its lanes sideways, and the plasma
// and tunnel read tiles that repeat. Each used to spell the wrap out as a double
// modulo where it was needed, which is a line nobody reads twice and nine
// places to make faster. It lives here rather than in any one of them, so that
// none has to import another's internals to get it.

/**
 * A whole cell index wrapped into `0..size-1`.
 *
 * Nearly every index handed to this is on the grid already, or one lap off it,
 * so the in-range case is tested first and the double modulo - a bare `%` keeps
 * the sign in JavaScript, and back-traced coordinates are routinely negative -
 * is only paid when it is needed. The answer is the same either way, `NaN`
 * included: both paths end in `| 0`, which reads it as cell 0.
 *
 * For whole numbers only. A fraction passes the range test and comes back
 * truncated rather than wrapped.
 */
export function wrapCell(n: number, size: number): number {
  return (n >= 0 && n < size ? n : ((n % size) + size) % size) | 0;
}
