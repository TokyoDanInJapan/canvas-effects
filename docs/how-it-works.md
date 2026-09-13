# How it works

This document describes what each effect does, why, and where the numbers come from. The [README](../README.md) is
the short version.

Most numbers come from measurement. Where the obvious approach failed, this document records the failure. Read those
parts before you change the code. The source gives the same reasons in more detail, next to each parameter.

---

## Shared rendering: two resolutions and a dither

All eight effects render at two resolutions. This keeps them cheap enough to run all the time.

- The **field** is the expensive part. Each field cell is `pixelSize × fieldScale` CSS pixels. Soft fields, such as the
  smoke and the plasma, use half the output resolution. The rain uses the full resolution, for a reason given below.
- The **output** is `pixelSize` CSS pixels per pixel. The library interpolates it from the field and then dithers it.
  Each pixel costs a few multiply-adds and a table lookup.

The output then has five greys only. The dither makes this work.

**Why dither?** Five levels alone give five flat areas with visible steps. The dither moves each pixel by its 4×4 Bayer
threshold before rounding. A value halfway between two levels then rounds down in half the cell and up in the other
half. The area looks like the shade between them, and a gradient becomes texture, not bands.

**At one CSS pixel per cell, the dither turns off.** `dither: 'auto'` does this to give a different look. The Bayer
pattern works best at the pitch of the display. With the dither off, you get crisp flat areas with clean curved edges,
which is possible only at native resolution. `dither: true` keeps the smooth look at any size.

**To compare, set `dither: false`.** The palette stays the same, and only the distribution of levels changes. On the
demo, the fraction of neighbouring pixels that differ falls from 47.5% to 10.4% on the smoke, and from 53.1% to 4.7% on
the plasma. The dither does not change performance, because both paths quantise once per pixel.

The Bayer matrix is normalised to `(m + 0.5) / 16`, which averages to exactly 0.5. As a result, the offset averages to
zero. The dither changes the level of each pixel but not the average brightness. A unit test checks this.

Each pixel is `base + level × amplitude`. The effect changes the page colour over a narrow range and does not replace
it, so text on top stays readable.

## Smoke: a fluid solver

`src/smoke.ts`. Each frame has six steps:

1. **Forces**: buoyancy from the smoke's own density, and a light noise stir.
2. **Confinement**: add back the small swirls that the solver removes.
3. **Advect**: move the velocity field along itself.
4. **Project**: remove the divergence, so the fluid does not compress.
5. **Advect**: move the density along the corrected velocity.
6. **Replenish**: add a little smoke back in.

The grid wraps in both directions. Periodic boundaries are the easiest to solve, and they have no edges to notice.

### Why a solver and not curl noise

Curl noise has no divergence, makes good swirls and costs much less. It has no **momentum**, however. Its eddies come
from a noise field, so the smoke cannot create them, they cannot outlast their cause and they cannot interact. A real
solver sheds vortices from shear layers and turns heavy plumes over. Curl noise looks like smoke in a still image, but a
solver also moves like smoke.

### Step 4 is the most important

Advection alone lets the fluid compress. Density collects in places, and the result looks like a stretched texture. The
projection finds the pressure whose gradient cancels the divergence, and subtracts that gradient. This step makes the
effect a fluid and not a warp. `smoke.test.ts` checks that one projection removes about 90% of the divergence, and that
more iterations remove more.

### Four results from measurement

**Central differences for both the divergence and the gradient are wrong.** Together they give a Laplacian that spans
two cells. The pressure is solved against the compact five-point stencil, so odd and even cells separate, and most of
the divergence stays. Backward differences for the divergence and forward differences for the gradient give exactly
`p[l] + p[r] + p[u] + p[d] - 4p[c]`. That change reduced the remaining divergence from 35% to less than 10%.

**Plain semi-Lagrangian advection blurs too much.** It resamples every cell every step, so the field smooths itself
even where the flow only moves it. Smoke without sharp edges looks like fog. MacCormack advection keeps the edges. It
advects forwards, advects back, and subtracts half the difference. The clamp to the cells that the trace read is
necessary. Without the clamp, the correction overshoots at the edges and the field eventually blows up.

**Drag controls the look.** Drag sets the flow speed, and the flow speed sets how fast the smoke mixes to an even grey.
Drag must be low enough for a jet's momentum to cross the field. It must also be high enough that the background does
not become fog between jets. `replenish` rebuilds the structure that the flow mixes away, so change drag and
`replenish` together.

**Limit the simulation grid, not only the output.** The solver uses every cell a dozen times a frame, and the shading
uses each pixel once. `maxSimCells` matters much more than `maxPixels`.

### Jets

About every ten seconds, a nozzle opens on a random edge and fires across the field. About half the jets are dark. A
light jet paints a bright plume, and a dark jet cuts a clear channel. Both have the same momentum, so both disturb the
smoke equally.

A jet exists to add momentum. The nozzle moves the velocity *towards* the jet's speed and does not add to it. As a
result, the nozzle acts as an inflow boundary and keeps a fixed speed against the drag. If the jet added velocity, its
strength would depend on the frame rate and on how long it had run.

Two early attempts failed. A blob of density did not show, because the field was already dense, so most of the new
density was clamped away, and a blob adds no motion. Thinner background smoke gave the blob more room, but then the jets
had nothing to disturb.

### The pointer stirs it

A drag with a button pressed pushes the fluid along the drag. The listener is on `window`, because a background canvas
has `pointer-events: none` and gets no pointer events. Movement without a press does nothing, because a background that
reacts to every small movement is never calm.

Unlike the jet nozzle, a drag *adds* velocity. A drag is an impulse, and after release the fluid continues on its own.
`strokeMaxSpeed` limits the speed, so a fast flick has a strong effect but does not tear a hole.

In a measurement, a hard drag changed the shade along its path by 4.9 on average. The same path without a drag changed
by 1.8, and areas away from the path changed by 2.4. The areas around the drag also move, because the projection spreads
the effect.

