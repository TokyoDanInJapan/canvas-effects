# How it works

The [README](../README.md) is the short version. This is the long one: what each effect actually does, why it does it
that way, and where the numbers came from.

Most of it was arrived at by measuring rather than by reasoning, and the places where the obvious approach turned out to
be wrong are recorded as such - they are the parts worth reading before changing anything.

The source carries the same reasoning at closer range. Every parameter is documented where it is declared, with a note on
what it does and where its default came from.

---

## The shared half: two resolutions and a dither

All seven render at two scales at once, and this is what makes them cheap enough to leave running:

- The **field** - the expensive part, whatever generates it - is computed at `pixelSize × fieldScale` CSS pixels per
  cell. The smoke and plasma fields are soft and low-frequency and gain nothing from more samples, so they run at half
  the output resolution; the rain runs at 1:1 for a reason of its own, below. This is where all the real work happens.
- The **output** is `pixelSize` CSS pixels per pixel, bilinearly interpolated up from that field and then dithered. Per
  pixel that is a handful of multiply-adds and a table lookup.

Then the output is posterised to five greys - and that is where the dither earns its place.

**Why dither at all?** A five-level palette on its own gives five flat plateaus with visible steps between them. Nudging
each pixel by its 4×4 Bayer threshold before rounding means a value halfway between two levels lands on the lower one
for half the pixels in the cell and the higher one for the other half. The region reads as the intermediate shade, and a
gradient crossing it breaks into texture rather than a band.

**Seeing it for yourself.** `dither: false` posterises flat instead. The palette is identical either way - only the
distribution changes - so it is the cleanest demonstration of what the Bayer threshold is doing. Measured on the demo,
switching it off takes the proportion of horizontally adjacent pixels that differ from 47.5% to 10.4% on the smoke and
from 53.1% to 4.7% on the plasma: texture becomes plateaus. It is not a performance dial; both paths quantise once per
pixel and the dither adds an array lookup and an add.

The Bayer matrix is normalised to `(m + 0.5) / 16`, which averages to **exactly 0.5**. That is the property the whole
effect rests on: the offset it adds averages to nothing, so dithering changes _which_ level a pixel lands on without
changing the average brightness of a region. There is a unit test pinning it.

Finally, every pixel is `base + level × amplitude`. That is what makes these usable behind text: the effect modulates a
page colour over a narrow range instead of replacing it.

## Smoke: a fluid solver

`src/smoke.ts`. Each frame:

1. **forces** - buoyancy from the smoke's own density, plus a light noise stir
2. **confinement** - put back the small-scale swirl the solver eats
3. **advect** - carry the velocity field through itself
4. **project** - remove the divergence, so the fluid stops compressing
5. **advect** - carry the density through the corrected velocity
6. **replenish** - feed a little source back in

The grid wraps in both directions, which makes the boundary conditions periodic - both the easiest case to solve and the
one with no edges for a reader to notice.

### Why a solver and not curl noise

A curl-noise flow is divergence-free, swirls convincingly, and is far cheaper. What it does not have is **momentum**.
Its eddies are prescribed by a noise field rather than caused by anything, so they cannot be spun up by the smoke,
cannot persist once whatever made them has gone, and cannot interact. A real solver gets vortices shedding off shear
layers, plumes that overturn because they are heavy, and structure with a history. That is the difference between
something that looks like smoke in a still frame and something that behaves like it in motion.

### Step 4 is the whole thing

Advection on its own lets the fluid compress: density piles up, and it reads as a texture being stretched. Solving for
the pressure whose gradient cancels the divergence, and subtracting it, is what makes it a fluid rather than a warp.
`smoke.test.ts` asserts the projection removes ~90% of the divergence in one go, and that more iterations removes more.

### Four things that were not obvious, all found by measuring

**Central differences for both the divergence and the gradient is wrong**, and wrong in a way that looks like a physics
problem rather than a discretisation one. They compose into a Laplacian spanning two cells, which is not the compact
five-point stencil the pressure is solved against - so odd and even cells decouple and most of the divergence survives
the projection. Backward differences for the divergence and forward for the gradient telescope into exactly
`p[l] + p[r] + p[u] + p[d] - 4p[c]`. That one change took the residual from 35% to under 10%.

**Plain semi-Lagrangian advection is too diffusive to hold smoke together.** It resamples every cell every step, so the
field smooths itself out even where the flow is only carrying it - and smoke without sharp edges is fog. MacCormack
advection (advect forward, advect back, subtract half the round-trip error) is what keeps the edges. The clamp to the
cells the trace actually read is not optional: without it the correction overshoots at exactly the edges it exists to
preserve, pushing densities outside 0..1 and eventually blowing the field up.

**Drag dominates the look.** It sets the flow speed, which sets how fast the smoke mixes itself towards uniform. Fast
flow looks livelier frame to frame and reads as fog within seconds. It has to serve both sides: low enough that a jet's
momentum crosses the field, high enough that the ambient does not mix itself to fog between jets. It is paired with
`replenish`, which keeps re-establishing the structure the flow is mixing away - re-sweep the two together if you touch
either.

**Cap the simulation grid, not just the output.** The solver touches every cell a dozen times a frame where shading
touches each pixel once, so `maxSimCells` matters far more than `maxPixels`.

