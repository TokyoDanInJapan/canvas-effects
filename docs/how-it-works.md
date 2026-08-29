# How it works

The [README](../README.md) is the short version. This is the long one: what each effect does, why, and where the
numbers came from.

Most of the numbers come from measurement, not reasoning. Where the obvious approach turned out wrong, the mistake is
recorded. Read those parts before you change anything.

The source carries the same reasoning at closer range. Every parameter is documented where it is declared.

---

## The shared half: two resolutions and a dither

All eight effects render at two scales at once. That is what makes them cheap enough to leave running:

- The **field** is the expensive part. It is computed at `pixelSize × fieldScale` CSS pixels per cell. Soft fields
  such as the smoke and plasma run at half the output resolution. The rain runs at 1:1 for a reason given below.
- The **output** is `pixelSize` CSS pixels per pixel. It is interpolated up from the field and then dithered. Each
  pixel costs a few multiply-adds and a table lookup.

The output is then posterised to five greys, and the dither is what makes that work.

**Why dither at all?** Five levels alone give five flat plateaus with visible steps. The dither nudges each pixel by
its 4×4 Bayer threshold before rounding. A value halfway between two levels then lands low in half the cell and high
in the other half. The region reads as the intermediate shade, and a gradient breaks into texture instead of bands.

**At one CSS pixel a cell the dither turns itself off.** That is what `dither: 'auto'` does, and it is a choice about
look, not a correction. The Bayer pattern actually works best at the display's own pitch. What turning it off buys is
the other look: crisp posterised regions with clean curved boundaries. That look only exists at native resolution.
`dither: true` keeps the smooth version at any size.

**See it for yourself.** `dither: false` posterises flat. The palette is identical, only the distribution changes.
Measured on the demo, the proportion of adjacent pixels that differ falls from 47.5% to 10.4% on the smoke and from
53.1% to 4.7% on the plasma. Texture becomes plateaus. It is not a performance dial: both paths quantise once per
pixel.

The Bayer matrix is normalised to `(m + 0.5) / 16`, which averages to exactly 0.5. That property is the whole trick:
the offset averages to nothing, so the dither changes *which* level a pixel lands on without changing the average
brightness. A unit test pins it.

Finally, every pixel is `base + level × amplitude`. The effect modulates the page colour over a narrow range instead
of replacing it. That is what makes these usable behind text.

## Smoke: a fluid solver

`src/smoke.ts`. Each frame:

1. **forces** - buoyancy from the smoke's own density, plus a light noise stir
2. **confinement** - put back the small-scale swirl the solver eats
3. **advect** - carry the velocity field through itself
4. **project** - remove the divergence, so the fluid stops compressing
5. **advect** - carry the density through the corrected velocity
6. **replenish** - feed a little source back in

The grid wraps in both directions. Periodic boundaries are the easiest case to solve, and they have no edges for a
reader to notice.

### Why a solver and not curl noise

Curl noise is divergence-free, swirls convincingly, and costs far less. What it lacks is **momentum**. Its eddies
come from a noise field, not from causes. They cannot be spun up by the smoke, cannot outlive their source, and
cannot interact. A real solver sheds vortices off shear layers and overturns heavy plumes. That is the difference
between looking like smoke in a still and behaving like smoke in motion.

### Step 4 is the whole thing

Advection alone lets the fluid compress. Density piles up, and the result reads as a stretched texture. The
projection solves for the pressure whose gradient cancels the divergence and subtracts it. That is what makes it a
fluid rather than a warp. `smoke.test.ts` asserts that one projection removes about 90% of the divergence, and that
more iterations remove more.

### Four findings, all from measurement

**Central differences for both the divergence and the gradient are wrong.** They compose into a Laplacian that spans
two cells, not the compact five-point stencil the pressure is solved against. Odd and even cells decouple, and most
of the divergence survives. Backward differences for the divergence and forward for the gradient telescope into
exactly `p[l] + p[r] + p[u] + p[d] - 4p[c]`. That one change took the residual from 35% to under 10%.

**Plain semi-Lagrangian advection is too diffusive.** It resamples every cell every step, so the field smooths itself
even where the flow only carries it. Smoke without sharp edges is fog. MacCormack advection - advect forward, advect
back, subtract half the round-trip error - keeps the edges. The clamp to the cells the trace read is not optional.
Without it the correction overshoots at the edges it exists to preserve and eventually blows the field up.

**Drag dominates the look.** It sets the flow speed, which sets how fast the smoke mixes itself towards uniform. It
must be low enough that a jet's momentum crosses the field, and high enough that the ambient does not turn to fog
between jets. It pairs with `replenish`, which rebuilds the structure the flow mixes away. Retune the two together.

**Cap the simulation grid, not just the output.** The solver touches every cell a dozen times a frame. Shading
touches each pixel once. `maxSimCells` matters far more than `maxPixels`.

### Jets

Every ten seconds or so a nozzle opens on a random edge and fires across the field. About half the jets are dark: a
pale jet paints a bright plume, a dark one carves a clear channel. The momentum is identical either way, so both
distort the smoke equally.

The point is momentum, not smoke. The velocity is *driven towards* the jet's speed rather than added, so the nozzle
behaves like an inflow boundary and holds a fixed speed against the drag. Adding would tie its strength to the frame
rate and to how long it had run.

Two early mistakes are worth recording. A jet is not a puff: dropping a blob of density in barely showed, because
density added to a dense field is mostly clamped away and adds no motion. And a jet needs something to distort:
thinning the ambient to give that blob headroom left the jets tearing through nothing.

### The cursor stirs it

Dragging with a button held pushes the fluid along the drag. The listener is on `window`, because a background canvas
is `pointer-events: none` and never sees a pointer itself. Idle movement is ignored on purpose. A background that
reacts to every twitch is permanently disturbed.

Velocity is *added* here, unlike the jet nozzle. A drag is an impulse, and what happens after release is the fluid's
business. `strokeMaxSpeed` caps it, so a fast flick stays emphatic without tearing a hole.