`interactive: false` turns this off.

## Plasma: a domain warp

`src/plasma-warp.ts`. Fractal Brownian motion is folded into itself twice. The first stage moves the sampling position,
the second stage is evaluated at that position, and the result is a position in a seamless plasma tile. The double fold
turns cloudy noise into threads and swirls.

Time is used in two places. `drift` moves the whole domain, which alone looks like a moving photograph. `churn` moves
the inner fields against each other, so the pattern changes in place.

The library evaluates the warp on a coarse 36×28 grid and interpolates it for each pixel. As a result, the noise runs
about 1,000 times a frame, not once per pixel. The grid is rectangular because the domain is. The x axis is stretched by
4/3 so that the field is not squashed on a wide window, so the grid must be wider by the same factor. With 36×28, the
cells are within 2.8% of square. A 32×32 grid has the same cost but is 33% out of square. If you change one, change the
other. Every frequency in the tile has a whole number of cycles, so the tile wraps without a seam. The tile must wrap,
because warped coordinates go far outside `[0, 1]`.

Domain warping is a well-known technique. It uses an integer hash, value noise and fbm. The hash uses the public-domain
finalising constants of MurmurHash3, and the source credits them.

**Click to send a ripple.** A click sends a ring of radial displacement out from the point. Two details are important:

- The ripple is fixed in **screen** space. The domain drifts, so a ripple fixed in domain coordinates would move across
  the page.
- The ripple's age uses **real time**, not animation time. Animation time scales with `speed`, so at quarter speed a
  ripple would last four times as long.

The ring is a Gaussian band around a growing radius, so the ring travels outwards and the disc inside it stays still.
Distances are corrected for aspect ratio, so the ring stays circular. In a measurement, the pixels that changed in
250 ms went from 508 at rest to 2,147 after a click, and back to 471 when the ripple ended.

As for the smoke, the listener is on `window`. `maxRipples` limits how many ripples run at the same time. A click over
the limit is ignored, so a burst of clicks does not build a queue.

The plasma also has a motion blur. Each frame mixes towards the previous frame, so cells move gradually between palette
levels and do not flicker. The gamma applies *before* the blur, so that the frames agree.

## Rain: falling lanes

`src/rain.ts`. There is one lane per field column. Each frame, the library multiplies the whole field by a decay
factor. Then every head moves down its lane and writes brightness into the cells it passed. That is the whole
simulation.

**Nothing draws the trail.** The obvious approach draws a gradient of length `L` behind each head. That approach needs
`L` as a parameter, and it fails when a head moves more than one cell a frame. Decay costs one multiply per cell and
works at any speed. It also gives two correct results. A fast head leaves a longer streak, because its brightness has
less time to fade over the same distance. A head that stops leaves its trail to fade where it is.

As a result, trail length is a ratio. A streak reaches `speed × ln(1 / brightness) / fade` cells. At the defaults on a
90-cell field, the trail is half as bright 15 cells back, a fifth as bright at 34 cells, and invisible at about 64
cells. If you change `speed`, change `fade` too.

The decay is exponential, so it does not depend on the frame rate. Two half-steps give the same brightness as one full
step. A test checks this to three decimal places.

### `fieldScale` is 1

The smoke, plasma and metaballs render the field at half resolution, and interpolation smooths it. For a continuous
field, this is free smoothing. For separate lanes, it is **blur**. Neighbouring lanes mix, and sharp streaks become
smudges. At `fieldScale: 1` each output pixel is one field cell, and the streaks stay sharp. `maxFieldCells` matches
`maxPixels` for the same reason, because a smaller field would add interpolation back. A larger `fieldScale` does the
most damage to this effect.

### Click to distort

A click sends a growing ring that *moves the existing picture* and adds no light, like a lens. When no ring is active,
`distortField` returns the field unchanged, so an idle page costs nothing. The library recomputes only the cells that a
ring can reach.

Sampling wraps horizontally and clamps vertically. Horizontal wrapping matches the lanes, so a ring near an edge pulls
streaks from the other side. Rain has a top and a bottom, so vertical wrapping would pull the bottom into the top. The
smoke has no top or bottom, so it wraps in both directions.

The rain's ripple is less visible than the plasma's. The plasma is a dense field, so a displacement always moves
something. The rain covers about 13% of the screen, so a ring often passes through empty space. In a measurement, a
ring almost doubled the changing pixels, from 1,169 at rest to 2,191. For a stronger effect, increase
`distortStrength`.

### Why there are no characters

The rain is the falling light from the Matrix, without the characters. At a 6 px cell, a character is about three cells
tall and looks like noise. Streaks survive the small palette, but letters do not. Characters would also need a separate
renderer that does not use the dither.

## Ridges: flying over a landscape

`src/ridges.ts`. The effect draws rows of a 2D terrain as a stack of 1D curves. Near rows hide far rows.

**The hidden lines make the effect.** Without them, the effect is a tangle of lines. A floating horizon hides them. The
library draws from nearest to farthest, keeps the highest covered point in each column and skips anything at or below
it. This takes one pass, with no z-buffer and no sorting.

**Rows move off the bottom of the screen before they are deleted.** `overscan` keeps rows past the near edge, because a
crest must continue to hide the rows behind it after its baseline leaves the screen. Without `overscan`, the nearest row
disappeared each time `travel` passed a whole number.

`rowAmplitude` stops a row growing once it passes the near edge. In strict perspective, the row would continue to grow
and become several screens tall. It would also grow faster than its baseline moves, so it would never leave the screen.
With a fixed size, it moves out of the frame. The library skips rows that are fully below the edge, so `overscan` is a
limit and adds no work.

**Fills and trails** are both off by default. `fill` makes the lines into solid shapes. The floating horizon already
knows the highest covered point, so the fill goes from the row's curve down to that point at no extra cost. With
`fill`, the lit part of the screen increases from 24% to 85%. `fillLevel` keeps the fill darker than the line, so the
crest stays visible. Without `fillRandom`, keep `fillLevel` below 1, or the shapes look flat. At the default of 0.34,
an eight-level ramp still shows eight colours, with a mean channel value of 58 against 106. This keeps the effect
usable behind text.