### Jets

Every ten seconds or so a nozzle opens on a random edge and fires across the field for a second or two. About half are
dark: a pale jet drives the density up and paints a bright plume, a dark one drives it to nothing and carves a clear
channel through whatever is there. The momentum is identical either way - the difference is only what the nozzle emits,
which is why both distort the smoke by the same amount.

The point is momentum, not smoke: it drives the fluid hard enough to shove what is already there aside, and the hole it
opens and the vortices rolling off its edges are the effect. The velocity is _driven towards_ the jet's rather than
added to it, so the nozzle behaves like an inflow boundary and holds a fixed speed however hard the surrounding fluid
and the drag push back - adding would make its strength depend on the frame rate and on how long it had been running.

Two things this got wrong on the way, both instructive. A jet is not a puff: the first version dropped a blob of
_density_ in, which barely showed, because density added to an already-dense field is mostly clamped away and adds no
motion at all. And a jet needs something to distort - the ambient was briefly thinned right down to give that blob
headroom, which left the jets tearing through nothing.

### The cursor stirs it

Dragging with a button held pushes the fluid along the drag. The listener is on `window` rather than the canvas, because
a background canvas is `pointer-events: none` so that it never intercepts anything meant for the page - which also means
it never sees a pointer itself. Idle movement is ignored on purpose: reacting to every twitch would mean the background
is permanently disturbed by a reader who is only moving the cursor off the text.

Velocity is _added_ here rather than driven towards a target as the jet nozzle does - a drag is an impulse, and what
happens after the reader lets go should be the fluid's business. `strokeMaxSpeed` caps it, so a fast flick stays
emphatic rather than tearing a hole that takes seconds to settle.

Measured: a hard drag produces 4.9 mean shade change along the corridor it swept, against 1.8 for the same corridor left
alone, and 2.4 away from it - the surroundings move too, which is the pressure projection doing its job.

Pass `interactive: false` to turn it off.

## Plasma: a domain warp

`src/plasma-warp.ts`. Fractal Brownian motion folded into itself, in two stages: the first displaces the sampling
position, the second is evaluated at that displaced position, and the result is where a seamless plasma tile gets read
from. Folding it twice is what turns plain cloudy noise into something with filaments and swirls in it.

Time enters twice, and it needs to. `drift` slides the whole domain, which on its own would look like a photograph being
panned; `churn` moves the inner fields against each other, which is what makes it evolve in place.

The warp is evaluated on a coarse 36×28 grid and interpolated per pixel, so the noise runs ~1,000 times a frame instead
of once per pixel. That grid is rectangular because the domain it samples is: x is stretched by 4/3 so the field does
not look squashed on a wide window, and the grid has to be wider by the same factor or each cell covers a third more
domain in x than in y and the warp reads as smeared sideways. 36×28 puts the cells within 2.8% of square, where a 32×32
grid at the same cost would be 33% out. The two are a pair - change one and the other has to follow. The tile it samples has every frequency at an integer number of cycles across it, which is what makes
it wrap without a seam - and it has to wrap, because warped coordinates wander a long way outside `[0, 1]`.

Domain warping is a well-known technique. The layers under it are an integer hash, value noise on the hash, and fbm on
the noise; the hash mixes with MurmurHash3's public-domain finalising constants, credited in the source.

**Click to ripple.** A click sends a ring of radial displacement out from where it landed, added to the finished warp
coordinate. Two details make it behave:

- It is anchored in **screen** space, not the warp's domain. The domain drifts, so a ripple placed in domain coordinates
  would slide across the page and not stay where it was clicked.
- Its age runs on a **real-time** clock, deliberately not on animation time. Animation time is scaled by `speed`, so
  ageing a ripple on it would make one last four times as long at quarter speed - the disturbance would slow down along
  with the field it is disturbing, which is not how a splash behaves.

The ring is a Gaussian band about an expanding radius, so the disturbance travels outward rather than the whole disc
heaving at once, and distances are aspect-corrected so it stays circular on a wide window. Measured in the browser: pixels
changing per 250ms goes from 508 idle to 2147 just after a click, and back to 471 once the lifetime elapses.

Listened for on `window` rather than the canvas, for the same reason the smoke's stirring is - a background canvas is
`pointer-events: none`, so it never sees a pointer itself. `interactive: false` turns it off; `maxRipples` bounds how many
run at once, and a click over that is dropped rather than queued, so a burst does not leave a backlog rippling after the
reader has stopped.

The plasma also carries a motion blur - each frame mixes towards the last - which smooths the underlying field between
frames so cells drift between palette levels rather than flicking between them. Note that the gamma is applied
_before_ the blur, so successive frames agree with each other.

## Rain: falling lanes

`src/rain.ts`. One lane per field column. Each frame the whole field is multiplied down by a decay factor, then every
active head moves down its lane and writes brightness into the cells it crossed. That is the entire simulation.

**The trail is a consequence, not a drawing.** The obvious implementation draws a gradient of length `L` behind each
head - which needs `L` as a parameter, recomputes the gradient every frame, and breaks when a head moves more than one
cell per frame, because the tail either detaches or has to be stitched back on. Decaying the whole field instead costs
one multiply per cell, handles any speed without a special case, and gets two things right for free: a fast head leaves
a **longer** streak than a slow one, because its brightness has had less time to fade over the same distance; and a
head retiring at the bottom leaves its trail to fade in place rather than vanishing with it.

