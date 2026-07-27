// The loop and the listeners, shared by every effect.
//
// Nothing here knows what is being drawn. It owns four things that every
// long-lived canvas background has to get right and that are easy to get wrong
// one at a time:
//
//   • a frame loop throttled to a target rate rather than the refresh rate,
//     because none of these effects gains anything from 120fps
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
  /**
   * Starts the loop if it is not already running.
   *
   * While the tab is hidden and `pauseWhenHidden` is set this only records the
   * intent, and the loop begins when the tab is shown again.
   */
  start(): void;
  /**
   * Stops the loop. Safe to call when already stopped.
   *
   * It stays stopped: showing the tab again does not undo this, only a further
   * `start` does.
   */
  stop(): void;
  /** Stops the loop and removes every listener. */
  destroy(): void;
  /** True while the loop is actually drawing - false while paused by a hidden tab. */
  readonly running: boolean;
}

export function createDriver(canvas: HTMLCanvasElement, options: DriverOptions): Driver {
  let frame = 0;
  let lastDrawn = 0;
  const teardown: Array<() => void> = [];

  // A non-positive rate would make the interval infinite, so the loop would
  // report itself running and never draw. Taken as one frame a second instead:
  // a bad value is visible as a slideshow, a silent one is a mystery.
  const interval = 1000 / (options.fps > 0 ? options.fps : 1);

  // Whether the *host* wants the loop running, as distinct from whether it
  // currently is. Hiding the tab stops the loop without changing this, so
  // showing it again resumes only what was running beforehand.
  //
  // Keeping the two apart is what stops `visibilitychange` from starting a loop
  // nobody asked for. Without it, a background left deliberately stopped -
  // either by the host calling `stop`, or by reduced motion meaning it was never
  // started at all - would begin animating the first time the visitor switched
  // tabs and came back.
  let wanted = false;

  function tick(now: number) {
    frame = requestAnimationFrame(tick);
    if (now - lastDrawn < interval) return;
    // Carry the remainder rather than snapping to `now`. Snapping rounds every
    // gap up to a whole display frame, so a 24fps target on a 60Hz screen
    // actually draws at 20fps - and at some other rate on a 120Hz one. Keeping
    // the overshoot means the *average* interval is the target, whatever the
    // refresh rate happens to be.
    lastDrawn = now - ((now - lastDrawn) % interval);
    options.onFrame();
  }

  /**
   * Starts the loop unless the tab is hidden, in which case waiting is the point.
   *
   * The hidden check is conditional on `pauseWhenHidden`, because that is what
   * decides whether anything will ever start it again: with no visibility
   * listener registered, refusing to start here would leave a host that mounted
   * in a background tab stopped forever.
   */
  function run() {
    if (frame) return;
    if (options.pauseWhenHidden && document.hidden) return;
    frame = requestAnimationFrame(tick);
  }

  function pause() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  function start() {
    wanted = true;
    run();
  }

  function stop() {
    wanted = false;
    pause();
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
    // `pause`/`run` rather than `stop`/`start`: this is the tab's opinion about
    // whether drawing is worth anything, not the host's about whether it wants
    // to be drawing at all.
    const onVisibility = () => {
      if (document.hidden) pause();
      else if (wanted) run();
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
   * Distance between emissions along the drag, as a fraction of the canvas's
   * shorter side.
   *
   * This is a *sampling interval*, not a throttle, and the difference is what
   * makes a drag feel continuous. A throttle only ever emits where a pointer
   * event happened, so a fast drag - where the browser may deliver one event per
   * 100px - leaves a dotted line. This walks the segment between the last
   * emission and the current position, emitting every `spacing` along the way,
   * so the stroke is evenly spaced however fast the pointer moved.
   *
   * Keep it small. It is what the stroke's resolution costs, not a rate limit.
   */
  spacing: number;
  /**
   * Ceiling on emissions from a single move event, so one enormous jump - a
   * pointer re-entering the window, say - cannot flood a frame.
   */
  maxPerMove: number;
  /**
   * Called on press, and at every `spacing` along a drag.
   *
   * `u` and `v` are normalised to the canvas box, 0..1 on each axis. `du` and
   * `dv` are the step taken since the previous emission, in the same units, and
   * are zero on the initial press.
   *
   * The step is worth having where an effect wants a shove rather than a
   * position, because it is *resampled*: every emission along a drag carries the
   * same `spacing`-sized step, so the total handed over is proportional to the
   * distance the pointer actually travelled and does not depend on how often the
   * browser deigned to deliver an event. A raw `movementX` does depend on that,
   * which is what makes it an unreliable way to measure a drag - and it is 0 or
   * absent for touch pointers besides.
   */
  onEmit: (u: number, v: number, du: number, dv: number) => void;
  /**
   * Called when a drag ends - pointer up, pointer cancelled, or the tab losing
   * focus mid-drag. Not called if no drag was in progress.
   *
   * Only effects that hold something need this. An effect that emits into the
   * field and forgets - a ripple, a wobble - has nothing to let go of.
   */
  onRelease?: () => void;
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
  // Which pointer the drag belongs to. Listening on the window means every
  // finger on the screen reports here, and treating them as one path would
  // re-anchor the drag on each second touch and then zigzag between the two.
  // The first pointer down owns the drag until it is released.
  let pointer = -1;
  let lastX = 0;
  let lastY = 0;

  /** Normalised position, or null if the canvas has no box to measure against. */
  function locate(event: PointerEvent): [number, number] | null {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return [(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height];
  }

  /** Ends a drag if one is in progress, telling the caller once and only once. */
  function release() {
    if (!dragging) return;
    dragging = false;
    pointer = -1;
    options.onRelease?.();
  }

  /** A release, but only from the pointer that owns the drag. */
  function onUp(event: PointerEvent) {
    if (event.pointerId === pointer) release();
  }

  function onDown(event: PointerEvent) {
    if (dragging) return;
    const at = locate(event);
    if (!at) return;
    // Only a press inside the canvas box starts a drag. The window-level
    // listener sees every press on the page, and `locate` happily extrapolates
    // beyond the box, so without this a canvas smaller than the viewport would
    // react - at an aliased position - to clicks that have nothing to do with it.
    if (at[0] < 0 || at[0] > 1 || at[1] < 0 || at[1] > 1) return;
    dragging = true;
    pointer = event.pointerId;
    lastX = at[0];
    lastY = at[1];
    // No step on a press: there is nothing to have moved from yet.
    options.onEmit(at[0], at[1], 0, 0);
  }

  function onMove(event: PointerEvent) {
    if (!dragging || event.pointerId !== pointer) return;
    // `buttons` as well as our own flag: a pointerup that lands outside the
    // window never reaches us, and without this the drag would stay stuck on.
    if (event.buttons === 0) {
      release();
      return;
    }

    const at = locate(event);
    if (!at) return;

    // A drag that wanders off the canvas walks along its edge rather than
    // beyond it, which keeps every emission inside the 0..1 the callback is
    // promised - the box is convex, so a segment between two clamped points
    // never leaves it.
    at[0] = at[0] < 0 ? 0 : at[0] > 1 ? 1 : at[0];
    at[1] = at[1] < 0 ? 0 : at[1] > 1 ? 1 : at[1];

    // Measured in pixels against the shorter side, so `spacing` means the same
    // thing whichever way round the window is.
    const rect = canvas.getBoundingClientRect();
    const step = options.spacing * Math.min(rect.width, rect.height);
    if (step <= 0) return;

    const dx = (at[0] - lastX) * rect.width;
    const dy = (at[1] - lastY) * rect.height;
    const travelled = Math.hypot(dx, dy);
    if (travelled < step) return;

    // Walk the segment rather than emitting only at its end. A fast drag can
    // deliver one move event per hundred pixels, and emitting at the endpoint
    // alone is exactly what makes a stroke come out dotted.
    const steps = Math.min(Math.floor(travelled / step), options.maxPerMove);
    const spanU = at[0] - lastX;
    const spanV = at[1] - lastY;

    // One step's worth of the segment, and the same for every emission along it -
    // which is what makes the deltas add up to the distance travelled.
    const fraction = step / travelled;
    const du = spanU * fraction;
    const dv = spanV * fraction;

    for (let i = 1; i <= steps; i++) {
      const t = i * fraction;
      options.onEmit(lastX + spanU * t, lastY + spanV * t, du, dv);
    }

    // Advance to the last point actually emitted, so the remainder carries into
    // the next event instead of being rounded away every time.
    const covered = (steps * step) / travelled;
    lastX += spanU * covered;
    lastY += spanV * covered;
  }

  window.addEventListener('pointerdown', onDown, { passive: true });
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerup', onUp, { passive: true });
  window.addEventListener('pointercancel', onUp, { passive: true });
  // A drag interrupted by the tab losing focus should not resume on return.
  window.addEventListener('blur', release);

  return () => {
    // Anything being held is let go of, so an effect that unmounts mid-drag is
    // not left believing the pointer still has hold of it.
    release();
    window.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('blur', release);
  };
}

/** True if the visitor has asked for less motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