`fillRandom` gives each row its own fill value, so each shape has a different palette colour. Use it with a ramp. The
value comes from a hash of the row's `worldZ`, so a row keeps its colour for its whole life. A new random value each
frame would make the stack flash. The fill ignores depth, because a fade with distance would make the colours too
similar.

`trail` keeps part of the previous frame, so a falling crest leaves a smear. The library fades the previous frame and
takes the maximum with the new one. A blend would make the lines dimmer. Full brightness must stay exactly 1, or
one-cell lines do not survive the dither. The trail gives the field a state, which the rest of the effect does not
have. The trail needs no special handling for hidden lines, because it is above the line, where the horizon does not
clip.

**Rows follow `travel`, not screen position.** Each profile belongs to a whole number of `travel`, keeps its shape for
its whole life, and moves down as you fly past. If profiles belong to screen positions, the terrain changes in place,
which looks like morphing and not like flight.

The terrain is *ridged* noise. `1 - |2n - 1|` folds fbm about its middle and turns hills into sharp crests. Plain fbm
gives rounded dunes. A Gaussian window (`focus`) puts most of the activity in a central band and keeps the edges flat.

### Why lines survive the dither

A small palette usually breaks one-cell lines into dashes. Here, **0 and 1 are fixed points of the ordered dither**. A
cell at full brightness rounds to the top level at every Bayer position, so a line drawn at 1 stays whole.

Values *between* levels break up, and the effect uses this. `depthFade` draws distant rows dimmer, so they fall between
levels and dither into haze. This gives atmospheric perspective at no cost.

This has two results. `fieldScale` is 1, as for the rain, because interpolation blurs lines. `pixelSize` defaults to 4,
not 6, because a line is one cell wide, and at 6 the lines are too thick for the gaps between rows. A `pixelSize` of 4
stays inside the pixel limit at 1080p (480 × 270 = 129,600, against a limit of 160,000).

### Click a line to wobble the stack

A click starts a disturbance from the profile under the pointer. The disturbance is a **wave packet**, which is an
envelope multiplied by an oscillation, so the line ripples through a few crests. A single Gaussian looks like a shock
wave instead.

Two decisions make it work:

- **The wobble belongs to the row, not the screen point.** It stores the `worldZ` of the profile, so it moves with the
  terrain. A wobble fixed to the screen would stay still while the rows moved through it.
- **Distance counts one row as `wobbleRowSpacing`.** This setting controls whether a wobble stays on one line or crosses
  the stack.

To find the profile under the pointer, the library uses `depthAtY`, the inverse of the perspective curve. The offset
applies before drawing, so the fill and the hidden lines follow the wobbling line.

In a measurement with the flight stopped, the pixels that changed in 200 ms went from 2,774 at rest to 10,901 during a
wobble, and back to 2,430.

## Metaballs: an implicit surface

`src/metaballs.ts`. Each ball adds a falloff to a shared field, and a threshold turns the field into a surface.

**No code draws the joins.** Two balls that are each below `iso` can be above it together. A bridge forms before their
outlines touch. It gets thicker, and then thinner as the balls move apart. The sum of two overlapping falloffs makes
this shape. A test checks that at the midpoint each ball alone is below the threshold, and the pair is above it.

**The falloff is Wyvill's, not Blinn's exponential.** `exp(-b·r²)` never reaches zero, so every ball affects every
cell, and the cost is cells × balls. `(1 - r²/R²)³` is smooth to the second derivative, needs no exponential and is
exactly zero past R. As a result, each ball writes only to its own bounding box, and the work is the sum of the ball
areas. A test compares this with a simple per-cell sum to six decimal places.

**The effect has no state**, like the plasma. Positions are functions of the clock. They are Lissajous figures with
unrelated frequencies, so the pattern does not visibly repeat. Any frame can be drawn without the frames before it, so
reduced motion needs one draw only. A test checks that forty small steps equal one large step.

**Positions use height units.** `x` goes from `0` to `aspect`, and `y` from `0` to `1`. As a result, distance is the
same in both directions, and a ball is round on any window. A test measures one blob in both directions and requires
the same size.

**Press and drag to carry a blob.** A held ball is one more term in the sum, so it joins and stretches like the others.
It needs no emissions, because the ball is at the last pointer position, so its motion is smooth. Compared with the
smoke, the variability was 0.16 against 0.11, with no stalled samples.

**Release to throw it.** On release, the ball keeps the velocity of the drag, so it coasts and then curves back to its
path. Without this, a fast flick and a slow placement look the same. Three details make it work:

- The damping is exponential, so 24 fps and 60 fps give the same result.
- The release speed has a limit, so a flick cannot throw the ball off the edge.
- The position stays inside the field, so a throw at an edge slides along it.

**Release is a blend.** The ball's free position continued to move while you held the ball, so a direct handover makes
it jump. `BallOverride.weight` goes from 1 to 0, so the ball moves smoothly towards a target that is also moving. A test
reduces the weight step by step and requires the gap to shrink steadily to zero.

`grabReach` limits how near a press must be, so a press does not pull a blob from across the screen. `grabEase` and
`releaseEase` use real seconds, not `speed`, so a slow drift does not slow down a grab.

`shoulder` controls the look. A narrow shoulder gives classic hard-edged metaballs, which in five greys are flat
shapes. A wide shoulder (the default) gives edges that cross several palette levels and dither into a gradient.

---

## Tunnel: one division

`src/tunnel.ts`. For each cell, the effect converts the position to polar coordinates about a vanishing point. Then it
reads a wall texture at `(angle, depth / radius)`. That division is the whole perspective, because a point on the wall
of a cylinder projects to a screen radius in inverse proportion to its distance. There is no camera, matrix or depth
buffer.