Measured: a hard drag produces 4.9 mean shade change along its corridor, against 1.8 for the same corridor left
alone, and 2.4 away from it. The surroundings move too, which is the projection doing its job.

`interactive: false` turns it off.

## Plasma: a domain warp

`src/plasma-warp.ts`. Fractal Brownian motion folded into itself twice: the first stage displaces the sampling
position, the second is evaluated there, and the result indexes a seamless plasma tile. The double fold turns cloudy
noise into filaments and swirls.

Time enters twice, and it needs to. `drift` slides the whole domain, which alone would look like a panned photograph.
`churn` moves the inner fields against each other, which makes it evolve in place.

The warp is evaluated on a coarse 36×28 grid and interpolated per pixel, so the noise runs about 1,000 times a frame
instead of once per pixel. The grid is rectangular because the domain is: x is stretched by 4/3 so the field is not
squashed on a wide window, and the grid must be wider by the same factor. 36×28 puts the cells within 2.8% of square.
A 32×32 grid at the same cost would be 33% out. Change one and the other must follow. The tile has every frequency at
an integer number of cycles, so it wraps without a seam - and it must wrap, because warped coordinates wander far
outside `[0, 1]`.

Domain warping is a well-known technique. Under it sit an integer hash, value noise, and fbm. The hash uses
MurmurHash3's public-domain finalising constants, credited in the source.

**Click to ripple.** A click sends a ring of radial displacement out from the point. Two details make it behave:

- It is anchored in **screen** space. The domain drifts, so a ripple placed in domain coordinates would slide across
  the page.
- Its age runs on a **real-time** clock, not animation time. Animation time scales with `speed`, so a ripple aged on
  it would last four times as long at quarter speed. A splash does not slow down with the field it disturbs.

The ring is a Gaussian band about an expanding radius, so the disturbance travels outward rather than the whole disc
heaving. Distances are aspect-corrected so the ring stays circular. Measured: pixels changing per 250 ms go from 508
idle to 2,147 after a click, and back to 471 when the lifetime ends.

The listener is on `window`, as for the smoke. `maxRipples` bounds how many run at once. A click over the cap is
dropped, not queued, so a burst leaves no backlog.

The plasma also carries a motion blur: each frame mixes towards the last, so cells drift between palette levels
instead of flicking. The gamma is applied *before* the blur, so successive frames agree.

## Rain: falling lanes

`src/rain.ts`. One lane per field column. Each frame the whole field is multiplied down by a decay factor, then every
head moves down its lane and writes brightness into the cells it crossed. That is the entire simulation.

**The trail is a consequence, not a drawing.** The obvious version draws a gradient of length `L` behind each head.
That needs `L` as a parameter and breaks when a head moves more than one cell a frame. Decaying the whole field costs
one multiply per cell and handles any speed. It also gets two things right for free. A fast head leaves a longer
streak, because its brightness has had less time to fade over the same distance. And a retiring head leaves its trail
to fade in place.

Trail length is therefore a ratio, not a parameter. A streak reaches `speed × ln(1 / brightness) / fade` cells. At
the defaults on a 90-cell field it is half-lit 15 cells back, a fifth-lit at 34, and invisible around 64. If you
change `speed`, move `fade` with it.

The decay is exponential, so it is frame-rate independent: two half-steps leave the same brightness as one whole
step. A test pins that to three decimal places.

### `fieldScale` is 1 here, and it matters

The smoke, plasma and metaballs render the field at half resolution and let interpolation smooth it. For a continuous
field that is free smoothing. For discrete lanes it is **blur**: neighbouring lanes bleed and crisp streaks become
smudges. At `fieldScale: 1` every output pixel maps to one field cell and the streaks stay sharp. `maxFieldCells` is
matched to `maxPixels` for the same reason - a capped field would silently reintroduce the interpolation. Raising
`fieldScale` is the single biggest way to make this look wrong.

### Click to distort

A click sends an expanding ring that *displaces what is already there* rather than adding light - a droplet on glass
acting as a lens. `distortField` returns the plain field untouched when nothing runs, so an idle page pays nothing.
Only the cells a ring can reach are recomputed.

Sampling wraps sideways and clamps vertically. Wrapping in x matches the lanes, so a ring near an edge pulls streaks
round from the far side. Clamping in y is right for exactly the reason it would be wrong in the smoke: rain has a top
and a bottom, and wrapping would drag the bottom back up into the top.

The effect is subtler than the plasma's ripple, and structurally so. The plasma is a dense field, so a displacement
always has something to move. The rain covers about 13% of the screen, so a ring often passes through empty space.
Measured, a ring mid-flight nearly doubles the changing pixels: 2,191 against 1,169 idle. `distortStrength` is the
dial for more.

### Why no characters

This is the falling-light half of the Matrix look, not the glyphs. At a 6 px cell a character is about three cells
tall and reads as noise. Streaks survive the palette, letterforms do not. Glyphs would need their own renderer and
would not share the dither - a different library, not a fourth effect.

## Ridges: a landscape flown over

`src/ridges.ts`. Rows of a 2D terrain drawn as stacked 1D curves, near rows hiding far ones.

**Hidden lines are the effect.** Without occlusion this is a tangle of squiggles. It is done with a floating horizon:
draw from nearest to farthest, keep the highest covered point per column, and skip anything at or below it. One pass,
no z-buffer, no sorting.

**Rows roll off the bottom rather than being deleted at it.** `overscan` keeps rows alive past the near edge, because
a crest must keep occluding what is behind it after its baseline leaves the screen. Without it the nearest row popped
out of existence each time `travel` crossed a whole number.

One subtlety came with it: `rowAmplitude` freezes a row's size once it passes the near edge. Strict perspective would
keep enlarging it, so a row barely past the edge would loom several screens tall - and its growth would outrun its
baseline, so it would never leave. Frozen, it slides out of frame. Rows entirely below the edge are skipped, so
`overscan` is a bound, not a workload.