Trail length is therefore not a parameter but a ratio. A streak reaches `speed × ln(1 / brightness) / fade` cells
before decaying to that brightness - at the defaults, on a ~90-cell-tall field, still half-lit 15 cells back, a
fifth-lit at 34, invisible around 64. Change `speed` and `fade` has to move with it or the look changes as much as the
pace does.

The decay is exponential rather than linear, so it is frame-rate independent: halving `dt` and stepping twice leaves
the same brightness behind. There is a test pinning that to three decimal places.

### `fieldScale` is 1 here, and that matters

The smoke, the plasma and the metaballs render the field at half the output resolution and let bilinear interpolation
smooth it. For a continuous field that is free smoothing. For discrete lanes it is **blur** - neighbouring lanes bleed into each other
and crisp streaks turn into soft vertical smudges.

At `fieldScale: 1` every output pixel maps to exactly one field cell, the horizontal interpolation weight is zero
everywhere, and the streaks stay sharp. `maxFieldCells` is matched to `maxPixels` for the same reason: capping the
field would silently reintroduce the interpolation the scale of one exists to avoid. Raising `fieldScale` is the single
biggest thing you can do to make this look wrong.

### Click to distort

A click sends an expanding ring through the rain that _displaces what is already there_ rather than adding light of its
own - a droplet on glass acting as a lens, bending the streaks as it passes. `distortField` returns the plain field
untouched when nothing is running, so an idle page pays nothing, not even a copy, and only the cells a ring can reach
are recomputed.

Sampling wraps sideways and clamps vertically. Wrapping in x matches the lanes, so a ring near an edge pulls streaks
round from the far side; clamping in y is right for exactly the reason it would be wrong in the smoke - rain has a top it
falls from and a bottom it retires at, and wrapping would drag the bottom of the screen back up into the top.

**It is subtler than the plasma's ripple, and structurally so.** The plasma is a dense continuous field, so a
displacement always has something to move. The rain is about 13% covered, so a ring frequently passes through empty space
with nothing to bend. Measured, a ring mid-flight nearly doubles how much of the screen changes frame to frame - 2191
pixels against 1169 idle - and it reads better in motion than in a still, where the eye follows the moving
discontinuity. `distortStrength` is the dial if you want more of it.

### Why no characters

This is the falling-light half of the Matrix look, not the glyphs. The renderer takes a scalar field and posterises it
to five greys through a 4×4 Bayer matrix on a 6px cell - at that size a character is about three cells tall and reads
as noise. Streaks survive the palette; letterforms do not. Glyphs would need their own renderer and would not share the
dither at all, which is a different library rather than a fourth effect in this one.

## Ridges: a landscape flown over

`src/ridges.ts`. Rows of a 2D terrain drawn as stacked 1D curves, with the near rows hiding the far ones.

**Hidden lines are the effect.** Without occlusion this is a tangle of overlapping squiggles. With it you get depth,
and the characteristic bitten-out look where a near crest eats into the rows above. It is done with a floating horizon:
draw from nearest to farthest, keep the highest point covered so far per column, and skip anything at or below it. One
pass, no z-buffer, no sorting - `rows × width` work for a whole frame.

**Rows roll off the bottom rather than being deleted at it.** `overscan` keeps rows alive past the near edge, because a
crest stays visible long after its baseline has left the screen and its silhouette must keep occluding what is behind
it. Without it the nearest row crept down to `bottomMargin`, popped out of existence the moment `travel` crossed the
next whole number, and nothing was ever drawn below `bottomMargin` at all.

One subtlety that came with it: `rowAmplitude` freezes a row's size once it passes the near edge. Strict perspective
would keep enlarging it - you are flying into it - and a row barely past the edge would loom several screen heights
tall and throw a silhouette across the whole field. Worse, that growth outruns the baseline's, so the row would never
qualify as fully below the screen and would never leave. Freezing the size lets it simply slide out of frame. Rows that
are entirely below the edge are skipped, so `overscan` is a bound rather than a workload.

**Filling and trails**, both off by default. `fill` turns the stack from a pile of lines into a pile of solid
silhouettes, and it costs nothing to work out where: the floating horizon already knows the topmost point covered by
nearer rows, so the fill runs from a row's own curve down to that - exactly the region belonging to it. `fillLevel`
keeps it dimmer than the line so the crest still reads against its own body. Measured: filling takes the lit fraction of
the screen from 24% to 85%.

`fillLevel` is a ceiling on fill brightness and scales both kinds. Without `fillRandom` it wants to stay below 1, or
the silhouettes go flat and the ridgelines vanish into them. With `fillRandom` it darkens the whole set without
flattening it: at the default 0.34 the fills still span every palette colour, they are simply dimmer - measured on an
eight-level violet ramp, eight distinct colours at both 0.34 and 1.0, with mean channel value 58 against 106. That is
what keeps it usable behind text.