An increase in that coordinate moves the viewer forwards. Features do not move outwards at a constant rate. They
**stretch**, and the farther out a feature is, the faster it moves. Over 1.4 s, a feature at radius 0.15 moved 0.007,
and a feature at 0.5 moved 0.091, twelve times as far. This gives the feeling of speed. It also means that no single
shift matches the motion. The first test of forward motion measured zero displacement while the effect worked, so the
test was rewritten against the projection.

### The corridor bends

A straight cylinder with a moving vanishing point looks like camera shake, because everything moves together. A
corridor with a bending *axis* looks like flight, because the near wall sweeps past while the far end stays still.
`bend` controls this, and the result is exact.

Put the wall at radius 1 about an axis `(X(z), Y(z))` and project it through a pinhole. A point on the wall lands at
`R·(X(z) + cos t, Y(z) + sin t)`, where `R = f / z`. In reverse, the screen offset to remove is `R·X(z)`, where `R` is
the **corrected** radius. The exact answer is a fixed point, and one pass is enough. Solve for a straight tunnel, look
up the axis at that depth, subtract, and solve again. This costs one more square root and no more `atan2`.

The offset is `R·X`, not `X`. A sideways offset looks smaller the farther away it is, so the correction is zero at the
centre and largest at the edges. This makes the near wall sweep. It also makes the obvious test fail. In the depth
coordinate, the correction looks largest at the centre, so the test must measure the displacement.

Two results came from building it:

- **The axis lookup stops at the edge of the vignette.** Towards the centre, `v` grows without limit. An axis sampled
  there swings through whole cycles between neighbouring cells, and the centre fills with noise. The vignette hides the
  centre, so no visible detail is lost.
- **The axis comes from a table.** Two sines per cell took 3.8 ms a frame on a 160,000-cell field. The axis depends on
  depth only, and one frame uses a limited range of depths. A few hundred samples and a lerp replace the sines, and the
  bend costs a third less. A test compares the table with the exact function.

The bank follows the position of the axis, not its speed. A vehicle follows the derivative, but the derivative is a
quarter-cycle out of phase, so the picture seems to turn against its own bend.

### The wall is built from sinusoids

The wall must wrap round the circumference without a seam, or a seam runs along the tunnel. fbm wraps only when the
angle range ends on a lattice boundary, which fails when parameters change. A tile of sinusoids with whole-number
frequencies always wraps.

For this reason, `repeats` is a whole number. A rotation by a whole number of repeats is therefore invisible, because
it maps the tile onto itself. This can look like a bug. A test for `twist` once used 1.5 turns at two repeats, which is
three whole tiles, and failed while the twist worked.

### The vignette hides undersampling

`depth / radius` is not uniform, so evenly spaced cells do not sample it evenly. Between neighbouring cells, the
coordinate changes by about `depth × cell / radius²`, which grows without limit towards the centre. At any resolution,
there is an inner disc where neighbouring cells are more than half a ring apart, and the rings become noise. This has
two results:

- **`fieldScale` is 1.** The first version used 2 and showed flat mottle with no rings. Against a 4× supersampled
  reference, the error at 1 is half the error at 2 (0.020 against 0.037).
- **The vignette covers the whole disc**, not only the centre point. The disc reaches r = 0.30 on a 133-row field, so
  `vignette: 0.3` covers it. A much smaller vignette shows moiré.

`depth` affects this directly. It sets how many rings are on the screen, and it moves the undersampled disc outwards
by its square root. At the original 0.34, the visible ring area held 1.4 rings and looked like mottle. At 1, it holds
seven.

Each cell costs an `atan2`, a square root and a division, plus the bend's square root and lookup. On a full
160,000-cell field, that is 3.9 ms straight and 6.2 ms bent, or 9% and 15% of one core at 24 fps. A field reaches that
size only above about 3200×1800.

### Drag to steer it

A press pulls the vanishing point towards the pointer. On release, it moves back to its own drift. The blend is the
only state in the effect, which is otherwise a function of the clock. The blend uses real seconds, so a slow flight
does not slow down the steering.

The dark centroid of the field does **not** measure the steering. The dark bands of the wall are much stronger than the
vignette, so the centroid stays within 0.002 of the centre. Instead, compare the mean brightness in a small disc at the
pointer with the same disc at the centre.

## Mandelbrot: the picture is its own derivative

`src/mandelbrot.ts`. The problem is to draw the Mandelbrot set in five greys at 120 cells across. The usual method does
not work at that size.

### Escape time fails

If you colour by iteration count, the bands crowd together at the boundary, where the detail is. A small palette makes
this worse. The bands land on different levels each frame, and the boundary flickers.

### The distance estimate costs almost nothing

The usual formula for the smooth escape count is:

```
mu = n + 1 - log2(log|z|)
```

This is not an approximate iteration count. The exterior potential of the set is `G = log|z_n| / 2^n`, so
`mu = 1 - log2 G` exactly. `mu` is the potential on a log scale. The distance to the set is `d = G / |grad G|`, which in
terms of `mu` is:

```
d = 1 / (ln2 * |grad mu|)
```

`grad mu` is a finite difference over the field that the effect already computed. The distance estimate costs one more
pass and nothing per iteration.

A test checks the arithmetic. It renders the same view at two grid densities, and the distance in cells must double.
The median ratio over the field is 2.004.

### It antialiases itself

The grid does not sample a thread thinner than a cell. The finite difference reads the gradient too low and gives a
distance of about one cell, not zero. As a result, the thread shows as a soft grey line and does not disappear between
samples. Detail smaller than a cell fades out and does not flicker, which suits a small palette. An exact distance
estimate would give the true distance and draw the thread black. The thread would then flash as the zoom moved it
across the grid.

### Brightness depends on distance in cells

A cell gets smaller as the zoom goes deeper, so shading by distance in cells gives the same amount of detail at every
depth. In a measurement, the field used 0.994 to 0.998 of the full range at the start, at eight doublings and at
sixteen.