**Filling and trails**, both off by default. `fill` turns the lines into solid silhouettes, and the region to fill is
free: the floating horizon already knows the topmost covered point, so the fill runs from the row's curve down to it.
Filling raises the lit fraction of the screen from 24% to 85%. `fillLevel` keeps the fill dimmer than the line so the
crest still reads. Without `fillRandom`, keep it below 1 or the silhouettes go flat. At the default 0.34 an
eight-level ramp still shows eight distinct colours, at mean channel 58 against 106 - which is what keeps it usable
behind text.

`fillRandom` gives every row its own fill value, so each silhouette takes a different palette colour. Pair it with a
ramp. The value comes from hashing the row's `worldZ`, so a row keeps its colour for its whole life. A per-frame roll
would make the stack strobe. It ignores depth on purpose: fading fills by distance would pull the colours together.

`trail` keeps a fraction of the previous frame, so a descending crest smears behind itself. It is faded and maxed
rather than blended: a lerp would dim the lines, and full brightness must stay exactly 1 or one-cell line art stops
surviving the dither. This makes the field stateful, which the rest of the effect is not. It needs no special
occlusion handling - the ghost sits above the line, on the side the horizon does not clip.

**Rows are indexed by travel, not by screen position.** A profile is tied to a whole number of `travel`, keeps its
shape for its whole life, and slides down as you fly past. Tying profiles to screen slots makes the terrain churn in
place, which reads as morphing rather than flight.

The terrain is *ridged* noise: `1 - |2n - 1|` folds fbm about its midpoint and turns hills into sharp crests. Plain
fbm gives rolling dunes. A Gaussian window (`focus`) concentrates the activity into a central band and lets the edges
lie flat.

### Why line art survives the dither

Posterising would normally shred one-cell lines into dashes. It does not here, because **0 and 1 are fixed points of
the ordered dither**: a cell at full brightness lands on the top level at every Bayer position, so a line drawn at 1
comes through intact.

Values *between* levels break up, and that is put to work. Distant rows are drawn dimmer through `depthFade`, land
off-level, and dither into haze. Atmospheric perspective for free.

Two consequences. `fieldScale` is 1, as for the rain - interpolation smears line art. And `pixelSize` defaults to 4,
not 6: a line is one cell wide, and at 6 the lines are thick against the row gaps. Four still clears the pixel
ceiling at 1080p (480 × 270 = 129,600 against a 160,000 cap).

### Click a line to wobble the stack

A click sets a disturbance running from the profile it hit. It is a **wave packet** - an envelope times an
oscillation - so the struck line ripples through a few crests. A lone Gaussian reads as a shockwave, which is a
different thing.

Two decisions carry it:

- **It is keyed to the row, not the screen point.** The wobble stores the `worldZ` of the profile, so it travels with
  the terrain. Anchored to the screen it would sit still while rows slid through it.
- **Distance is measured in a space where a row counts as `wobbleRowSpacing` across.** That is the dial between a
  wobble that runs along one line and one that crosses the stack.

Finding the clicked profile needs `depthAtY`, the inverse of the perspective curve. The offset is applied before
anything is drawn, so the fill and the occlusion follow the wobbled line.

Measured with the flight slowed to nothing: pixels changing per 200 ms go from 2,774 idle to 10,901 mid-wobble and
back to 2,430.

## Metaballs: an implicit surface

`src/metaballs.ts`. Each ball adds a falloff to a shared field, and the field is thresholded to a surface.

**The merging is not a drawing trick.** Two balls that each fall short of `iso` can cross it together. A bridge
appears before their outlines touch, thickens, and thins away as they part. No code draws it - it is what a sum does
when two falloffs overlap. A test pins it: each ball alone below the threshold at the midpoint, the pair above it.

**Wyvill's falloff, not Blinn's exponential.** `exp(-b·r²)` never reaches zero, so every ball touches every cell and
the cost is cells × balls. `(1 - r²/R²)³` is smooth to the second derivative, needs no transcendental, and is exactly
zero past R. That last property changes the algorithm: each ball scatters over its own bounding box, so the work is
the sum of the ball areas. A test matches the scatter against a naive gather to six decimal places.

**Stateless in time**, like the plasma. Positions are closed-form functions of the clock - Lissajous figures with
incommensurable frequencies, so the arrangement never visibly repeats. Any frame can be drawn without the frames
before it, which is why the reduced-motion path is a single draw. A test checks that forty small steps equal one
jump.

**Positions live in height units.** `x` spans `0..aspect`, `y` spans `0..1`, so distance is isotropic and a ball is
round on any window. A test measures a lone blob both ways and requires the extents equal.

**Press and drag to carry a blob.** A held ball is just another contribution to the sum, so it fuses and stretches
like the others. It needs no emissions at all: the ball *is* wherever the pointer last was, so the motion is smooth
for free. Measured against the smoke, the yardstick: variability 0.16 against 0.11, no stalled samples.

**Letting go throws it.** The drag's velocity is handed over on release, so the ball coasts and then curves back onto
its path. Without that a hard flick and a careful placement look identical. Three details make it behave: damping is
exponential, so 24 fps and 60 fps agree. The handover speed is capped, so a flick cannot fling the ball off the edge.
And the position is held inside the field, so a throw at an edge slides along it.

**Releasing is a blend, not a handover.** The ball's free position never stopped moving while you held it, so handing
control straight back makes it jump. `BallOverride.weight` eases from 1 to 0, so the ball converges on a target that
is itself travelling. A test walks the weight down and requires the gap to shrink monotonically to zero.

`grabReach` bounds how near a press must be, so a press does not yank a blob in from across the screen. `grabEase`
and `releaseEase` run in real seconds, unscaled by `speed`, so picking a blob up does not slow down with the drift.

`shoulder` is the look dial. Narrow gives hard-edged classic metaballs, which at five greys means flat silhouettes.
Wide, the default, gives rims that cross several palette levels and dither into a gradient.

---

## Tunnel: one division

`src/tunnel.ts`. For every cell, convert its position to polar coordinates about a vanishing point and read a wall
texture at `(angle, depth / radius)`. That reciprocal is the entire perspective: a point on a cylinder wall projects
to a screen radius inversely proportional to its distance. No camera, no matrix, no depth buffer.

