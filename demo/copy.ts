// What the page says about whatever is currently behind it.
//
// Not part of the library. It lives in its own file because the demo previously
// described the smoke no matter which effect was running, which is worse than
// saying nothing: the page confidently told you to drag to stir a fluid while
// showing you a ridgeline landscape.

export interface Copy {
  heading: string;
  paragraphs: string[];
}

/** The line every effect shares, kept in one place so it cannot drift. */
const SHARED =
  'Everything here is CPU-side: a 2D context, typed arrays and putImageData. No WebGL and no shader. ' +
  'The controls are live - <code>amplitude</code> is the readability dial, <code>levels</code> is how many ' +
  'colours the palette holds, and the palette picker swaps the greys for a colour ramp.';

export const COPY: Record<string, Copy> = {
  smoke: {
    heading: 'Smoke',
    paragraphs: [
      'An actual fluid simulation - semi-Lagrangian advection with a Jacobi pressure projection, the scheme from Jos ' +
        "Stam's <em>Stable Fluids</em>. The projection is the whole thing: without it the fluid compresses and you get " +
        'a texture being stretched rather than smoke.',
      'Every ten seconds or so a jet fires in from a random edge. About half are dark - a pale jet paints a plume, a ' +
        'dark one carves a clear channel - and the momentum is identical either way, because the distortion comes ' +
        'from the velocity rather than from what is being carried.',
      '<strong>Drag anywhere with a mouse button held down to stir it.</strong> Idle movement is ignored on purpose, ' +
        'so a reader moving the cursor off the text does not disturb the page.',
      SHARED,
    ],
  },

  tunnel: {
    heading: 'Tunnel',
    paragraphs: [
      'The demoscene standby, and it is one division. Convert each pixel to polar coordinates about the vanishing ' +
        'point and read a wall texture at <code>(angle, depth / radius)</code>. That reciprocal <em>is</em> the ' +
        'perspective - a point on a cylinder wall lands at a radius inversely proportional to how far down it sits, ' +
        'so there is no camera, no matrix and no depth buffer anywhere in it.',
      'The corridor <strong>winds</strong>, and that is most of what makes it read as flight rather than as a cylinder ' +
        'being looked down: its axis wanders, so the near wall sweeps past while the far end holds still, and the view ' +
        'banks into the turn. It costs one extra pass of a fixed-point iteration - solve the straight tunnel, look up ' +
        'where the axis had got to at that depth, subtract, solve again.',
      'Adding to that coordinate walks you forward. Because the far wall is compressed into the middle, features do ' +
        'not slide outward at a constant rate - they stretch, moving further the further out they already are, which ' +
        'is the acceleration you feel. The middle is a genuine singularity, so the vignette takes it to nothing: the ' +
        'place the maths gives up is the place nothing is drawn.',
      'The wall is built from sinusoids at whole-number frequencies rather than sampled from noise, because it has to ' +
        'wrap seamlessly around the circumference or a seam runs the length of the tunnel. <code>repeats</code> is ' +
        'therefore a whole number too - and a rotation of a whole number of repeats is invisible.',
      '<strong>Press and drag to steer it</strong>, pulling the vanishing point towards the pointer; let go and it ' +
        'eases back to its own drift.',
      SHARED,
    ],
  },

  mandelbrot: {
    heading: 'Mandelbrot',
    paragraphs: [
      'A zoomer, and the interesting question is not the set - it is how you draw one in five greys at a hundred and ' +
        'twenty cells across. Escape-time colouring cannot: the bands crowd together without limit as you approach the ' +
        'boundary, so they alias into noise exactly where all the detail is.',
      'So the shading is a <strong>distance estimate</strong>, and here it comes for nothing. The smooth escape count ' +
        '<code>mu = n + 1 - log2(log|z|)</code> is not an approximate iteration number, it is the exterior potential on ' +
        'a log scale - exactly <code>1 - log2 G</code> - and the distance to the set is <code>G / |grad G|</code>. In ' +
        'terms of what is already on screen that is <code>1 / (ln2 * |grad mu|)</code>: a finite difference over a ' +
        'field that has just been computed. The picture is its own derivative.',
      'The interior goes through that same estimate rather than being drawn flat black, and that is what stops ' +
        'individual cells flickering. Forced to zero, an interior cell sat next to a boundary cell at full brightness - ' +
        'and a cell on the line between them changes classification whenever the view shifts by less than its own ' +
        'width, so it alternated between the two ends of the palette every frame. Lit by the same estimate as ' +
        'everything else it is black deep inside, where the neighbourhood is flat, and bright against the boundary, ' +
        'which is what its neighbour is too.',
      'It antialiases itself as a side effect. A filament thinner than a cell is never sampled, so the difference ' +
        'under-reads the gradient and reports a distance of about one cell instead of zero - and the filament arrives ' +
        'as a soft grey line rather than falling between two samples. Brightness is a function of distance measured in ' +
        '<em>cells</em>, so the picture cannot get busier or emptier however far down it goes.',
      'Where it goes is decided from the frame in front of it, every second or so, because a point chosen in advance ' +
        'is empty space twenty doublings later. Candidates are scored by the patch around them rather than by the cell ' +
        'itself - the autopilot is choosing what to <em>magnify</em>, not where to stand.',
      'A patch has to clear <strong>three</strong> refusals, and that is not belt and braces: a frame can be worthless ' +
        'in three ways and removing any one of them walks the autopilot into another. Too much interior is the edge of ' +
        'a lake, which magnifies into a straight line for ever. Too bright is hair finer than the sampling, where every ' +
        'cell is correctly within a cell of the set and the frame is a flat grey - and the few stray dark cells in it ' +
        'score a <em>high</em> spread, so it is a feedback loop. Too little interior is open exterior with the set out ' +
        'of shot, which is exactly where removing the first two sends it.',
      'It turns round at about 1e-11 because a double runs out - past that, neighbouring cells land on the same number, ' +
        'and the estimate has no sub-cell room left to work in. Depth costs nothing per frame, as ' +
        'it turns out: the iteration budget a frame needs is set by how much boundary is in shot rather than by how far ' +
        'down it is, so it is the same at forty-eight doublings as at twenty-four. Only precision binds. ' +
        'The pull-out is a function of the span rather than an animation, so it leaves exactly where it was and ' +
        'arrives framed on the whole set, with the point it left holding still on screen the whole way.',
      'The view is a <strong>mass, not a lag</strong>: a critically damped spring with velocity as state, worked in ' +
        'screen units so that the same momentum means the same thing at every magnification. And the point it chases ' +
        'no longer jumps - it is eased towards whatever the picker likes while walking along the boundary contour, ' +
        'which is what makes it explore. Contour-following on its own drifts into the soft exterior glow with the set ' +
        'out of shot; the pull keeps the picture, the walk keeps the motion.',
      'The descent is not one uninterrupted fall either. Every ten seconds or so it either eases the zoom off and ' +
        '<strong>traces sideways</strong> at one magnification, or gives up a couple of doublings for a wider look ' +
        'before carrying on down. The same two moves are how it recovers when a frame stops being worth looking at, ' +
        'and which one it uses depends on why: a washed-out frame is under-resolved, so it backs out; a frame with ' +
        'nothing lit in it is the opposite, so it stops and walks instead.',
      'Nothing in the camera is <em>switched</em>, and that is not fussiness. The other six move diffusely and the eye ' +
        'does not track any of it; a zoom is one motion of the whole frame, so every discontinuity in it shows. The ' +
        'rate eases rather than reversing, each turn is taken early by exactly what the deceleration will coast ' +
        'through, and the aim is smoothed by a second lag so that re-aiming is a curve rather than a corner. The ' +
        'timestep is the clock, not a fixed step - at 24fps on a 60Hz screen a fixed step means equal movement shown ' +
        'for alternating 33ms and 50ms, which is judder you can see.',
      '<strong>Press and drag to aim it.</strong> The pointer chooses roughly and the autopilot chooses exactly, so ' +
        'parking it over the middle of a lake steers to the nearest filigree instead of into the dark.',
      SHARED,
    ],
  },

  plasma: {
    heading: 'Plasma',
    paragraphs: [
      'A domain warp: fractal Brownian motion folded into itself, <code>fbm(p + fbm(p + fbm(p)))</code>, used to ' +
        'decide where a seamless plasma tile gets read from. Folding it twice is what turns cloudy noise into ' +
        'something with filaments in it.',
      'Time enters twice and needs to. One term slides the whole domain, which alone would look like a photograph ' +
        'being panned; the other moves the inner fields against each other, which is what makes it evolve in place.',
      '<strong>Click or drag to send ripples out from the pointer.</strong> It is a ring of radial displacement ' +
        'added to the finished warp coordinate, anchored in screen space - so it stays where you clicked while the ' +
        'field drifts underneath it, and it ages on a real-time clock rather than on animation time, so changing ' +
        '<code>speed</code> does not stretch it out.',
      'Otherwise stateless in time - the field is a pure function of the clock and the live ripples, so a frame can be ' +
        'drawn at any moment without having drawn the ones before it.',
      SHARED,
    ],
  },

  rain: {
    heading: 'Rain',
    paragraphs: [
      'One falling lane per column of the field. Each head lights the cells it passes through, and the whole field ' +
        'fades every frame - so the trail behind a drop is not drawn at all, it is simply what has not decayed yet.',
      'That turns out to matter. A fast drop leaves a <em>longer</em> streak than a slow one, because its brightness ' +
        'has had less time to fade over the same distance, and a drop that retires at the bottom leaves its trail to ' +
        'fade in place instead of taking it along.',
      '<strong>Click or drag to send distortions through it.</strong> It displaces what is already there rather ' +
        'than adding light of its own - an expanding ring that bends the streaks as it passes, like a droplet on ' +
        'glass acting as a lens. Bending the highest-contrast thing on screen reads far better than drawing a faint ' +
        'new shape among it.',
      'These are streaks of falling light, not glyphs. At a six-pixel dither cell a character would be about three ' +
        'cells tall and would read as noise - streaks survive the palette, letterforms do not.',
      SHARED,
    ],
  },

  ridges: {
    heading: 'Ridges',
    paragraphs: [
      'A landscape flown over as a stack of horizontal profiles, each one hiding the ones behind it. The look is the ' +
        "ridgeline plot made famous by the cover of Joy Division's <em>Unknown Pleasures</em> - Peter Saville's " +
        "design of a figure from Harold Craft's 1970 thesis plotting radio pulses from the pulsar CP 1919.",
      'Hidden lines are the effect. Without occlusion this is a tangle; with it you get depth, and the notch where a ' +
        'near crest bites into the rows above. It is done with a floating horizon - draw nearest to farthest, keep ' +
        'the highest point covered so far per column - which is one pass and no z-buffer.',
      '<strong>Click or drag across the lines to set wobbles running through the stack.</strong> It is a wave packet - an envelope ' +
        'around a travelling front times an oscillation - so the struck profile ripples through a few crests rather ' +
        'than heaving once, and the disturbance spreads outward to its neighbours as it goes. It is keyed to the row ' +
        'it hit rather than to the point on screen, so it travels with the terrain instead of sitting still while ' +
        'rows pass through it.',
      'Rows are tied to whole numbers of travel rather than to screen positions, so a profile keeps its own shape, ' +
        'slides down as you pass it, and rolls off the bottom edge instead of vanishing at it.',
      SHARED,
    ],
  },

  metaballs: {
    heading: 'Metaballs',
    paragraphs: [
      'An implicit surface. Several point sources each add a falloff to a shared scalar field, and the field is ' +
        'thresholded - so blobs bulge towards each other as they approach, fuse with a smooth neck, and part again ' +
        'without ever showing a seam.',
      'The merging is not a drawing trick. Nothing in the code knows about blobs or necks: two balls whose ' +
        'contributions each fall short of the threshold cross it together, and the neck is only what a sum does when ' +
        'two falloffs overlap.',
      '<strong>Press and drag to pick a blob up and carry it about.</strong> A dragged ball is just another ' +
        'contribution to the sum, so it reaches for its neighbours exactly as the others do - run it into one and they ' +
        'fuse, pull away and the neck stretches and parts. Let go and it eases back onto its own path, which has to be ' +
        'a blend rather than a handover: its natural position never stopped moving while you held it. Flick it and it ' +
        "carries on in the direction you threw it before curving back, because the drag's velocity goes with it.",
      'The falloff is a cubic with compact support rather than an exponential, which is exactly zero past its ' +
        'radius. That changes the algorithm rather than trimming it - each ball scatters over its own bounding box, ' +
        'so the cost is the sum of the ball areas instead of cells times balls.',
      SHARED,
    ],
  },
};