The set is dark and the boundary glows. A bright picture on a dark set would be too strong for a background. The
interior uses the same distance estimate as the rest of the picture, which is important below.

`glow` is 4 cells. The output is interpolated before dithering, so a one-cell edge mostly disappears on the screen. At
1.2 the set was a flat shape. Above about 6, the threads merge into a wash.

The exterior contours fade according to what the grid can resolve. They need a distance of at least
`2 / (bandWidth × ln2)` cells. Below that, they alias, and the glow covers them.

### The autopilot aims at threads

A target chosen at the start is empty space 20 doublings later. For this reason, the autopilot chooses a new target
from the current frame every `aimInterval` seconds. It scores each candidate by the **area around it**, not by the cell.
The area with the most variation wins, but the autopilot first rejects three kinds of area:

| Rejected                    | What it is                        | Result without the rule                   |
| --------------------------- | --------------------------------- | ----------------------------------------- |
| more than 30% interior      | the edge of a lake                | 77–93% interior for ten seconds at a time |
| mean brightness above 0.65  | threads finer than the grid       | a flat grey wash in 36% of frames         |
| less than 10% interior      | open exterior, with no set        | nothing to see in 85% of frames           |

All three rules are necessary. Without any one of them, the autopilot fails in a different way:

- A lake edge is a smooth curve. When magnified, it becomes a straight line.
- In an area that is bright almost everywhere, every thread is thinner than a cell. The few dark cells, where a thread
  lands on a sample, give a *high* score. The autopilot aims at them and finds more of the same. More depth did not
  fix this.
- With only the first two rules, the safest area is always the one farthest from the set.

With all three rules, 2% of frames fail. One empty scan does not stop the descent. Three in a row do. When the first
empty scan stopped the descent, a small canvas went down for only four seconds at a time.

### Where it turns round

A double holds about 16 significant digits, so the plane runs out at about 1e-16. `minSpan` is 1e-11, about 38
doublings below the start. Precision alone sets this limit.

`minSpan` was 1.5e-7, because depth was thought to cost iterations. **That was wrong.** The number of iterations that a
frame needs depends on how much boundary is on the screen, not on the magnification. The cost was the same from 24
doublings to 48. The real limit is how many doubles fit across one field cell, because the distance estimate is a
finite difference and needs room inside the cell:

| Doublings | Span    | Doubles per cell |
| --------- | ------- | ---------------- |
| 24        | 1.5e-7  | 9,300,000        |
| 38        | 1e-11   | 568              |
| 44        | 1.5e-13 | 9                |
| 48        | 9.2e-15 | 1                |

At 44 doublings, the picture is a soft blob with no detail. 38 leaves enough room.

Two metrics did not show the problem. The fraction of identical neighbouring cells was 15% at 42 doublings, because
exact equality appears long after the detail has gone. The standard deviation of the field was 0.337 at 44 doublings,
because a dark area next to a light area has contrast but no detail. The number came from looking at rendered frames.
The only cost is time. A descent takes about 110 s, not 72 s.

The way back out is a function of the span:

```
centre(span) = deep + (home - deep) * (span - minSpan) / (homeSpan - minSpan)
```

The centre is exactly `deep` at the turn and exactly `home` at the top. Between them, the departure point stays at the
same place on the screen, so the view zooms about that point and does not pan. An ease towards home would look like a
very large sideways slide while the view was still deep.

### A zoom must be smooth

The other effects move in many directions at once, so the eye does not follow any one motion. A zoom is one motion of
the whole frame, so every jump shows. The first version juddered, and it needed four fixes. The measure is the change
in apparent motion from frame to frame, against the cruise speed, over a full cycle at 24 fps on a 60 Hz display:

|                  | Mean     | Worst frame |
| ---------------- | -------- | ----------- |
| First version    | 48%      | 386%        |
| All four fixes   | **1.7%** | **45%**     |

**1. The timestep was fixed.** This caused most of the 48%. The smoke needs a fixed step, because its advection is
stable only for a limited step. The zoom does not, because the span and the eases are exact for any step. A fixed step
is wrong when the frame rate does not divide the refresh rate. At 24 fps on 60 Hz, frames show for 33 ms and 50 ms in
turn, but the animation moves 41.7 ms each frame. The same effect measured 1.0% on a 144 Hz display, which confirmed
the cause.

**2. The rate changed in one frame.** At the bottom, the rate changed from half a doubling a second inwards to two
outwards. The rate now eases, and both turns start *early* by the coasting distance, so the descent still stops at
`minSpan` without overshoot. The rate is also **damped**, not lagged. A first-order ease gives full deceleration in the
first frame of a phase, which is a sudden stop. With damping, the deceleration builds up and then decreases. The worst
jerk over four cycles fell from 102 to 17 doublings per second cubed.

**3. The aim jumped.** The autopilot chooses a new cell every `aimInterval`. A single lag towards a target that jumps
has a corner at each new aim. Those frames moved the picture up to 2.4 times as far as the frames next to them. A
second lag (`aimSmooth`) makes the first derivative of the position smooth, so a new aim gives a curve.

**4. A bug.** The way out measured its progress from `minSpan`, but the descent stops a little above `minSpan`. The
difference is very small in complex units, but it was divided by a span near 1e-7. The view jumped by an eighth of a
screen in one frame. The way out now measures from the span where the descent stopped, so both ends are exact.

### No sudden change between interior and boundary

Cells flickered between black and bright. The cause looked correct. Interior cells were drawn at zero, and their
neighbours on the boundary were drawn at one. A cell on the line changed class each time the view moved by less than
one cell, which happened all the time. At fixed points in the plane, 8.5% of consecutive frames showed a flicker.

The fix removed code. An interior cell already has the iteration limit as its escape count, so the difference from its
neighbours has a meaning. Deep in the interior the difference is flat, so the distance is very large and the cell is
black. Next to the boundary the difference is steep, so the cell is bright, like its exterior neighbour. The change
between classes is now gradual, so a change of class does not matter.