Adding to that coordinate walks the viewer forward. Features do not translate outward at a constant rate - they
**stretch**, moving further the further out they already are. Measured over 1.4 s, a feature at radius 0.15 moves
0.007 while one at 0.5 moves 0.091, twelve times as far. That is the acceleration you feel. It also means no single
shift fits a ray: the first test of the forward motion reported zero displacement while the effect worked, and had to
be rewritten against the projection itself.

### It winds, which is most of the motion

A straight cylinder with a drifting vanishing point reads as camera wobble, because everything moves together. A
corridor whose *axis* winds reads as flight, because the near wall sweeps while the far end holds still. That is
`bend`, and it is exact.

Put the wall at radius 1 about an axis `(X(z), Y(z))` and project through a pinhole. A wall point lands at
`R·(X(z) + cos t, Y(z) + sin t)`, where `R = f / z`. Read backwards, the screen offset to undo is `R·X(z)` with `R`
the **corrected** radius. The exact answer is a fixed point, and one pass is enough: solve straight, look up the axis
at that depth, subtract, solve again. One extra square root and no extra `atan2`.

`R·X`, not `X`, is the part to hold onto. A lateral offset subtends less the further away it is, so the correction
vanishes at the centre and is largest at the edges. That is what makes the near wall sweep. It is also why the
obvious test fails: measured in the depth coordinate the correction looks biggest at the centre, so the test must be
written against the displacement.

Two things fell out of building it:

- **The axis lookup stops at the edge of the vignette**, and not as an optimisation. `v` runs away towards the
  middle, so a winding axis sampled there swings whole cycles between neighbouring cells and the throat fills with
  noise. Nothing is drawn inside the vignette, so the hold costs no visible detail.
- **The axis is tabulated, not evaluated.** Two sines per cell measured 3.8 ms a frame on a 160,000-cell field. The
  axis depends only on depth, and a frame sees a bounded span of depths, so a few hundred samples replace the sines
  with a lerp for a third off the bend's cost. A test pins the table against the exact function.

The bank rolls with where the axis is, not how fast it moves. The derivative is what a vehicle follows, but it is a
quarter-cycle out of phase and reads as the picture counter-rotating against its own bend.

### The wall is built, not sampled from noise

The wall must wrap seamlessly round the circumference or a seam runs the length of the tunnel. fbm only wraps when
the angular span lands on a lattice boundary, which quietly breaks when parameters move. A tile of sinusoids at
whole-number frequencies is periodic by construction, so it wraps whatever the parameters do.

That is why `repeats` is a whole number, and it has a consequence that looks like a bug: rotating by a whole number
of repeats is invisible, because it maps the tile onto itself. A test for `twist` once picked 1.5 turns at two
repeats - three whole tiles - and failed while the twist worked.

### The undersampling, which is what the vignette is for

`depth / radius` is not uniform, so evenly spaced cells do not sample it evenly. The coordinate moves by about
`depth × cell / radius²` between neighbours, which grows without bound towards the middle. However fine the field,
an inner disc exists where consecutive cells land more than half a ring apart and the rings become noise. Two things
follow:

- **`fieldScale` is 1.** The first version ran at 2 and was flat mottle with no rings at all. Supersampling put a
  number on it: the error against a 4× reference halves, 0.037 to 0.020.
- **The vignette is sized to cover the disc**, not just the centre singularity. The disc reaches r = 0.30 on a
  133-row field, so `vignette: 0.3` covers it. Much below that uncovers moiré, not a bright core.

`depth` trades against this directly: it sets how many rings are on screen, and pushes the undersampled boundary out
as its square root. At the original 0.34 the visible annulus spanned 1.4 rings and read as mottle. At 1 it spans
seven.

Cost is an `atan2`, a square root and a reciprocal per cell, plus the bend's square root and lookup: 3.9 ms straight
and 6.2 ms bent on a full 160,000-cell field, or 9% and 15% of one core at 24 fps. That ceiling is only reached above
about 3200×1800.

### Drag to steer it

A press pulls the vanishing point towards the pointer, and release eases it back to its own drift. The blend is the
one piece of state in an otherwise pure function of the clock. It eases in real seconds, because taking hold of the
tunnel should not slow down with the flight.

The dark centroid of the field is **not** a way to measure this, which cost a metric to learn. The wall's own dark
bands swamp the vignette, and the centroid sits within 0.002 of centre whatever the steer does. Comparing mean
brightness in a small disc at the pointer against the same disc at centre does show it.

## Mandelbrot: the picture is its own derivative

`src/mandelbrot.ts`. Everyone has written a Mandelbrot. The question here is how to draw one in five greys at a
hundred and twenty cells across, and the usual answer does not survive that.

### Escape time cannot be shaded directly

Colour by iteration count and the bands crowd without limit at the boundary - precisely where the detail is.
Posterising makes it worse: the aliased bands land on different levels each frame and the boundary boils.

### The distance estimate, and why it is free

Write the smooth escape count the usual way:

```
mu = n + 1 - log2(log|z|)
```

That expression is not an approximate iteration number. The exterior potential of the set is `G = log|z_n| / 2^n`, so
`mu = 1 - log2 G` exactly - the potential on a log scale. The distance to the set is `d = G / |grad G|`, which in mu
is:

```
d = 1 / (ln2 * |grad mu|)
```

`grad mu` is a finite difference over a field already computed. The distance estimate costs one extra pass and
nothing per iteration. The picture is its own derivative.

A test pins this as arithmetic, not a claim: render the same view at two grid densities, and the distance in cells
must double. Median ratio over the field: 2.004.

### It antialiases itself

A filament thinner than a cell is never sampled. The finite difference under-reads the gradient and reports about one
cell instead of zero, so the filament arrives as a soft grey line instead of vanishing between samples. Sub-cell
structure fades out rather than flickering - exactly right for a picture about to be posterised. An analytic distance
estimate would report the true distance, draw the filament black, and strobe as the zoom moved it across the grid.

### Brightness is a function of distance in cells

