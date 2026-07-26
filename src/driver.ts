// The loop and the listeners, shared by both effects.
//
// Nothing here knows what is being drawn. It owns four things that every
// long-lived canvas background has to get right and that are easy to get wrong
// one at a time:
//
//   • a frame loop throttled to a target rate rather than the refresh rate,
//     because neither of these effects gains anything from 120fps
//   • stopping entirely when the tab is hidden, so a backgrounded page costs
//     nothing
//   • re-measuring when the canvas changes size
//   • noticing a theme change, so the greys follow the page without waiting for
//     a navigation
//
// Every listener it adds is removed again by `destroy`, so a single-page app
// that mounts and unmounts these does not leak.

export interface DriverOptions {
  /** Target frames per second. */
  fps: number;
  /** Called at most `fps` times a second while running. */
  onFrame: () => void;
  /** Called when the canvas has changed size. */
  onResize: () => void;
  /** Called when the theme may have changed. */
  onThemeChange: () => void;
  /** Stop the loop while the tab is hidden. */
  pauseWhenHidden: boolean;
  /**
   * Watch the `class` attribute of `<html>` and treat a change as a possible
   * theme change. This is how most CSS frameworks flip dark mode.
   */
  watchThemeClass: boolean;
  /** Also follow the OS-level `prefers-color-scheme`. */
  watchColorScheme: boolean;
}

export interface Driver {
  /** Starts the loop if it is not already running. */
  start(): void;
  /** Stops the loop. Safe to call when already stopped. */
  stop(): void;
  /** Stops the loop and removes every listener. */
  destroy(): void;
  /** True while the loop is running. */
  readonly running: boolean;
}

export function createDriver(canvas: HTMLCanvasElement, options: DriverOptions): Driver {
  let frame = 0;
  let lastDrawn = 0;
  const teardown: Array<() => void> = [];

  function tick(now: number) {
    frame = requestAnimationFrame(tick);
    if (now - lastDrawn < 1000 / options.fps) return;
    lastDrawn = now;
    options.onFrame();
  }

  function start() {
    if (!frame) frame = requestAnimationFrame(tick);
  }

  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  // ResizeObserver where it exists, because the canvas is not necessarily
  // full-screen; the window fallback covers the usual case everywhere else.
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => options.onResize());
    observer.observe(canvas);
    teardown.push(() => observer.disconnect());
  } else {
    const onWindowResize = () => options.onResize();
    window.addEventListener('resize', onWindowResize);
    teardown.push(() => window.removeEventListener('resize', onWindowResize));
  }

  if (options.pauseWhenHidden) {
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    teardown.push(() => document.removeEventListener('visibilitychange', onVisibility));
  }

  if (options.watchThemeClass) {
    const observer = new MutationObserver(() => options.onThemeChange());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    teardown.push(() => observer.disconnect());
  }

  if (options.watchColorScheme && typeof window.matchMedia === 'function') {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => options.onThemeChange();
    query.addEventListener('change', onScheme);
    teardown.push(() => query.removeEventListener('change', onScheme));
  }

  return {
    start,
    stop,
    destroy() {
      stop();
      for (const off of teardown) off();
      teardown.length = 0;
    },
    get running() {
      return frame !== 0;
    },
  };
}

export interface DragOptions {
  /**
   * Least the pointer must travel between emissions, as a fraction of the
   * canvas's shorter side.
   *
   * Gating on distance rather than on time is what makes a slow, careful drag
   * emit as densely as a fast one - a time-based throttle bunches everything up
   * when the pointer is moving slowly and leaves gaps when it is quick.
   */
  spacing: number;
  /** Called on press, and again each time the pointer has moved `spacing`. */
  onEmit: (u: number, v: number) => void;
}

/**
 * Turns presses and drags on the page into a stream of positions.
 *
 * Listened for on `window` rather than the canvas, which every interaction here
 * has to do: a background canvas is `pointer-events: none` so it never
 * intercepts anything meant for the page, and therefore never sees a pointer
 * itself.
 *
 * Positions are normalised to the canvas box, 0..1 on each axis, so each effect
 * converts into whatever units it thinks in - cells, screen widths, rows.
 *
 * Returns a teardown that removes every listener it added.
 */
export function createDragSource(canvas: HTMLCanvasElement, options: DragOptions): () => void {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  /** Normalised position, or null if the canvas has no box to measure against. */
  function locate(event: PointerEvent): [number, number] | null {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return [(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height];
  }

  function onDown(event: PointerEvent) {
    const at = locate(event);
    if (!at) return;
    dragging = true;
    lastX = at[0];
    lastY = at[1];
    options.onEmit(at[0], at[1]);
  }

  function onMove(event: PointerEvent) {
    // `buttons` as well as our own flag: a pointerup that lands outside the
    // window never reaches us, and without this the drag would stay stuck on.
    if (!dragging || event.buttons === 0) {
      dragging = false;
      return;
    }

    const at = locate(event);
    if (!at) return;

    // Measured against the shorter side, so `spacing` means the same thing
    // whichever way round the window is.
    const rect = canvas.getBoundingClientRect();
    const shorter = Math.min(rect.width, rect.height);
    const dx = (at[0] - lastX) * rect.width;
    const dy = (at[1] - lastY) * rect.height;
    if (Math.hypot(dx, dy) < options.spacing * shorter) return;

    lastX = at[0];
    lastY = at[1];
    options.onEmit(at[0], at[1]);
  }

  function onUp() {
    dragging = false;
  }

  window.addEventListener('pointerdown', onDown, { passive: true });
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerup', onUp, { passive: true });
  window.addEventListener('pointercancel', onUp, { passive: true });
  // A drag interrupted by the tab losing focus should not resume on return.
  window.addEventListener('blur', onUp);

  return () => {
    window.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('blur', onUp);
  };
}

/** True if the visitor has asked for less motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
