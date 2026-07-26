# Security

## Reporting something

Use **[Report a vulnerability](https://github.com/TokyoDanInJapan/canvas-effects/security/advisories/new)** on
the Security tab. That is private: it opens an advisory only you and the maintainer can see, so a problem can be
fixed before it is described in public.

If that page is unavailable to you, open an ordinary issue saying only that you have something to report and
asking for a private channel. Do not put the details in it - a public issue discloses the problem in the act of
reporting it.

Expect an acknowledgement within a week. This is a small library maintained by one person, so a fix may take
longer than that; you will be told either way rather than left waiting.

## What is supported

The latest minor version, currently `2.x`. Older majors are not patched. There is one file to update and no
dependencies to reconcile, so upgrading is cheap - see the README for anything that changed.

## What the attack surface actually is

Worth stating plainly, because it is unusually small and that shapes what is worth reporting.

The library takes a `<canvas>` element and a set of numbers, and writes bytes into an `ImageData`. It makes no
network requests, reads no storage, parses nothing, and evaluates nothing. It has no runtime dependencies: the
published package is `dist` and `src`, and installing it adds nothing else to your tree. Every option is a
number, a boolean, or a callback you supplied yourself.

So the plausible reports are:

- **A crash or hang from an option value.** A `NaN` reaching a typed array, a loop that does not terminate for
  some `levels`, a field size that allocates without bound. These are real - a denial of service against the tab
  it is mounted in - and worth reporting.
- **Anything reaching the DOM beyond the canvas.** It sets `canvas.width` and `canvas.height` and calls
  `putImageData`. If a value you pass ends up anywhere else, that is a bug worth reporting privately.
- **A listener that outlives `destroy()`.** Not a vulnerability on its own, but a leak in a single-page
  application is the kind of thing that becomes one under memory pressure.

Two things that are **not** vulnerabilities here, so you need not report them:

- **Text over the background being hard to read.** `amplitude` is the contrast dial and the page decides it. The
  README's accessibility notes cover it.
- **The demo page in `demo/`.** It is a tuning tool, not part of the published package, and it renders its own
  copy through `innerHTML` from strings in the repository. It is not shipped and takes no input from anyone.