That is what makes it a zoomer. A cell shrinks as the view descends, so shading on cell distance cannot get busier or
emptier with depth. Measured: the field spans 0.994 to 0.998 of the full range at the home view, eight doublings down
and sixteen alike.

The set is drawn dark and the boundary glows, not the other way round. That is a background decision:
black-set-on-a-blaze is a picture, and this must stay a page. The interior goes through the same distance estimate as
everything else, which matters below.

`glow` is 4 cells, chosen for what happens *after* the field is drawn: the output interpolates before dithering, so a
one-cell rim is mostly gone by the screen. At 1.2 the set was a flat silhouette. Past about 6 the filaments merge
into a wash.

The exterior contours fade by how resolvable they are, not by taste. They need a distance of at least
`2 / (bandWidth × ln2)` cells to survive sampling. Below that they are aliasing, and the glow has taken over anyway.

### The autopilot aims at a filament, not at a lake

A target picked in advance is empty space twenty doublings later. So the target is re-chosen from the frame on screen
every `aimInterval` seconds. A candidate is scored by the **patch around it**, not the cell - the autopilot chooses
what to magnify, not where to stand. The most varied patch wins, but only after three refusals:

| Refused                     | What it is                        | Cost of leaving it out                    |
| --------------------------- | --------------------------------- | ----------------------------------------- |
| more than 30% interior      | the edge of a lake                | 77-93% interior for ten-second stretches  |
| mean brightness over 0.65   | hair finer than the sampling      | 36% of frames a flat grey wash            |
| less than 10% interior      | open exterior, the set out of shot| 85% of frames with nothing in them        |

Three, and not as belt and braces - removing any one walks the autopilot into another failure. The first is obvious:
a lake edge is a smooth curve, and magnifying it gives a straight line for ever. The second is subtler. A patch
bright nearly everywhere is one where every filament is thinner than a cell, and the stray dark cells where a
filament lands on a sample score a *high* spread - so the autopilot aims at them, and arriving there is more of the
same. A feedback loop, and more depth did not clear it. The third is what the first two leave: the safest patch is
always the one furthest from the set.

All three together: 2% of frames in any failed state. An empty scan is a moment, not a verdict: three in a row
abandon the descent, one does not. Turning on the first scan made a small canvas descend for four seconds at a time.

### Why it turns round, and why the pull-out needed no animating

A double holds about 16 significant digits, so the plane runs out near 1e-16. `minSpan` is 1e-11, about 38 doublings
below home, and precision is the only thing that sets it.

It used to be 1.5e-7, on the reasoning that depth costs iterations. **That reasoning was wrong.** The budget a frame
needs is set by how much boundary is in shot, not by magnification - the cost measured flat from 24 doublings to 48.
The precision that does bind is how many representable doubles fit across one field cell, because the distance
estimate is a finite difference and needs sub-cell room:

| doublings | span    | doubles per cell |
| --------- | ------- | ---------------- |
| 24        | 1.5e-7  | 9,300,000        |
| 38        | 1e-11   | 568              |
| 44        | 1.5e-13 | 9                |
| 48        | 9.2e-15 | 1                |

The floor at 44 doublings renders as a soft blob with no filigree. 38 leaves real room.

Two metrics missed this. Counting bit-identical neighbours reads 15% at 42 doublings - exact equality is the last
symptom, long after structure has gone. The field's standard deviation reads 0.337 at the 44-doubling floor, because
a dark region beside a light one has contrast and no structure. Rendering the frame and looking at it settled the
number. The one real cost is time: a descent takes about 110 s instead of 72.

Coming back out is a pure function of the span:

```
centre(span) = deep + (home - deep) * (span - minSpan) / (homeSpan - minSpan)
```

It is exactly `deep` at the turn and exactly `home` at the top, and in between the screen offset of the departure
point is constant - so the view magnifies about that point and never appears to pan. A first-order ease towards home
would read as an enormous sideways slide while still deep.

### Nothing is switched, because a zoom is one coherent motion

The other effects move diffusely and the eye tracks none of it. A zoom is a single motion of the whole frame, and
every discontinuity shows. This juddered, and it took four fixes. The measure is frame-to-frame change in apparent
motion against cruise speed, over a full cycle on a 24 fps loop against a 60 Hz refresh:

|                  | mean     | worst single frame |
| ---------------- | -------- | ------------------ |
| as first written | 48%      | 386%               |
| all four fixed   | **1.7%** | **45%**            |

**The timestep was fixed**, and that is 48% of the 48%. The smoke needs a fixed step - its advection is only stable
over a bounded one. Nothing here is like that: the span and the eases are exact for any step. And a constant step is
actively wrong when the frame rate does not divide the refresh: at 24 fps on 60 Hz, frames sit on screen for 33 ms
and 50 ms alternately while the animation advances 41.7 ms for each. The same effect measured 1.0% on a 144 Hz
display, which pinned the cause.

**The rate was switched.** Reversing at the floor swapped half a doubling a second inwards for two outwards in one
frame. It is eased now, and both turns start *early* by the coast distance, so the descent still lands on `minSpan`
without overshoot. The rate is also **damped rather than lagged**: a first-order ease delivers full deceleration on
the first frame of a phase, which is precisely a sudden stop. Damped, the deceleration builds and releases. Worst
jerk over four cycles went from 102 to 17 doublings per second cubed.

**The aim jumped.** The picker chooses a new cell every `aimInterval`, and a single lag chasing a stepped target has
a corner at every re-aim - those frames moved the picture up to 2.4 times as far as their neighbours. A second lag
(`aimSmooth`) makes the position smooth in its first derivative, so a re-aim is a curve.

**And one real bug.** The pull-out measured its progress from `minSpan`, but the descent stops a little above it. The
difference is nothing in complex units and is then divided by a span near 1e-7, which jumped the view an eighth of a
screen in one frame. Measuring from the span the descent actually stopped at makes both ends exact.

### The classification must not be a cliff

Cells used to flicker between black and bright, and the cause read as obviously correct: interior cells were drawn at
zero. Their boundary neighbours come out at one, and a cell on the line between changes classification whenever the
view shifts by less than its own width - constantly. Measured at fixed points in the plane: 8.5% of consecutive
frames at a sample point were an oscillation.