A small problem remained. A central difference cannot see a feature one cell wide, so a one-cell thread had a dark
speck in its glow. The classification knows that a cell with a neighbour on the other side of the line is *on* the
boundary, so its distance is limited to half a cell. The worst difference across the line fell from 0.626 to 0.104.

|                                         | Flicker  |
| --------------------------------------- | -------- |
| First version                           | 9.7%     |
| Same estimate everywhere, and the limit | **2.7%** |

These are averages over eight seeds and two depths. An earlier version of this table gave 0.11%, from one quiet
recorded path. A number that depends on the path needs an average. Two other causes were checked and rejected. The
iteration limit changing gave 2.55% on those frames against 2.38% on others. The contours gave 2.43% with bands against
2.37% without. The rest comes from the finite iteration limit. At 2,000 iterations there is no flicker, but each frame
costs six times as much.

### The camera has mass, and the goal walks

**The camera has momentum.** It is a critically damped spring with velocity as state. It works in screen units, because
the offset is divided by the span on the way in and on the way out. As a result, the spring behaves the same at every
magnification. Critical damping is the fastest approach with no overshoot, and an overshoot looks like a wobble. The
way out used to set its position directly, which removed the sideways velocity of the descent in one frame. Every one
of the worst frames came from this.

**The goal moves smoothly.** Two influences move it every frame. It eases *towards* the autopilot's choice, which keeps
the picture good. It also moves along the boundary. The field's gradient points at the set, so the perpendicular
follows the boundary at a fixed brightness. Both motions are continuous, so neither jumps. Two approaches failed:

- **Following the contour alone drifts into the glow.** It keeps its distance from the set and ends in soft exterior,
  with the set off the screen. The standard deviation of the field was 0.237 with the contour alone, 0.334 with the
  autopilot alone and 0.354 with both.
- **The test to keep a goal must be looser than the test to choose one.** When the same test was used, the goal was
  rejected about once a second. The walk stays a little away from the boundary, so its area always fails the choice
  test. Once chosen, a goal must only stay on the screen and near the boundary.

### The zoom must centre on the target

A zoom about the centre of the screen multiplies every screen offset by the zoom factor. An off-centre target moves out
at `2^speed` a second (1.41 at the default), and the spring closes at about 1.11. The zoom was faster, so the view never
reached the target. The median distance from view to target was 0.21 screen heights, and the 95th percentile was 0.46.
With the aim held still during the zoom, the picture zooms about a fixed point and does not zoom and move at the same
time. Flicker also fell, because less of the picture moves across cells.

The autopilot moved the target off centre in two more ways. `aimBias` makes each run go somewhere different. It never
stopped, so the zoom always worked against it. It now sets the direction at the start and fades over about six seconds.
The autopilot also had no hysteresis, so it moved between candidates with almost equal scores. Half the preference now
goes to the last aim. This removes ties and still allows a better cell.

|        | View to aim | View to target |
| ------ | ----------- | -------------- |
| Before | 0.082       | 0.206          |
| After  | **0.047**   | **0.136**      |

The values are median screen heights over four descents.

### It stops to look around, and sometimes backs out

The descent has pauses. Every `exploreEvery` seconds, it either **cruises** or **retreats**. A cruise stops the zoom
and moves sideways at one magnification. A retreat backs out a few doublings for a wider view. About two thirds of a
cycle is descent, an eighth is cruising, a twentieth is retreat and the rest is the way out. The choices come from
`hash2` over a counter in the state, so a seeded background repeats exactly.

The same two moves also recover from a bad frame. The move depends on the problem:

- A **washed-out** frame has threads finer than the grid. The only fix is to back out. Moving outwards helped but was
  not enough, because the longest wash fell only from 22.7 s to 13.3 s. A retreat reduced it to 4.7 s. With the eased
  goal there are no washed-out frames.
- A **dim** frame has nothing near enough to glow, so backing out makes it emptier. The zoom stops, and the walk moves
  the view towards something.

The first version backed out of *lakes*, which was worse than both. After it gave up two and a half doublings, it went
back down to the same place. In four of eight seeded runs, it spent 62% of the time in retreat.

### A wrong measurement

For a time, the autopilot steered on the interior fraction, because a frame full of the set seemed to be a black
rectangle. That was wrong. The set is dark and its boundary glows, so an 85% interior frame is 85% dark shape. That
shape often has a bright spike of exterior in it, which is one of the best pictures that the effect draws. The
autopilot spent a third of each cycle leaving frames that were good.

The replacement is `frameTone`, which gives three numbers from one pass:

- **Lit fraction** shows whether there is anything to see. It never fell below 0.107 over 1,276 frames.
- **Mean brightness** finds washed-out frames, which the lit fraction cannot.
- **Interior share** matters only at zero, when the set is off the screen.

### Cost is the real limit

Cost is cells multiplied by iterations, so both need a limit. A 1280×800 window gives a 126×79 field, which is 9,954
cells against the limit of 10,000. The iteration limit grows from 90 at the start to 300. A frame takes 0.48 ms at the
start, 4.5 ms at the bottom and 3.2 ms (median) over a descent. Nearly all of this time is interior cells, which use
the full iteration limit.

Two approaches did **not** work:

- **Cycle detection.** An interior orbit falls into a cycle, so detecting the cycle should stop early. In a
  measurement, it made deep frames 55% slower and changed no cells. At depth, the expensive cells are exterior points
  that need more than the iteration limit, not periodic points.
- **More iterations at depth.** The fraction of false interior cells (cells that the limit calls interior, but that
  escape at 20,000 iterations) is 5% to 20%. It depends on how much boundary is on the screen, not on the magnification.
  It makes the threads a little too thick, which is acceptable. `iterationsPerDoubling` controls it, at linear cost.

The two limits work against each other. Half the cells allows twice the iterations, which gives a thinner boundary in a
coarser picture. At 10,000 cells, both are about right.