`fillRandom` gives every profile its own fill value instead, so each silhouette takes a different colour from the
palette - pair it with a ramp. The value comes from hashing the row's `worldZ` rather than being rolled per frame, which
is the whole trick: a row keeps its colour for its entire life as it descends, where a per-frame roll would make the
stack strobe. It ignores depth on purpose, since fading the fills by distance would pull the colours back towards each
other, though it does respect `fillLevel`. With dithering on each fill is a mix of two neighbouring palette colours; `dither: false` gives flat single ones.

`trail` keeps a fraction of the previous frame, so a descending crest smears behind itself. It is faded and maxed rather
than blended, like the rain's trails - a lerp towards the new frame would dim the lines, and full brightness has to stay
exactly 1 or one-cell line art stops surviving the dither. Note that this makes the field **stateful**, which the rest of
this effect otherwise is not. It needs no special handling against the occlusion: the profiles descend, so the ghost sits
above the line, on the side the horizon does not clip.

**Rows are indexed by travel, not by screen position.** A profile is tied to a whole number of `travel`, so it keeps
its own shape for its whole life and simply slides down as you fly past it; a new one enters at the top each time
`travel` crosses an integer. Tying profiles to screen slots instead makes the terrain churn in place without ever
arriving, which looks like morphing rather than flight.

The terrain is _ridged_ noise - `1 - |2n - 1|` folds fbm about its midpoint and turns smooth hills into sharp crests.
Plain fbm gives rolling dunes, which read as a landscape rather than as a signal. A Gaussian window (`focus`)
concentrates the activity into a central band and lets the edges lie flat, which is the signature of the reference.

### Why line art survives the dither

Posterising to five greys through a Bayer matrix would normally shred one-cell-wide lines into dashes. It does not
here, because **0 and 1 are fixed points of the ordered dither** - a cell at full brightness lands on the top level for
every Bayer position, so a line drawn at 1 comes through intact.

Values _between_ palette levels are the ones that break up, and that is put to work: distant rows are drawn dimmer via
`depthFade`, land off-level, and dither into haze. Atmospheric perspective for free, from the thing that would
otherwise be a problem.

Two consequences worth knowing. `fieldScale` is 1, for the same reason as the rain and the tunnel - interpolating between
cells smears line art. And `pixelSize` defaults to **4** rather than 6: a line is one cell wide, and at 6 the lines are thick
relative to the gaps between rows, so the stack reads as static rather than as a plot. Four still clears the pixel
ceiling at 1080p (480 × 270 = 129,600 against a 160,000 cap).

### Click a line to wobble the stack

A click sets a disturbance running from the profile it landed on. It is a **wave packet** - an envelope around a
travelling front times an oscillation - so the struck line ripples through a few crests rather than heaving once. A lone
Gaussian would read as a shockwave, which is a different thing.

Two decisions carry it:

- **It is keyed to the row, not the screen point.** A wobble stores the `worldZ` of the profile it hit, so it travels
  with the terrain as that profile approaches. Anchored to a screen position instead, it would sit still while rows slid
  through it, which reads as a stationary distortion rather than as something you did to the landscape.
- **Distance is measured in a space where a row counts as `wobbleRowSpacing` across.** That is what makes one front
  spread sideways along the struck line _and_ outward through its neighbours. It is the dial between a wobble that runs
  along one line and one that crosses the stack; lower spreads across rows faster.

Working out which profile was clicked needs `depthAtY`, the inverse of `rowY` - the rows are placed by a perspective
curve, so it is not a division. The offset is applied to the curve before anything is drawn, so the fill and the
occlusion follow the wobbled line rather than the flat one.

Measured with the flight slowed right down, so the wobble is the only thing moving: pixels changing per 200ms goes from
2774 idle to 10901 mid-flight, and back to 2430 once the lifetime elapses.

## Metaballs: an implicit surface

`src/metaballs.ts`. Each ball adds a falloff to a shared scalar field; the field is then thresholded to a surface.

**The merging is not a drawing trick.** Two balls whose individual contributions both fall short of `iso` can cross it
together, so a bridge appears between them before their outlines touch, thickens as they close, and thins away as they
part. There is no special case for it anywhere - it is only what a sum does when two falloffs overlap. `metaballs.test.ts`
pins exactly that: each ball alone below the threshold at the midpoint, the pair above it.

**Wyvill's falloff, not Blinn's exponential.** `exp(-b · r²)` never reaches zero, so every ball influences every cell
and the cost is cells × balls. `(1 - r²/R²)³` is smooth to the second derivative, needs no transcendental, and is
_exactly_ zero past R. That last property changes the algorithm rather than just trimming it: each ball scatters itself
over its own bounding box, so the work is the sum of the ball areas. There is a test asserting the optimised scatter
matches a naive per-cell gather to six decimal places.

**Stateless in time**, like the plasma. Positions are closed-form functions of the clock - Lissajous figures with
deliberately incommensurable frequencies, so the set never falls back into its starting arrangement on a visible cycle.
A frame can be drawn at any moment without having drawn the ones before it, which is what makes the reduced-motion path
a single draw with no settling run. A test checks that stepping to `t` in forty small renders equals jumping there in
one.

**Positions live in height units.** `x` spans `0..aspect` and `y` spans `0..1`, so distance is isotropic and a ball is
round on any window. Working in `0..1` on both axes would stretch every blob into an ellipse on a wide screen; a test
measures a lone blob's extent both ways and requires them equal.

