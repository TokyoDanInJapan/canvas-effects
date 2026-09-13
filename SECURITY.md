# Security

## Report a problem

Use **[Report a vulnerability](https://github.com/TokyoDanInJapan/canvas-effects/security/advisories/new)** on the
Security tab. The report is private. Only you and the maintainer can see it, so the problem can be fixed before it is
public.

If you cannot use that page, open an issue that asks for a private channel. Do not put the details in the issue, because
issues are public.

You will get a reply within a week. One person maintains this library, so a fix can take longer. You will get an update
either way.

## Supported versions

Only the latest minor version of `2.x` gets fixes. Older major versions do not. The library has no dependencies, so an
upgrade is easy. The README describes any changes.

## Attack surface

The attack surface is small, and this affects what is useful to report.

The library takes a `<canvas>` element and a set of options, and writes bytes into an `ImageData`. It makes no network
requests, reads no storage, parses nothing and evaluates nothing. It has no runtime dependencies. The published package
contains `dist` and `src` only. Every option is a number, a boolean or a callback that you supply.

Please report these problems:

- **A crash or hang caused by an option value.** Examples are a `NaN` in a typed array, a loop that does not end for
  some `levels`, or a field size with no memory limit. These can stop the browser tab.
- **A change to the DOM outside the canvas.** The library sets `canvas.width` and `canvas.height` and calls
  `putImageData`. If a value that you pass goes anywhere else, report it privately.
- **A listener that stays after `destroy()`.** This alone is not a vulnerability. In a single-page app, a leak can become
  one under memory pressure.

These are not vulnerabilities, so you do not need to report them:

- **Text on the background is hard to read.** The page sets `amplitude`, which controls contrast. See the accessibility
  section of the README.
- **The demo page in `demo/`.** It is a tuning tool and is not in the published package. It writes text from the
  repository into the page with `innerHTML`, and it takes no input.