The fix removed code. An interior cell already carries the iteration budget as its escape count, so the difference
against its neighbours means something: flat in the deep interior, so the distance is enormous and the cell is black.
Steep against the boundary, so the cell is bright - like its exterior neighbour. The classification stops being a
cliff and the flip stops mattering.

A tail remained, from a blind spot: a central difference cannot see a feature one cell wide, so a one-cell filament
got a dark speck down its own glow. The classification knows what the arithmetic cannot - a cell with a neighbour
across the line is *on* the boundary, so its distance is capped at half a cell. Worst disagreement across the line
went from 0.626 to 0.104.

|                                       | flicker  |
| ------------------------------------- | -------- |
| as first written                      | 9.7%     |
| same estimate everywhere, plus the cap| **2.7%** |

Averages over eight seeds and two depths. An earlier version of this table read 0.11%, measured on one quiet recorded
path - a path-dependent number needs averaging before it means anything. Two suspects were checked and cleared: the
iteration budget ticking (2.55% on tick frames against 2.38% off), and the contours (2.43% with bands against 2.37%
without). What remains is ordinary marginality of a finite budget. At 2,000 iterations the flicker is zero and the
frame costs six times as much.

### The camera is a mass, and the goal is a walk

**The camera carries momentum.** It is a critically damped spring with velocity as state, worked in screen units -
the offset is divided by the span going in and out, so the spring means the same thing at every magnification.
Critically damped on purpose: the fastest approach that never overshoots, and an overshoot in a background reads as
wobble. Assigning the pull-out's framing directly used to drop the descent's lateral velocity in one frame, and every
one of the worst frames was such a transition.

**The goal walks instead of jumping.** It moves every frame under two influences. It is *eased* towards the picker's
choice, which keeps the picture good. And it runs along the boundary: the field's gradient points at the set, so its
perpendicular traces the filigree at a fixed brightness contour, which explores. Both are continuous, so neither
jumps. Two wrong turns are worth recording:

- **Contour-following alone drifts into the glow.** It holds its distance faithfully and ends in soft exterior with
  the set out of shot. Measured by the field's standard deviation: 0.237 alone, 0.334 for picker-seated views, 0.354
  with both.
- **The keep test must be looser than the pick test.** Asking whether the goal is still somewhere the picker would
  choose threw it away about once a second - the walk deliberately sits off the boundary, so its patch fails the
  pick criteria by construction. Once chosen, a goal only has to stay on screen and near the boundary.

### The zoom must be anchored to the target

Magnifying about the screen centre multiplies every screen offset by the zoom factor. A target off centre is pushed
out at `2^speed` a second - 1.41 at the default - while the spring closes at about 1.11. The zoom wins: the view sat
a median of 0.21 screen heights from its target, 95th percentile 0.46, and was never going to arrive. Holding the aim
still under the zoom removes the exponential, and the picture then magnifies about a fixed point instead of
magnifying and translating at once. Flicker fell too, since less content sweeps the cells.

Two more things pulled the target off centre, both in the picker. `aimBias` - what sends one run somewhere different
from the last - never stopped, and an off-centre preference is one the zoom permanently fights. It now decides the
heading and fades over about six seconds. And the picker had no hysteresis, so it hopped between near-equal
candidates. Half the preference is now where it last pointed, which settles ties without refusing a better cell.

|        | view-to-aim | view-to-target |
| ------ | ----------- | -------------- |
| before | 0.082       | 0.206          |
| after  | **0.047**   | **0.136**      |

Screen heights, median, over four descents.

### It stops to look around, and sometimes gives ground

The descent is not one uninterrupted fall. Every `exploreEvery` seconds it either **cruises** - eases the zoom off
and walks sideways at one magnification - or **retreats**, giving up a couple of doublings for a wider look. About
two thirds of a cycle descends, an eighth cruises, a twentieth retreats, and the rest pulls out. The choices come
from `hash2` over a counter in the state, so a seeded background replays exactly.

The same two moves are the recovery when a frame goes bad, and which one depends on why:

- A **washed** frame is under-resolved - hair below the sampling - and the only fix for under-resolution is to back
  out. Walking outwards helped but was not enough: the longest wash only fell from 22.7 s to 13.3 s. Retreating took
  it to 4.7 s, and with the eased goal there are now none.
- A **dim** frame is the opposite - nothing near enough to be lit - and backing out only makes it emptier. That one
  stops and lets the walk carry the view to something.

Backing out of a *lake* was tried first and was worse than either: a rescue that gives up two and a half doublings
re-descends into the same place. Four of eight seeded runs spent 62% of their time retreating.

### One measurement that was wrong

For a while this steered on the interior fraction, on the reading that a frame full of set is a black rectangle. It
is not: the set is dark and its boundary glows, so an 85%-interior frame is 85% silhouette - often a lit spike of
exterior driven into a dark mass, one of the better things this draws. Steering away from those spent a third of the
cycle rescuing frames that needed no rescue.

What replaced it is three numbers off one pass (`frameTone`): the lit fraction, the mean brightness, and the interior
share. The lit fraction answers "is there anything to see" - it never fell below 0.107 over 1,276 frames. The mean
catches the wash, which the lit fraction cannot. The interior share only matters at zero, which is the set out of
shot.

### The cost, which is the real constraint

Cost is cells times iterations, and both must be capped. A 1280×800 window gives a 126×79 field - 9,954 cells against
the 10,000 ceiling - with a budget rising from 90 iterations at home to 300. A frame is 0.48 ms at home, 4.5 ms at
the floor, and 3.2 ms median across a descent. Nearly all of it is interior cells, which spend the whole budget.

Two things did **not** work:

- **Cycle detection.** An interior orbit falls onto a cycle, so detecting it should cut the budget short. Measured,
  it made deep frames 55% slower and classified not one cell differently - the expensive cells at depth are exterior
  points that outrun the budget, not periodic ones.