**Press and drag to carry a blob around.** A dragged ball is just another contribution to the sum, so it reaches for its
neighbours exactly as the others do - run it into one and they fuse, pull away and the neck stretches and parts. It is the
one interaction here that needs no emissions at all: the held ball simply _is_ wherever the pointer last was, so there is
nothing to space out or interpolate, and it comes out smooth for free. Measured against the smoke, which is the yardstick
for that: variability 0.16 against 0.11, with no stalled samples.

**Letting go throws it.** The drag's velocity is handed over on release, so the ball coasts on in the direction it was
moving and _then_ curves back onto its path. Without that it reads as losing momentum: the blend pulls it straight back,
and a hard flick and a careful placement look identical. Damping is exponential so it behaves the same at 24fps and
60fps, the handover speed is capped so a violent flick cannot fling the ball off the edge before the blend reels it in,
and the position is held inside the field so a throw at an edge slides along it rather than vanishing and reappearing.

**Releasing has to be a blend, not a handover.** A ball's position is a closed-form function of the clock, so it never
stopped moving while you held it - hand control straight back and it jumps from your cursor to wherever its orbit had got
to. `BallOverride.weight` eases from 1 to 0 instead, so the ball converges on a target that is itself still travelling.
There is a test that walks the weight down and requires the gap to the free position to shrink monotonically to zero.

`grabReach` bounds how near a press has to be; beyond it a press takes hold of nothing rather than yanking a blob in from
across the screen. `grabEase` and `releaseEase` are both in real seconds, unscaled by `speed`, so picking a blob up does
not take four times as long because the arrangement happens to be drifting slowly.

`shoulder` is the look dial. Narrow gives hard-edged classic metaballs - which at five greys means flat silhouettes,
because a hard threshold produces a two-value field and wastes the palette entirely. Wide, the default, gives shaded
blobs whose rims cross several palette levels and dither into a gradient.

---

## Tunnel: one division

`src/tunnel.ts`. For every cell, convert its position to polar coordinates about a vanishing point and read a wall
texture at `(angle, depth / radius)`. That reciprocal is the entire perspective: a point on an infinite cylinder's wall
projects to a screen radius inversely proportional to how far down the cylinder it sits, so sampling at `depth / radius`
_is_ the projection. No camera, no matrix, no depth buffer.

Adding to that coordinate walks the viewer forward. Because the far wall is compressed into the middle, features do not
translate outward at a constant rate - they **stretch**, moving further the further out they already are. Measured over
1.4 s at the defaults, a feature at radius 0.15 moves 0.007 while one at 0.5 moves 0.091 - twelve times as far. That is
the acceleration you feel, and it also means no single cross-correlation shift fits a ray: the first test written for the forward motion
reported zero displacement while the effect was working perfectly, and had to be rewritten against the projection itself.

### It winds, which is most of the motion

A straight cylinder with a drifting vanishing point reads as the camera wobbling - everything on screen moves together. A
corridor whose _axis_ winds reads as flight, because the near wall sweeps past while the far end holds still. That is
`bend`, and it is exact rather than faked.

Put the wall at radius 1 about an axis at `(X(z), Y(z))` and project through a pinhole: a wall point at depth `z`, angle
`t`, lands at `R · (X(z) + cos t, Y(z) + sin t)`, where `R = f / z` is the radius the wall appears at. Read that
backwards - which is what sampling the field does - and the screen offset to undo is `R · X(z)`, with `R` the
**corrected** radius rather than the raw one. So the exact answer is a fixed point, and one pass of it is enough: solve
the straight tunnel, look up the axis at the depth that gives, subtract, solve again. One extra square root, and no extra
`atan2` - the first pass needs only the radius.

`R · X`, not `X`, is the part worth holding onto. A lateral offset subtends less the further away it is, so the
correction vanishes at the centre of the screen and is largest at the edges. That is what makes the near wall sweep while
the far end sits still, instead of the whole picture sliding sideways. It is also why the obvious test of it fails:
measured in the depth coordinate the correction looks _biggest_ at the centre, because `dv/dr` runs away there, so the
test has to be written against the displacement.

Two things fell out of building it:

- **The axis lookup stops at the edge of the vignette**, and that is not an optimisation. `v` runs away towards the
  middle, so a winding axis sampled there swings by whole cycles between neighbouring cells and the throat fills with
  churning noise. Nothing is drawn inside the vignette, so holding the lookup at its edge costs no visible detail - a
  horizon, in effect, and a bent corridor really is blocked by its own wall beyond some depth.
- **The axis is tabulated, not evaluated.** Two sines per cell measured 3.8 ms a frame on a 160,000-cell field, as much
  again as the rest of the effect together. The axis depends on nothing but depth, and one frame only ever sees depths
  between its furthest corner and the edge of the vignette - so a few hundred samples across that span replace every one
  of those sines with a lerp, for a third off the bend's cost. The same trick as the wall tile, and a test pins the table
  against the exact function.

The bank is rolled by where the axis has got to rather than by how fast it is moving. The derivative is what a vehicle's
roll actually follows, but it is a quarter-cycle out of phase with the lean, and that reads as the picture
counter-rotating against its own bend.

### The wall is built, not sampled from noise

