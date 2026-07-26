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

/** True if the visitor has asked for less motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