- **More depth.** The false-solid fraction - cells the budget calls interior that a 20,000-iteration reference says
  escape - sits at 5% to 20% and follows the boundary in frame, not the magnification. It shows as slightly-too-thick
  filigree, a graceful failure. `iterationsPerDoubling` is the dial, at linear cost.

The two ceilings trade against each other: half the cells buys twice the iterations, a thinner boundary in a coarser
picture. 10,000 cells is where both are still about right.

---

## Beer: two rates, not a thickness

`src/beer.ts`. A glass poured to `fill` - or pouring itself there - with bubbles streaming up through it and a head
of foam on top. Air above, foam, the liquid line, beer below. The stacking order is the whole picture.

**The bubbles are metaballs, in the strict sense.** `falloff` is imported from `metaballs.ts`, not copied, because
the claim is only true if the kernel is the same. Each bubble adds Wyvill's cubic to a shared field, and the field is
thresholded. The physics fuses a pair only when they are within `merge` of the sum of their radii, which is far
closer than the field needs to have joined them - so the merge is on screen before it happens, and the swap from two
bubbles to one is invisible. A test pins it: a pair a hair too far apart to fuse, already lit between them.

**The head is not drawn anywhere.** A bubble bursts when its top edge breaks the surface and hands its area to the
foam. The foam drains exponentially and levels sideways. What you see is where the two rates balance: turn `rate`
down and the head thins on its own, turn `drain` down and it climbs until `headMax` stops it. Nothing sets a
thickness, which is why the dials behave like a glass rather than a slider.

**A pop deposits an area, not a thickness, and that took two attempts.** Dropping the foam into the one column under
the bubble's centre gives a thickness of area over column width. On a fine field that is enormous, `headMax` clips
most of it away, and the head comes out thin: at 384 columns the settled head was less than half the 96-column
figure. Spread over the columns the bubble actually covers, and divided by the width of *those* columns, it is the
same foam at any resolution. A test pops one bubble on a 64-wide field and a 512-wide one and requires the same
volume.

**The levelling must not run at its stability limit.** Explicit diffusion is stable up to a coefficient of a half,
and at exactly a half it degenerates into "replace each column by the mean of its neighbours" - odd and even columns
decouple, and a spike leaves a comb that never fills in. The step is capped at a quarter and taken several times, so
`spread` stays a physical rate at any window size.

**The surface is shallow water, not an animation.** A height per column and a depth-averaged flow on the faces
between them, with reflecting walls. The first version was a plucked string: one wave speed everywhere and no notion
of how much beer anything stood for. Shallow water gives three behaviours free. Wave speed is `sqrt(g × depth)`, so a
quarter-poured glass carries waves at half the pace of a full one - a test times a pulse across both. The flow
carries itself (the momentum term, read upwind), so a hard-driven front steepens. And volume is conserved by
construction, because every drop that leaves a column through a face arrives in its neighbour. `waveSpeed` keeps its
meaning: gravity is `waveSpeed² / fill`, so a full glass sloshes with a period of `2 × aspect / waveSpeed`, and the
emergence test survives - seed the fundamental, wait half a period, and the high wall must have swung below level.

Numerical points, all with tests. The grid is staggered - heights on columns, flow on faces - which stops the
sawtooth a collocated grid allows. It substeps to a CFL limit sized on the wave speed *and* the flow, because sized
on the wave alone a hard flick outruns the step and the surface goes NaN. The substep count is capped, and each frame
has the speed budget that cap can carry, split in a fixed order: the flow is clamped first, to a few times the wave
speed and never more than half the budget, because the flow is the one input a pointer can make arbitrarily large.
Gravity is then eased to what the flow left, which is always at least the other half. The order fixed a real failure:
easing gravity alone let a savage swirl hand the solver flow the substeps could not represent, the advection shredded
the surface into a grid-scale sawtooth, and the sawtooth's own slopes pumped the flow back up whenever gravity
returned - a boil that never settled. A regression test swirls at the worst dial setting and requires the ring-down.
If the arithmetic is ruined anyway, a backstop restarts the surface rather than handing the renderer a NaN. Drag is a
plain friction, but shear falls on a wave by the square of its wavenumber, so the patter of pops fades in a shake
while the slosh keeps swinging - a test pins the ratio. And the amplitude has no ceiling of its own: the only bounds
are the glass's. A crest may climb to the top of the frame, and a trough may fall to a film on the base. A `waveMax`
clamp used to sit here, and it was the one thing holding a hard swirl back that a real glass would not.

**A crest driven too steep breaks.** The surface is one height per column, so it can lean up to vertical and no
further - but beer driven at a wall climbs, curls and comes apart, and a height field cannot say so. A face steeper
than beer can stand in is let down, the crest handing beer to the trough, which is what breaking is. What comes over
the top is thrown as foam and the odd droplet. This is why stirring hard visibly thickens the head.

**Bursts push the flow, and that is the whole of the idle shimmer.** A pop presses the *flow*, not the heights.
Pressed straight into the surface, two dozen bursts a second show up the same instant and the pour carries a tremor.
A push on the flow has to travel before it shows, and the surface adds the arrivals up as a liquid does. The push
profile is taken off its own mean, so a press moves beer about without adding any. There is no other ambient motion:
turn the fizz off and the glass goes glassy still, which is correct.

**Drag to stir it, and three things come from the one gesture.** Bubbles near the pointer are eased *towards* its
speed, never past it, however long the pointer stays. The drag scrapes fresh bubbles into being, which is how a
bubble starts. And the sideways sweep drives the body of the beer. The old code ploughed a bow-wave *shape* into the
surface, which is the answer rather than the cause. Driving the flow instead, the bow wave emerges - flux converges
ahead of the driven patch and diverges behind - and the beer piles against the leading wall and sloshes back. The
drive fades with depth, and a press is a jab: a splash, spray, and a handful of bubbles knocked loose.

**Only the newest sample drives.** Every live stir samples the same pointer, so letting each push would drive a fast
drag twice: once through its speed, once through the extra samples that speed produced. A test asserts that ten stirs
push exactly as hard as one.