It has to wrap seamlessly around the circumference or a seam runs the length of the tunnel. fbm only wraps when the
angular span happens to land on an integer lattice boundary, which is a constraint on two parameters at once and
quietly breaks when either moves. A tile of sinusoids at whole-number frequencies is periodic by construction, so it
wraps whatever the parameters do - the same reason the plasma builds one.

That is also why `repeats` is a whole number, and it has a consequence that looks like a bug: rotating by a whole number
of repeats is **invisible**, because it maps the tile onto itself. The tunnel has genuine rotational symmetry of order
`repeats`. A test for `twist` picked 1.5 turns at two repeats - exactly three whole tiles - and failed while the twist
worked.

### The undersampling, which is what the vignette is really for

`depth / radius` is not a uniform mapping, so evenly spaced cells do not sample it evenly. The coordinate moves by about
`depth × cell / radius²` between neighbours, which grows without bound towards the middle - so however fine the field,
there is an inner disc where consecutive cells land more than half a ring apart and the rings become noise. Two things
follow, and neither was visible in any aggregate metric:

- **`fieldScale` is 1**, as it is for the rain and the ridges. The first version rendered at `fieldScale: 2` with
  `depth: 0.34` and was flat mottle with no rings in it at all - recognisable as a tunnel only when rendered at four
  times the resolution. Supersampling puts a number on it: the error against a 4× reference halves, 0.037 to 0.020.
- **The vignette is sized to cover that disc**, not just the singularity at the exact centre. Against the tile's highest
  ring frequency the disc reaches r = 0.30 on a 133-row field and r = 0.20 at the pixel ceiling, so `vignette: 0.3`
  covers both. Take it much below that and what is uncovered is a patch of moiré rather than a bright core.

`depth` trades directly against this: it is how many rings land on screen at once, and it pushes the undersampled
boundary outward as its square root. At the original 0.34 the whole visible annulus spanned 0.47 of a tile - 1.4 rings  - 
which is why it read as mottle rather than as depth. At 1 it spans 2.3 tiles, or seven rings.

Cost is an `atan2`, a square root and a reciprocal per cell, plus the bend's second square root and table lookup: on a
full 160,000-cell field, 3.9 ms a frame straight and 6.2 ms bent, or 9% and 15% of one core at 24 fps. Between the plasma
and the fluid solver. That ceiling is only reached above about 3200×1800 - at 1280×800 the bend costs nothing measurable
against the frame clock's own quantisation.

### Drag to steer it

A press pulls the vanishing point towards the pointer and a release eases it back to its own drift. The blend is carried
between frames - the one piece of state in an effect that is otherwise a pure function of the clock - and it eases in
real seconds rather than scaled ones, because taking hold of the tunnel should not take longer just because the flight is
slow.

The dark centroid of the whole field is **not** a way to measure this, which cost a metric to find out: the wall's own
dark bands are spread over the entire frame and swamp the vignette, so the centroid sits within 0.002 of the middle
whatever the steer is doing. Comparing mean brightness in a small disc at the pointer against the same disc at the
geometric centre does show it.

## Mandelbrot: the picture is its own derivative

`src/mandelbrot.ts`. Everyone has written a Mandelbrot. The interesting question here is not the set - it is how you draw
one in **five greys at a hundred and twenty cells across**, and the usual answer does not survive that at all.

### Escape time cannot be shaded directly

Colour by iteration count and the bands crowd together without limit as you approach the boundary. However fine the
field, there is always a region where consecutive cells are more than a band apart - and it is not some corner of the
picture, it is precisely where all the detail is. Posterising that to five levels makes it worse, not better: the aliased
bands land on different levels from one frame to the next and the boundary boils.

### The distance estimate, and why it is free

Write the smooth escape count in the usual way:

```
mu = n + 1 - log2(log|z|)
```

Now notice what that actually is. The exterior potential of the set - the Douady-Hubbard potential, the Green's function
of the complement - is `G = log|z_n| / 2^n`. So `log2 G = log2 log|z_n| - n`, and therefore

```
mu = 1 - log2 G      exactly
```

mu is not an approximate iteration number. It **is** the potential, on a log scale. And the distance from a point to the
set is `d = G / |grad G|`, which in terms of mu is

```
d = 1 / (ln2 * |grad mu|)
```

`grad mu` is a finite difference over a field that has just been computed. So the distance estimate costs one extra pass
over the grid and nothing per iteration - no derivative carried through the orbit, no second pass over it. The picture is
its own derivative.

There is a test pinning this down as an arithmetic fact rather than a claim: render the same view on a grid and on one
twice as fine, so that cell `(2i, 2j)` samples exactly the complex point cell `(i, j)` did. The cell is half as wide, so
the distance reported in cells should be twice. Median ratio over the field: **2.004**.

### It antialiases itself, which is the part that makes it viable

A filament thinner than a cell is never sampled. The finite difference therefore under-reads the true gradient and
reports a distance of about one cell rather than zero - and the filament arrives as a soft grey line instead of falling
between two samples and vanishing. Sub-cell structure fades out rather than flickering, which is exactly what you want
from a picture that is about to be posterised.

An analytic distance estimate, carried through the iteration, would not do this. It would report the true distance, the
filament would be black, and it would strobe as the zoom moved it across the sampling grid.