---

## Beer: two rates, not a thickness

`src/beer.ts`. The effect is a glass filled to `fill`, or filling itself to `fill`. Bubbles rise through it, and a head
of foam sits on top. From top to bottom, the layers are air, foam, the surface and beer.

**The bubbles are true metaballs.** The effect imports `falloff` from `metaballs.ts` and does not copy it, because the
claim is true only with the same kernel. Each bubble adds Wyvill's cubic to a shared field, and a threshold gives the
surface. The physics joins two bubbles only when their centres are closer than `merge` times the sum of their radii. The field
joins them much earlier, so the join is already on the screen and the change from two bubbles to one is invisible. A
test checks a pair that is slightly too far apart to merge but already lit between them.

**No code draws the head.** A bubble bursts when its top edge reaches the surface, and adds its area to the foam. The
foam drains exponentially and spreads sideways. The head is as thick as those two rates allow. With a lower `rate`, the
head gets thinner. With a lower `drain`, it grows until `headMax` stops it. No parameter sets the thickness, so the
settings behave like a real glass.

**A burst adds an area, not a thickness.** The first version put the foam into the one column under the centre of the
bubble. The thickness was then the area divided by the column width. On a fine field this is very large, `headMax`
removed most of it, and the head was thin. At 384 columns, the head was less than half as thick as at 96 columns. The
fix spreads the foam over the columns that the bubble covers and divides by their total width. The foam is then the
same at any resolution. A test bursts one bubble on a 64-column field and on a 512-column field, and requires the same
volume.

**The spreading must not run at its stability limit.** Explicit diffusion is stable up to a coefficient of 0.5. At
exactly 0.5, each column becomes the mean of its neighbours. Odd and even columns separate, and a spike leaves a comb
pattern that does not fill in. The step is limited to 0.25 and runs several times, so `spread` stays a physical rate at
any window size.

**The surface is shallow water.** Each column has a height, and each face between columns has a depth-averaged flow.
The walls reflect. The first version was a plucked string, with one wave speed everywhere and no amount of beer.
Shallow water gives three behaviours at no cost:

- Wave speed is `sqrt(g × depth)`, so waves in a quarter-full glass move at half the speed of waves in a full glass. A
  test times a pulse in both.
- The flow carries itself (the momentum term, read upwind), so a hard-driven front gets steeper.
- Volume is conserved, because all beer that leaves a column through a face goes into the next column.

`waveSpeed` keeps its meaning. Gravity is `waveSpeed² / fill`, so a full glass sloshes with a period of
`2 × aspect / waveSpeed`. A test checks this. It starts the fundamental wave, waits half a period, and requires the high
wall to be below level.

The numerical details all have tests:

- **The grid is staggered**, with heights on columns and flow on faces. This prevents the sawtooth that a collocated
  grid allows.
- **The substeps follow a CFL limit** based on the wave speed *and* the flow. With the wave speed alone, a hard flick
  moves faster than the step, and the surface becomes NaN.
- **The number of substeps has a limit**, so each frame has a limited speed budget. The flow gets it first. The flow is
  limited to a few times the wave speed and never more than half the budget, because a pointer can make the flow as
  large as it likes. Gravity is then reduced to fit the rest, which is always at least half.
- **That order fixed a real failure.** When only gravity was reduced, a hard swirl gave the solver more flow than the
  substeps could hold. The advection broke the surface into a sawtooth one cell wide. The slopes of the sawtooth then
  pushed the flow back up when gravity returned, and the surface never settled. A regression test swirls at the worst
  setting and requires the surface to settle.
- **A backstop restarts the surface** if the arithmetic fails anyway, so the renderer never gets a NaN.
- **Drag is plain friction**, but shear reduces a wave by the square of its wavenumber. As a result, the small waves
  from bursts fade quickly and the slosh continues. A test checks the ratio.
- **The waves have no height limit** except the glass. A crest can reach the top of the frame, and a trough can fall to
  a thin film on the bottom. A `waveMax` limit was removed, because it stopped a hard swirl in a way that a real glass
  does not.

**A crest that is too steep breaks.** The surface has one height per column, so it can lean up to vertical but no
further. Beer driven against a wall climbs, curls and breaks, and a height field cannot show that. When a face is
steeper than beer can stand, the effect lowers it, and the crest gives beer to the trough. This is what breaking is.
The beer that goes over the top becomes foam and a few droplets. For this reason, a hard stir makes the head thicker.

**Bursts push the flow, and this is the only motion at rest.** A burst pushes the *flow*, not the heights. When bursts
pushed the heights, two dozen bursts a second showed at once, and the surface shook. A push on the flow must travel
before it shows, and the surface adds the pushes together as a liquid does. The push has its mean removed, so it moves
beer but adds none. There is no other background motion. Without fizz, the glass is completely still, which is
correct.

**A drag does three things.**

- Bubbles near the pointer ease *towards* its speed, and never go faster than it.
- The drag creates new bubbles, as a real disturbance does.
- The sideways movement pushes the body of the beer.

The old code drew the shape of a bow wave into the surface, which copied the result and not the cause. Now the drag
pushes the flow, and the bow wave forms by itself. Flow gathers ahead of the pushed area and spreads behind it, and the
beer piles up against the wall ahead and swings back. The push gets weaker with depth. A press is a jab, with a splash,
spray and a few bubbles.

**Only the newest sample pushes.** Every active stir samples the same pointer. If each stir pushed, a fast drag would
push twice, once through its speed and once through the extra samples that the speed made. A test checks that ten
stirs push exactly as hard as one.

**The fizz rises in fixed columns.** Bubbles start at fixed nucleation sites. Each site has its own position, rate and
bubble size, and the rest of the rate starts anywhere. The site shares add up to one, so `rate` stays the total fizz.
Each site is placed at random inside its own section of the width. With fully random positions, a third of the glass
often had no site, and the head, which the streams feed, was thin above the gap. For the same reason, the site weights
stay within a factor of three. The initial bubbles use the same sites, so the streams show from the first frame.