**The fizz streams up standing columns.** Bubbles nucleate at fixed sites, each with its own place, pace and bubble
size, with the rest of the rate scattered anywhere. Site shares are normalised to sum to one, so `rate` stays the
total fizz. The sites are jittered within their own slots of the width: placed at uniform random, a third of the
glass routinely had no site, and the head - fed where the streams run - was bare over the gap. The site weights are
held within a factor of three for the same reason. Seeding picks its columns through the same function, so the
streams stand from the first frame.

**The head is a raft, not a skin.** It has weight and holds together, so it rides the swell and ignores the pricking
of bubbles under it. Drawn straight off the beer's surface, the head juddered at the rate the glass fizzed. So the
foam rides its own line: the surface smoothed sideways over a span wide enough to swallow a pop's dimple, followed at
a pace that depends on how far behind it is. One fixed rate cannot do both jobs - slow enough to lose the fizz takes
half the slosh with it. Read as a distance, the raft ignores what it is barely behind and goes with what it is
plainly behind.

**Spray is beer in the air, under the same gravity.** A hard break, a big burst and a press all throw droplets. They
fly ballistically, stick to the walls more than they bounce, and press the surface they land on. The shared gravity
matters: spray that hangs longer than the slosh it came from reads as another liquid. Droplets are drawn alone rather
than summed into the metaball field - spray is spray - as bright as a lit bubble, in front of whatever they pass.

**The glass can pour itself.** `level` is live state, and everything reads the surface through it. A glass created
short of `fill` climbs there at `pourRate`, fizzing at two and a half times the rate on the way. The mount's
`pour: true` opens on an empty glass instead of running the settle. A reduced-motion visitor gets the settled pint
either way, because their one still frame must not be a picture of nothing.

**Bubbles rise with the square of their radius** - Stokes drag, where the first version used the obvious linear law.
The square is visibly better because of merges: an area-conserving merge grows the radius by root two, so the merged
pair pulls away at twice the speed rather than 1.4 times, and the finest fizz hangs almost still. Capped at four
times the mean speed, because merges compound and an uncapped square lets a lucky chain teleport.

**Merges are found along a sorted sweep, not every pair.** The bubbles are kept in x order by an insertion sort - one
pass, no allocation, because they barely move between frames - and each bubble scans rightward only until the gap
exceeds anything left. Fused bubbles are marked dead and compacted after the sweep, because a swap-removal would tear
the ordering under the scan. The old every-pair check was the one cost that grew as the square of the count.

**`fieldScale` is 1**, as for the rain and ridges: the bubbles are a few cells across, the mottling one cell, and
interpolation would blur exactly those. `pixelSize` is 3, finer than any other effect, because a bubble is a
hundredth of the height. `levels` defaults to 64 against the shared five, because the depth fade is a smooth gradient
and five greys cut it into bands.

**The foam's noise is added before the threshold, not multiplied after.** Near the top, density and threshold are
close, so the noise decides which side a cell lands on and the edge breaks into lumps. Deeper in, density wins and
the noise only mottles the brightness. One lookup does both jobs.

**The renderer only pays full price where the picture is.** Profiled first: 98% of the frame was the render loop,
nearly all on cells that were plain liquid or plain air. It runs in three lanes now. Rows above the surface band are
one `fill(0)`. Rows below it are wet in every column, so each is one depth shade written with a fill, plus the
bubbles over their own bounding boxes. Only the band itself walks its cells. The bubble scratch field never gets a
full clear: the box pass zeroes each cell as it consumes it. One approximation makes the fast lane possible - the
depth shade is measured from the level, not the wavy surface, an error of a fraction of one palette level - and a
test forces the same bubble through both routes and requires identical cells. The foam draws against the raft's line,
the wet ramp against the beer's, and the droplets are a last pass over their own boxes. Measured at 1080p and the
default 3 px cell (a 640×360 field): about 0.6 ms to render and 0.7 ms of physics, nearly all shallow-water substeps.
The breaker's sweep is skipped on any substep with no steep face, using a steepness the continuity pass was already
positioned to measure.

**A resize carries the glass over.** Bubbles, droplets and the level are in height units and mean the same at any
resolution. The head, waves, raft and flow are per column or per face, so they are resampled rather than dropped -
losing the head on a resize is a visible flash of flat beer. The nucleation sites are rescaled to the new width: a
site is a spot on the glass, and carried straight across, every stream on a narrowed window piles onto the right
wall.

## Tuning

**Run the demo.** `npm run dev` gives every dial as a live slider, which is the only sane way to tune this.

**`amplitude` is the readability dial.** Body text sits on this background. The defaults are deliberately low, so the
effect modulates the page rather than becoming a picture. Raise it for a bolder look, then re-read a long paragraph
before you commit.

**`gamma` weights the field dark without changing the palette.** Both ends of the range are fixed points, so it
shifts the balance between the greys, not the greys themselves.

Both defaults were solved offline across several seeds, not measured in the browser. One page load rolls one noise
field, which can be locally dark or light, so one load measures the seed rather than the effect. The browser numbers
came out non-monotonic in gamma before this was noticed.

- Plasma: with no bias, 19.9% of the background sits in the lower half of the palette. `1.18` raises that to 30.1%.
- Smoke: at `1.0` the darkest grey covered 11%. `1.6` takes it to 23% while leaving 9% at the brightest, so the
  highlights survive.

The smoke settles at a mean density near 0.36, where the reference (`geisswerks.com/smoke`) sits. It needs no
darkening - smoke is already mostly clear air.

**The palette and grid were matched against a reference.** The defaults land on greys 18/24/30/36/42 in dark mode on
a 6 px cell, measured from <https://codapress.co.uk/>, whose background runs 12/22/32 in runs of five to six pixels.
`pixelSize: 3` looked right but measured half their size.

---

## Using the pieces on their own

Everything is exported, and the maths is DOM-free so it runs and tests outside a browser.

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
console.log(meanAbsDivergence(fluid)); // near zero - the projection is working
```

`makeRandom(seed)` gives a small seeded xorshift generator, so passing it as `random` makes a background
reproducible.