### Brightness is a function of distance in cells

Which is what makes it a zoomer rather than a still. A cell shrinks as the view descends, so shading on a distance
measured in cells cannot get busier or emptier with depth. Measured: the field spans **0.994 to 0.998** of the full 0..1
range at the home view, eight doublings down and sixteen doublings down alike.

The set itself is drawn dark and the boundary is what glows, rather than the other way round. That is a background
decision, not an aesthetic one: black-set-on-a-blaze-of-colour is a picture, and this has to be a page.

`glow` is **4 cells**, which is far wider than "enough to see the boundary" and is chosen for what happens *after* this
field is drawn. The output interpolates between field cells before dithering, so a rim one cell wide is averaged against
its neighbours and most of it is gone by the time it reaches the screen. At 1.2 the set came out as a flat silhouette
with no light on it at all. Past about 6, neighbouring filaments' mantles merge into a wash and the filigree stops
reading as filigree.

The exterior contours are faded out by how resolvable they are rather than by taste. They repeat every `bandWidth`
iterations and mu changes by `1 / (ln2 * d)` per cell, so they need `d` of at least `2 / (bandWidth * ln2)` cells to
survive sampling. Below that they are aliasing, and that is exactly where the glow is taking over anyway.

### The autopilot aims at a filament, not at a lake

A target picked in advance is empty space twenty doublings later - whatever was interesting at 1× is a featureless
interior or a featureless exterior by the time you get there. So the target is re-chosen from the frame on screen every
`aimInterval` seconds, and it can only ever be somewhere the current picture has something.

**What it picks matters as much as that it re-picks, and the obvious score is wrong.** So a candidate is scored by the
**patch around it** rather than by the cell itself, which is the right question: the autopilot is choosing what to
magnify, not where to stand. What wins is the most varied patch - filigree, and magnifying filigree gives filigree - but
only among patches that clear three refusals first.

Three, and not as belt and braces. A frame can be worthless in three different ways, and taking out any one of them
walks the autopilot straight into another. Each figure below is over five seeded runs of a full descent, sampled twice a
second:

| Refused          | What it is                                    | Cost of leaving it out           |
| ---------------- | --------------------------------------------- | -------------------------------- |
| more than 30% interior | the edge of a lake                      | **77-93% interior** for stretches of ten seconds |
| mean brightness over 0.65 | hair finer than the sampling         | **36%** of frames a flat grey wash |
| less than 10% interior | open exterior, the set out of shot      | **85%** of frames with nothing in them |

The first is the one everybody thinks of: the edge of a lake is a smooth analytic curve, so magnify it and you have a
straight line dividing dark from light, for ever.

The second is subtler. Brightness runs with nearness to the set, so a patch bright nearly everywhere is one where every
filament is thinner than a cell - the distance estimate quite correctly reports "within a cell of the set" for the whole
neighbourhood, and the frame comes out a flat mid-grey with stray dark cells where a filament happened to land on a
sample. **Those stray cells are the trap**: they sit at the far end of the range from everything around them, so the
patch holding one scores a *high* spread, so the autopilot aims at it - and arriving there is more of the same. It is a
feedback loop, and more depth did not clear it.

The third is what the first two leave. With no floor on the interior fraction the safest patch is always the one
furthest from the set, and the run ends up in open exterior: soft grey blobs, no filigree, nothing to recognise.

All three together: **2%** of frames in any of those states. There is also a counter, because one empty scan is a moment
and not a verdict - three in a row abandons the descent, one does not. Turning round on the first made a small canvas,
where the patch window is a large fraction of the frame and harder to satisfy, descend for four seconds at a time and
spend the rest of its life pulling out again.

### Why it turns round, and why the pull-out needed no animating

A double holds about 16 significant digits and the coordinates are of order 1, so the plane runs out at about 1e-16 - and
a view has to be far wider than that or neighbouring cells land on the same number. `minSpan` is 1.5e-7, about 24
doublings below home, which is well short of that limit and set by iterations rather than by precision: each doubling
costs budget on every cell of every frame.

Coming back out is a pure function of the span rather than an animation of its own:

```
centre(span) = deep + (home - deep) * (span - minSpan) / (homeSpan - minSpan)
```

It is exactly `deep` at the moment of the turn, so there is no jump, and exactly `home` when the span is home, so the
pull-out lands framed on the whole set without anything having to steer it there. In between, the screen offset of the
point it left is `(deep - centre) / span`, which is constant for all but the last instant - so the view magnifies about
that point and never appears to pan. A first-order ease towards home would have done the opposite: exponential in time
against a span that is also exponential in time, it reads as an enormous sideways slide while still deep.

### Nothing is switched, because a zoom is one coherent motion

The other six move diffusely - a fluid churns, rain falls in independent lanes - and the eye does not track any of it.
A zoom is a single motion of the whole frame, the eye locks onto it, and every discontinuity in it is visible. This
juddered, and it took four fixes.

The measurement is the frame-to-frame change in the picture's apparent motion, against the speed it is cruising at, over
a full cycle with a 24fps loop throttled onto a 60Hz refresh the way `driver.ts` actually does it:

| | mean | worst single frame |
| --- | --- | --- |
| as first written | 48% | 386% |
| all four fixed | **1.7%** | **45%** |

**The timestep was the fixed one**, and that is 48% of the 48%. A fixed step hands over `1 / fps` however long the frame
took, which the smoke needs - its advection is only stable over a bounded step, so a slow frame has to make the fluid
drift slower rather than further. Nothing here is like that: the span is `2^(rate * dt)` and the eases are `approach`,
both exact for any step. And a constant step is *actively wrong* when the frame rate does not divide the refresh rate.
At 24fps on 60Hz the driver draws every second or third refresh, so frames are on screen for 33ms and 50ms alternately
while the animation advances the same 41.7ms for each - equal steps of motion shown for unequal times. The same effect
measured 1.0% on a 144Hz display, where 24 does divide the refresh, which is what pinned the cause down.

**The rate was switched.** Reversing at the floor swapped half a doubling a second inwards for two outwards in a single
frame. It is eased now, and both turns are taken *early* by exactly the distance the deceleration coasts through -
`rate * turnEase` doublings, which is what a first-order ease covers - so the descent still asymptotes onto `minSpan`
and the pull-out onto `homeSpan` instead of overshooting.

**The aim jumped.** The autopilot picks a different cell every `aimInterval`, and a single lag chasing a target that
moves in steps has a continuous position and a discontinuous velocity: a corner at every re-aim. Those frames moved the
picture up to 2.4 times as far as their neighbours. A second lag in front of the first - `aimSmooth`, half the re-aim
interval - makes the position smooth in its first derivative too, so a re-aim is a curve.

**And one real bug, which only a deep zoom could show.** The pull-out's `frame` was measured from `minSpan`, but the
descent stops a little above it, at whatever the coast covered. The difference is nothing in complex units and is then
divided by a span of about 1e-7 to reach the screen: it put the view an eighth of a screen from where the descent left
it, in one frame, measuring as a ten-fold jump. Measuring from the span the descent actually stopped at makes it exact
at both ends - `deep` at the turn, `home` at the top.

### The cost, which is the real constraint

Cost is cells times iterations and it is the only effect here where both ends have to be capped. Measured on a 133×75
field with a budget rising from 90 iterations at home to 300 at the floor: **0.4 ms** a frame at the home view and
**4.3 ms** at the deepest, so 1% and 10% of one core at 24fps. Nearly all of the deep figure is interior cells, which are
the ones that spend the whole budget.

Two things that did **not** work, both worth knowing before trying them again:

- **Cycle detection.** An interior point's orbit falls onto an attracting cycle, so keeping a reference point and
  doubling the interval before replacing it should find it and cut the budget short. Measured on the larger field and
  budget in use at the time, it made deep frames **55% slower** - 6.0 ms to 9.4 ms - and classified not one cell
  differently, because the expensive cells at depth are not periodic. They are exterior points that need more iterations
  than the budget allows and get called interior when it runs out.
- **More depth.** The false-solid fraction - cells the budget calls interior that a 20,000-iteration reference says
  escape - sits at 5% to 20% at these budgets and is driven by how much boundary is in frame rather than by depth. It is
  visible as filigree that is slightly too thick, which is a graceful failure; `iterationsPerDoubling` is the dial for it
  and the per-cell cost is linear in it.

The two ceilings pull against each other and the trade is real: half the cells buys twice the iterations, which is a
thinner, truer boundary in a coarser picture. 10,000 cells is where both are still just about right.

## Tuning

**Run the demo.** `npm run dev` gives you every dial as a live slider with text on top, which is the only sane way to
tune any of this.

**`amplitude` is the readability dial.** Body text sits directly on this background. The defaults are deliberately at
the low end so the effect modulates the page rather than becoming a picture. Raise it for a bolder look, then re-read a
long paragraph before committing.

**`gamma` weights the field dark without changing the palette.** Both ends of the range are fixed points, so it shifts
the balance between the greys rather than the greys themselves.

Both defaults were solved **offline across several seeds, not measured in the browser**. A single page load rolls one
noise field, and an fbm field can be locally dark or light, so one load measures that seed rather than the effect - the
browser numbers came out non-monotonic in gamma before this was noticed.

- Plasma: with no bias 19.9% of the background sits in the lower half of the palette; `1.18` raises that to 30.1%.
- Smoke: at `1.0` the darkest grey covered 11%; `1.6` takes it to 23% while leaving 9% at the brightest, so the
  highlights that make it read as smoke survive. Further, if wanted: `2.0` gives 30%, `2.5` gives 38%.

The smoke settles at a mean density of ~0.36, which is where the reference (`geisswerks.com/smoke`) sits. It needs no
darkening the way the plasma does - smoke is already mostly clear air.

**The palette and grid were matched against a reference.** The defaults land on greys 18/24/30/36/42 in dark mode and
235-255 in light, on a 6px cell with a 4×4 Bayer repeat of 24px. That came from measuring <https://codapress.co.uk/>,
whose background runs 12/22/32 over black in runs of five to six pixels. `pixelSize: 3` looked right but measured half
their size.

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
console.log(meanAbsDivergence(fluid)); // near zero - the projection is working
```

`makeRandom(seed)` gives a small seeded xorshift generator, so passing it as `random` makes a background reproducible.

