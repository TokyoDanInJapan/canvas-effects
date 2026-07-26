# canvas-effects

Two animated, ordered-dithered greyscale backgrounds for a 2D canvas. They are built to sit **behind body text**, so
they modulate the page colour rather than becoming a picture, and they are quiet enough that a reader should not
consciously notice them.

No WebGL, no shaders, no dependencies. A 2D context, some typed arrays and `putImageData`.

![The smoke background behind a page of text](docs/smoke.png)

**Smoke** is an actual fluid simulation — semi-Lagrangian advection with a Jacobi pressure projection, the scheme from
Jos Stam's _Stable Fluids_. It has momentum: eddies get spun up by the flow, persist after whatever made them has gone,
and interact. Every ten seconds or so a jet fires in from a random edge and shoves everything aside. Dragging the cursor
stirs it.

![The plasma background behind a page of text](docs/plasma.png)

**Plasma** is a domain warp — fractal Brownian motion folded into itself, `fbm(p + fbm(p + fbm(p)))` — sampling a
seamless plasma tile. Cheaper than the smoke and stateless in time, so it can be drawn at any moment without having
drawn the moments before it.

---

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [How they work](#how-they-work)
  - [The shared half: two resolutions and a dither](#the-shared-half-two-resolutions-and-a-dither)
  - [Smoke: a fluid solver](#smoke-a-fluid-solver)
  - [Plasma: a domain warp](#plasma-a-domain-warp)
- [Using it](#using-it)
  - [Shading and themes](#shading-and-themes)
  - [The handle](#the-handle)
  - [Options](#options)
  - [Tuning](#tuning)
- [Performance](#performance)
- [Accessibility](#accessibility)
- [Using the pieces on their own](#using-the-pieces-on-their-own)
- [Examples](#examples)
- [Development](#development)
- [Licence](#licence)

---

## Install

```bash
npm install canvas-effects
```

Or straight from a CDN, no build step:

```js
import { createSmokeBackground } from 'https://esm.sh/canvas-effects';
```

## Quick start

```html
<canvas id="bg" aria-hidden="true"></canvas>

<style>
  #bg {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: -1;
    pointer-events: none;
    image-rendering: pixelated;
  }
</style>

<script type="module">
  import { createSmokeBackground } from 'canvas-effects';

  createSmokeBackground(document.getElementById('bg'), {
    shading: { base: 18, amplitude: 26 },
  });
</script>
```

Three things in that CSS are load-bearing, not decoration:

| Declaration                  | Why                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `image-rendering: pixelated` | The canvas is drawn at one pixel per dither cell and stretched up by CSS. Let the browser smooth it and you have undone the entire dither. |
| `pointer-events: none`       | A full-bleed fixed canvas would otherwise eat every click on the page.                                                                     |
| `z-index: -1` + `position`   | Puts it behind the content but above the page background.                                                                                  |

And `base` in the shading **must match the colour of the page behind it**. The canvas is opaque — it paints the page
colour itself rather than letting CSS show through — so if the two disagree you get a visible seam at the canvas edge.

---

## How they work

### The shared half: two resolutions and a dither

Both effects render at two scales at once, and this is what makes them cheap enough to leave running:

- The **field** — the expensive part, whatever generates it — is computed at `pixelSize × fieldScale` CSS pixels per
  cell. Both fields here are soft and low-frequency and gain nothing from more samples. This is where all the real work
  happens, and it stays at a few thousand cells whatever the window is doing.
- The **output** is `pixelSize` CSS pixels per pixel, bilinearly interpolated up from that field and then dithered. Per
  pixel that is a handful of multiply-adds and a table lookup.

Then the output is posterised to five greys — and that is where the dither earns its place.

**Why dither at all?** A five-level palette on its own gives five flat plateaus with visible steps between them. Nudging
each pixel by its 4×4 Bayer threshold before rounding means a value halfway between two levels lands on the lower one
for half the pixels in the cell and the higher one for the other half. The region reads as the intermediate shade, and a
gradient crossing it breaks into texture rather than a band.

The Bayer matrix is normalised to `(m + 0.5) / 16`, which averages to **exactly 0.5**. That is the property the whole
effect rests on: the offset it adds averages to nothing, so dithering changes _which_ level a pixel lands on without
changing the average brightness of a region. There is a unit test pinning it.

Finally, every pixel is `base + level × amplitude`. That is what makes these usable behind text: the effect modulates a
page colour over a narrow range instead of replacing it.

### Smoke: a fluid solver

`src/smoke.ts`. Each frame:

1. **forces** — buoyancy from the smoke's own density, plus a light noise stir
2. **confinement** — put back the small-scale swirl the solver eats
3. **advect** — carry the velocity field through itself
4. **project** — remove the divergence, so the fluid stops compressing
5. **advect** — carry the density through the corrected velocity
6. **replenish** — feed a little source back in

The grid wraps in both directions, which makes the boundary conditions periodic — both the easiest case to solve and the
one with no edges for a reader to notice.

#### Why a solver and not curl noise

A curl-noise flow is divergence-free, swirls convincingly, and is far cheaper. What it does not have is **momentum**.
Its eddies are prescribed by a noise field rather than caused by anything, so they cannot be spun up by the smoke,
cannot persist once whatever made them has gone, and cannot interact. A real solver gets vortices shedding off shear
layers, plumes that overturn because they are heavy, and structure with a history. That is the difference between
something that looks like smoke in a still frame and something that behaves like it in motion.

#### Step 4 is the whole thing

Advection on its own lets the fluid compress: density piles up, and it reads as a texture being stretched. Solving for
the pressure whose gradient cancels the divergence, and subtracting it, is what makes it a fluid rather than a warp.
`smoke.test.ts` asserts the projection removes ~90% of the divergence in one go, and that more iterations removes more.

#### Four things that were not obvious, all found by measuring

**Central differences for both the divergence and the gradient is wrong**, and wrong in a way that looks like a physics
problem rather than a discretisation one. They compose into a Laplacian spanning two cells, which is not the compact
five-point stencil the pressure is solved against — so odd and even cells decouple and most of the divergence survives
the projection. Backward differences for the divergence and forward for the gradient telescope into exactly
`p[l] + p[r] + p[u] + p[d] - 4p[c]`. That one change took the residual from 35% to under 10%.

**Plain semi-Lagrangian advection is too diffusive to hold smoke together.** It resamples every cell every step, so the
field smooths itself out even where the flow is only carrying it — and smoke without sharp edges is fog. MacCormack
advection (advect forward, advect back, subtract half the round-trip error) is what keeps the edges. The clamp to the
cells the trace actually read is not optional: without it the correction overshoots at exactly the edges it exists to
preserve, pushing densities outside 0..1 and eventually blowing the field up.

**Drag dominates the look.** It sets the flow speed, which sets how fast the smoke mixes itself towards uniform. Fast
flow looks livelier frame to frame and reads as fog within seconds. It has to serve both sides: low enough that a jet's
momentum crosses the field, high enough that the ambient does not mix itself to fog between jets. It is paired with
`replenish`, which keeps re-establishing the structure the flow is mixing away — re-sweep the two together if you touch
either.

**Cap the simulation grid, not just the output.** The solver touches every cell a dozen times a frame where shading
touches each pixel once, so `maxSimCells` matters far more than `maxPixels`.

#### Jets

Every ten seconds or so a nozzle opens on a random edge and fires across the field for a second or two. About half are
dark: a pale jet drives the density up and paints a bright plume, a dark one drives it to nothing and carves a clear
channel through whatever is there. The momentum is identical either way — the difference is only what the nozzle emits,
which is why both distort the smoke by the same amount.

The point is momentum, not smoke: it drives the fluid hard enough to shove what is already there aside, and the hole it
opens and the vortices rolling off its edges are the effect. The velocity is _driven towards_ the jet's rather than
added to it, so the nozzle behaves like an inflow boundary and holds a fixed speed however hard the surrounding fluid
and the drag push back — adding would make its strength depend on the frame rate and on how long it had been running.

Two things this got wrong on the way, both instructive. A jet is not a puff: the first version dropped a blob of
_density_ in, which barely showed, because density added to an already-dense field is mostly clamped away and adds no
motion at all. And a jet needs something to distort — the ambient was briefly thinned right down to give that blob
headroom, which left the jets tearing through nothing.

#### The cursor stirs it

Dragging with a button held pushes the fluid along the drag. The listener is on `window` rather than the canvas, because
a background canvas is `pointer-events: none` so that it never intercepts anything meant for the page — which also means
it never sees a pointer itself. Idle movement is ignored on purpose: reacting to every twitch would mean the background
is permanently disturbed by a reader who is only moving the cursor off the text.

Velocity is _added_ here rather than driven towards a target as the jet nozzle does — a drag is an impulse, and what
happens after the reader lets go should be the fluid's business. `strokeMaxSpeed` caps it, so a fast flick stays
emphatic rather than tearing a hole that takes seconds to settle.

Measured: a hard drag produces 4.9 mean shade change along the corridor it swept, against 1.8 for the same corridor left
alone, and 2.4 away from it — the surroundings move too, which is the pressure projection doing its job.

Pass `interactive: false` to turn it off.

### Plasma: a domain warp

`src/plasma-warp.ts`. Fractal Brownian motion folded into itself, in two stages: the first displaces the sampling
position, the second is evaluated at that displaced position, and the result is where a seamless plasma tile gets read
from. Folding it twice is what turns plain cloudy noise into something with filaments and swirls in it.

Time enters twice, and it needs to. `drift` slides the whole domain, which on its own would look like a photograph being
panned; `churn` moves the inner fields against each other, which is what makes it evolve in place.

The warp is evaluated on a coarse 36×28 grid and interpolated per pixel, so the noise runs ~1,000 times a frame instead
of once per pixel. That grid is rectangular because the domain it samples is: x is stretched by 4/3 so the field does
not look squashed on a wide window, and the grid has to be wider by the same factor or each cell covers a third more
domain in x than in y and the warp reads as smeared sideways. 36×28 puts the cells within 2.8% of square, where a 32×32
grid at the same cost would be 33% out. The two are a pair — change one and the other has to follow. The tile it samples has every frequency at an integer number of cycles across it, which is what makes
it wrap without a seam — and it has to wrap, because warped coordinates wander a long way outside `[0, 1]`.

Domain warping is a well-known technique. The layers under it are an integer hash, value noise on the hash, and fbm on
the noise; the hash mixes with MurmurHash3's public-domain finalising constants, credited in the source.

The plasma also carries a motion blur — each frame mixes towards the last — which smooths the underlying field between
frames so cells drift between palette levels rather than flicking between them. Note that the gamma is applied
_before_ the blur, so successive frames agree with each other.

---

## Using it

### Shading and themes

`shading` is either a fixed `{ base, amplitude }` or a function returning one. A function is re-read whenever the theme
might have changed:

```js
createSmokeBackground(canvas, {
  shading: () => {
    const dark = document.documentElement.classList.contains('dark');
    return dark ? { base: 18, amplitude: 26 } : { base: 255, amplitude: -22 };
  },
});
```

- **`base`** — the page colour being modulated, 0–255. Must match what is behind the canvas.
- **`amplitude`** — how far the effect moves that colour, in 0–255 steps. Negative moves it down, which is what a light
  theme wants.

By default the library watches both the `class` attribute on `<html>` (how most CSS frameworks flip dark mode) and the
OS `prefers-color-scheme`. Turn either off with `watchThemeClass: false` / `watchColorScheme: false`, and call
`handle.refresh()` yourself instead.

A theme change only re-shades — the field is untouched, because only the greys it maps onto have changed.

### The handle

```js
const handle = createSmokeBackground(canvas, options);

handle.start(); // resume the loop
handle.stop(); // pause it, keep the state
handle.refresh(); // re-read shading and repaint
handle.destroy(); // stop and remove every listener
handle.canvas; // the canvas it is mounted on
```

`create*` returns **`null`** if the browser will not give up a 2D context. That is the one failure worth handling — the
page should carry on without a background rather than throw:

```js
const handle = createSmokeBackground(canvas, options);
if (!handle) canvas.remove();
```

`destroy()` removes every listener it added, so mounting and unmounting in a single-page app does not leak.

### Options

Shared by both:

| Option                 | Default       | Does                                                                            |
| ---------------------- | ------------- | ------------------------------------------------------------------------------- |
| `pixelSize`            | `6`           | CSS pixels per rendered pixel — one dither cell. Bigger is coarser and cheaper. |
| `fieldScale`           | `2`           | How much coarser the field is than the output, per axis.                        |
| `maxPixels`            | `160000`      | Ceiling on rendered pixels; raises `pixelSize` on large windows.                |
| `levels`               | `5`           | Palette size. Small on purpose — the dither is what makes it look smooth.       |
| `gamma`                | see below     | Weights the field towards its dark end without changing the palette.            |
| `fps`                  | `24`          | Redraw rate.                                                                    |
| `shading`              | auto          | The greys. See above.                                                           |
| `respectReducedMotion` | `true`        | Draw one frame and stop under `prefers-reduced-motion: reduce`.                 |
| `pauseWhenHidden`      | `true`        | Stop the loop while the tab is hidden.                                          |
| `watchThemeClass`      | `true`        | Re-read `shading` when the `class` on `<html>` changes.                         |
| `watchColorScheme`     | `true`        | Re-read `shading` when the OS colour scheme changes.                            |
| `random`               | `Math.random` | Source of randomness. Pass a seeded generator for a repeatable background.      |

Smoke only:

| Option        | Default | Does                                                                    |
| ------------- | ------- | ----------------------------------------------------------------------- |
| `gamma`       | `1.6`   | See [Tuning](#tuning).                                                  |
| `maxSimCells` | `8000`  | Ceiling on simulation cells. **The one that matters** — see below.      |
| `settleSteps` | `90`    | Steps run before the first paint, so it opens as smoke rather than fog. |
| `interactive` | `true`  | Let a cursor drag stir the fluid.                                       |
| `simulation`  | `{}`    | Solver parameters, merged over `SMOKE_DEFAULTS`.                        |

Plasma only:

| Option     | Default | Does                                                                 |
| ---------- | ------- | -------------------------------------------------------------------- |
| `gamma`    | `1.18`  | See [Tuning](#tuning).                                               |
| `speed`    | `0.35`  | A multiplier on animation time. Slow: this is meant to go unnoticed. |
| `blend`    | `0.72`  | Motion blur — how far each frame mixes towards the previous one.     |
| `tileSize` | `128`   | Edge of the plasma tile, in samples. Wrapped on both axes.           |
| `warp`     | `{}`    | Warp parameters, merged over `PLASMA_WARP_DEFAULTS`.                 |

The full solver and warp parameter sets are documented inline on `SmokeParams` in `src/smoke.ts` and `WarpParams` in
`src/plasma-warp.ts`, with a note on each about what it does and where its default came from.

### Tuning

**Run the demo.** `npm run dev` gives you every dial as a live slider with text on top, which is the only sane way to
tune any of this.

**`amplitude` is the readability dial.** Body text sits directly on this background. The defaults are deliberately at
the low end so the effect modulates the page rather than becoming a picture. Raise it for a bolder look, then re-read a
long paragraph before committing.

**`gamma` weights the field dark without changing the palette.** Both ends of the range are fixed points, so it shifts
the balance between the greys rather than the greys themselves.

Both defaults were solved **offline across several seeds, not measured in the browser**. A single page load rolls one
noise field, and an fbm field can be locally dark or light, so one load measures that seed rather than the effect — the
browser numbers came out non-monotonic in gamma before this was noticed.

- Plasma: with no bias 19.9% of the background sits in the lower half of the palette; `1.18` raises that to 30.1%.
- Smoke: at `1.0` the darkest grey covered 11%; `1.6` takes it to 23% while leaving 9% at the brightest, so the
  highlights that make it read as smoke survive. Further, if wanted: `2.0` gives 30%, `2.5` gives 38%.

The smoke settles at a mean density of ~0.36, which is where the reference (`geisswerks.com/smoke`) sits. It needs no
darkening the way the plasma does — smoke is already mostly clear air.

**The palette and grid were matched against a reference.** The defaults land on greys 18/24/30/36/42 in dark mode and
235–255 in light, on a 6px cell with a 4×4 Bayer repeat of 24px. That came from measuring <https://codapress.co.uk/>,
whose background runs 12/22/32 over black in runs of five to six pixels. `pixelSize: 3` looked right but measured half
their size.

---

## Performance

Both draw at `fps` (24 by default) rather than the refresh rate, and stop entirely when the tab is hidden.

The plasma is ~114,000 output pixels at 1080p over a ~7,000-cell field. `maxPixels` raises `pixelSize` past its nominal
value on large windows, so 2560×1440 renders 147,000 pixels rather than 409,000. Measured at 61fps for the page's own
rAF loop at both sizes — i.e. the effect is not what limits the page.

For the smoke, **`maxSimCells` is the number to reach for first**, not `maxPixels`. The solver touches every cell a
dozen or more times a frame — six passes plus every Jacobi iteration — where the shading touches each output pixel once.
Left uncapped, a 1440p window would simulate five times the cells of a 1080p one and fall over on exactly the machines
least able to take it. After that, `iterations` (the Jacobi count) is the next biggest lever.

Both effects together are 5.4 kB minified and gzipped, with no dependencies. The package is `sideEffects: false`, so
importing only one of them tree-shakes the other away.

---

## Accessibility

- The canvas is decoration. Mark it `aria-hidden="true"`.
- With `prefers-reduced-motion: reduce` both draw a single frame and stop. The smoke settles itself with `settleSteps`
  first, so the still frame is smoke rather than undisturbed noise. Cursor stirring is disabled too.
- With JavaScript off nothing is painted at all and the page keeps its ordinary background — which is the other reason
  `base` has to match your page colour.
- `amplitude` is the contrast dial. Keep it low enough that text over the background still clears whatever contrast
  ratio you are targeting; the default range moves the page colour by about a tenth.

---

## Using the pieces on their own

Everything is exported, and the maths is deliberately DOM-free so it can be used and tested outside a browser.

Shade a field of your own with the same dither and palette:

```js
import { createSurface } from 'canvas-effects';

const surface = createSurface(canvas, ctx, {
  pixelSize: 6,
  fieldScale: 2,
  maxPixels: 160_000,
  maxFieldCells: Infinity,
  levels: 5,
});

surface.resize();
const field = new Float32Array(surface.fieldW * surface.fieldH); // fill with 0..1
surface.shade(field, { base: 18, amplitude: 26 }, 1);
```

Or drive the fluid solver headlessly:

```js
import { createFluid, stepFluid, randomizeSmoke, SMOKE_DEFAULTS, meanAbsDivergence } from 'canvas-effects';

const fluid = createFluid(64, 48);
const state = randomizeSmoke();

for (let i = 0; i < 100; i++) stepFluid(fluid, SMOKE_DEFAULTS, state, i / 24, 1 / 24);
console.log(meanAbsDivergence(fluid)); // near zero — the projection is working
```

`makeRandom(seed)` gives a small seeded xorshift generator, so passing it as `random` makes a background reproducible.

## Examples

- [`examples/vanilla.html`](examples/vanilla.html) — the smallest thing that works, no build step.
- [`examples/astro/`](examples/astro) — Astro components, including the `transition:persist` and `astro:page-load`
  handling a view-transitions site needs.
- [`demo/`](demo) — the live tuning page. `npm run dev`.

## Development

```bash
npm install
npm run dev      # the demo page, with every dial as a slider
npm test         # vitest
npm run check    # types, lint, format
npm run build    # dist/, via tsc
```

The tests cover the maths — the noise, the dither, the solver, the warp — because that is the part with properties worth
asserting: the projection really does remove the divergence, the Bayer matrix really does average to 0.5, the
MacCormack clamp really does keep density in range. The canvas and loop code is exercised by the demo page.

## Licence

MIT — see [LICENSE](LICENSE).

Both effects implement published techniques: Jos Stam's _Stable Fluids_ for the solver, domain-warped fbm for the
plasma, and ordered dithering on a Bayer matrix for the palette. Where a well-known constant is used it is credited at
the point of use — MurmurHash3's public-domain finalisers in `hash2`, and the classic 4×4 Bayer matrix.