**The head moves as one raft.** A real head has weight and holds together, so it rides the waves and ignores the
bubbles bursting under it. When the head followed the surface directly, it shook at the rate of the fizz. The foam now
follows its own line. That line is the surface, smoothed sideways over a width that hides the dent from one burst. The
line follows the surface at a speed that depends on the distance between them. One fixed speed cannot do both jobs,
because a speed slow enough to ignore the fizz also removes half the slosh. With a distance-based speed, the raft
ignores small differences and follows large ones.

**Spray is beer in the air, with the same gravity.** A hard break, a large burst and a press all throw droplets. The
droplets fly ballistically, mostly stick to the walls, and push the surface where they land. They must use the same
gravity as the waves. Spray that stays in the air longer than the slosh looks like a different liquid. The effect draws
droplets separately, not in the metaball field. They are as bright as a lit bubble and appear in front of everything.

**The glass can fill itself.** `level` is live state, and everything reads the surface through it. A glass that starts
below `fill` rises to it at `pourRate`, with two and a half times the fizz on the way. With `pour: true`, the effect
starts with an empty glass and does not settle it first. A visitor who asks for reduced motion always gets a full,
settled glass, because a single still frame of an empty glass shows nothing.

**Bubbles rise with the square of their radius**, from Stokes drag. The first version used a linear law. The square
looks better because of merges. A merge keeps the area, so the radius grows by √2. The merged bubble then rises twice as
fast, not 1.4 times, and the smallest bubbles almost float. The speed is limited to four times the mean, because merges
add up, and without a limit a chain of merges makes a bubble jump.

**Merges use a sorted sweep, not every pair.** An insertion sort keeps the bubbles in x order. It takes one pass and no
allocation, because bubbles move very little between frames. Each bubble checks to the right only until the gap is too
large for a merge. Merged bubbles are marked and removed after the sweep, because a swap removal would break the order
during the sweep. The old check of every pair was the only cost that grew with the square of the count.

**`fieldScale` is 1**, as for the rain and ridges, because the bubbles are a few cells across and the mottling is one
cell. Interpolation would blur both. `pixelSize` is 3, smaller than for any other effect, because a bubble is a
hundredth of the height. `levels` defaults to 64, not 5, because the depth fade is a smooth gradient and five greys cut
it into bands.

**The foam noise is added before the threshold.** Near the top of the foam, density and threshold are close, so the
noise decides which side each cell is on, and the edge breaks into lumps. Deeper down, density is much larger, so the
noise only changes the brightness. One lookup does both.

**The renderer does full work only where the picture is.** A profile showed that the render loop took 98% of the frame,
nearly all on cells of plain beer or plain air. The renderer now has three parts:

- Rows above the surface band get one `fill(0)`.
- Rows below the band are beer in every column. Each row gets one fill at its depth shade, and then the bubbles in their
  own bounding boxes.
- Only the surface band processes each cell.

The bubble field is never fully cleared, because the box pass sets each cell to zero as it reads it. The fast path uses
one approximation. It measures the depth shade from the level, not from the wavy surface, which is wrong by less than
one palette level. A test draws the same bubble through both paths and requires identical cells. The foam uses the
raft's line, the beer uses the surface, and the droplets are drawn last in their own boxes.

At 1080p and the default 3 px cell (a 640×360 field), a frame takes about 0.6 ms to render and 0.7 ms of physics. Nearly
all the physics time is shallow-water substeps. The breaking pass is skipped on any substep with no steep face. The
continuity pass already measures the steepness, so the check costs almost nothing.

**A resize keeps the glass.** Bubbles, droplets and the level use height units, so they are correct at any resolution.
The head, waves, raft and flow are stored per column or per face, so the library resamples them. If the head were
lost, a resize would show a flash of flat beer. The nucleation sites move to fit the new width. A site is a position on
the glass. Without this, every stream on a narrower window would collect at the right wall.

## Tuning

**Use the demo.** `npm run dev` opens a page with a slider for every setting. This is the best way to tune the effects.

**`amplitude` controls readability.** Body text sits on this background. The defaults are low on purpose, so the
effect changes the page colour and does not become a picture. For a stronger look, increase it. Then read a long
paragraph before you keep the change.

**`gamma` makes the field darker without a change to the palette.** Both ends of the range are fixed points, so gamma
changes the balance between the greys and not the greys themselves.

The defaults for both came from offline calculation over several seeds, not from the browser. One page load uses one
noise field, which can be dark or light in places. One load therefore measures the seed, not the effect. Before this
was found, the browser results did not change steadily with gamma.

- **Plasma**: with no gamma, 19.9% of the background is in the lower half of the palette. `1.18` increases this to
  30.1%.
- **Smoke**: at `1.0`, the darkest grey covered 11%. `1.6` increases this to 23% and leaves 9% at the brightest grey,
  so the highlights stay.

The smoke settles at a mean density of about 0.36, which matches the reference (`geisswerks.com/smoke`). Smoke is
already mostly clear air, so it does not need to be darker.

**The default palette** in dark mode is greys of 18, 24, 30, 36 and 42, on a 6 px cell.

---

## Use the parts on their own

Everything is exported. The maths does not use the DOM, so it runs and can be tested outside a browser.

To shade your own field with the same dither and palette:

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

To run the fluid solver without a canvas:

```js
import { createFluid, stepFluid, randomizeSmoke, SMOKE_DEFAULTS, meanAbsDivergence } from 'canvas-effects';

const fluid = createFluid(64, 48);
const state = randomizeSmoke();

for (let i = 0; i < 100; i++) stepFluid(fluid, SMOKE_DEFAULTS, state, i / 24, 1 / 24);
console.log(meanAbsDivergence(fluid)); // near zero, so the projection works
```

`makeRandom(seed)` returns a small seeded xorshift generator. Pass it as `random` to get the same background each time.
