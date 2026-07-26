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
  'The controls are live — <code>amplitude</code> is the readability dial, <code>levels</code> is how many ' +
  'colours the palette holds, and the palette picker swaps the greys for a colour ramp.';

export const COPY: Record<string, Copy> = {
  smoke: {
    heading: 'Smoke',
    paragraphs: [
      'An actual fluid simulation — semi-Lagrangian advection with a Jacobi pressure projection, the scheme from Jos ' +
        "Stam's <em>Stable Fluids</em>. The projection is the whole thing: without it the fluid compresses and you get " +
        'a texture being stretched rather than smoke.',
      'Every ten seconds or so a jet fires in from a random edge. About half are dark — a pale jet paints a plume, a ' +
        'dark one carves a clear channel — and the momentum is identical either way, because the distortion comes ' +
        'from the velocity rather than from what is being carried.',
      '<strong>Drag anywhere with a mouse button held down to stir it.</strong> Idle movement is ignored on purpose, ' +
        'so a reader moving the cursor off the text does not disturb the page.',
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
      '<strong>Click anywhere to send a ripple out from where it lands.</strong> It is a ring of radial displacement ' +
        'added to the finished warp coordinate, anchored in screen space — so it stays where you clicked while the ' +
        'field drifts underneath it, and it ages on a real-time clock rather than on animation time, so changing ' +
        '<code>speed</code> does not stretch it out.',
      'Otherwise stateless in time — the field is a pure function of the clock and the live ripples, so a frame can be ' +
        'drawn at any moment without having drawn the ones before it.',
      SHARED,
    ],
  },

  rain: {
    heading: 'Rain',
    paragraphs: [
      'One falling lane per column of the field. Each head lights the cells it passes through, and the whole field ' +
        'fades every frame — so the trail behind a drop is not drawn at all, it is simply what has not decayed yet.',
      'That turns out to matter. A fast drop leaves a <em>longer</em> streak than a slow one, because its brightness ' +
        'has had less time to fade over the same distance, and a drop that retires at the bottom leaves its trail to ' +
        'fade in place instead of taking it along.',
      '<strong>Click anywhere to send a distortion through it.</strong> It displaces what is already there rather ' +
        'than adding light of its own — an expanding ring that bends the streaks as it passes, like a droplet on ' +
        'glass acting as a lens. Bending the highest-contrast thing on screen reads far better than drawing a faint ' +
        'new shape among it.',
      'These are streaks of falling light, not glyphs. At a six-pixel dither cell a character would be about three ' +
        'cells tall and would read as noise — streaks survive the palette, letterforms do not.',
      SHARED,
    ],
  },

  ridges: {
    heading: 'Ridges',
    paragraphs: [
      'A landscape flown over as a stack of horizontal profiles, each one hiding the ones behind it. The look is the ' +
        "ridgeline plot made famous by the cover of Joy Division's <em>Unknown Pleasures</em> — Peter Saville's " +
        "design of a figure from Harold Craft's 1970 thesis plotting radio pulses from the pulsar CP 1919.",
      'Hidden lines are the effect. Without occlusion this is a tangle; with it you get depth, and the notch where a ' +
        'near crest bites into the rows above. It is done with a floating horizon — draw nearest to farthest, keep ' +
        'the highest point covered so far per column — which is one pass and no z-buffer.',
      '<strong>Click a line to set a wobble running through the stack.</strong> It is a wave packet — an envelope ' +
        'around a travelling front times an oscillation — so the struck profile ripples through a few crests rather ' +
        'than heaving once, and the disturbance spreads outward to its neighbours as it goes. It is keyed to the row ' +
        'it hit rather than to the point on screen, so it travels with the terrain instead of sitting still while ' +
        'rows pass through it.',
      'Rows are tied to whole numbers of travel rather than to screen positions, so a profile keeps its own shape, ' +
        'slides down as you pass it, and rolls off the bottom edge instead of vanishing at it.',
      SHARED,
    ],
  },

  fire: {
    heading: 'Fire',
    paragraphs: [
      'The classic cellular fire: the bottom row is re-fuelled every frame, then each cell takes the heat of the ' +
        'cell below it, minus a random amount, displaced sideways by a random amount. That is the entire algorithm.',
      'Not the fluid solver, deliberately. That would be more physical and far slower, and it would look like the ' +
        'smoke with a warm palette. Cellular fire flickers in hard tongues instead of overturning in plumes, because ' +
        'the noise is injected per cell per frame rather than emerging from a flow.',
      'This is the one effect the five-grey palette genuinely limits. Flame legibility wants a steep black-to-white ' +
        'ramp, so in greyscale it reads as embers at the foot of the page. <strong>Pick the fire ramp</strong> to see ' +
        'it as flame.',
      SHARED,
    ],
  },

  metaballs: {
    heading: 'Metaballs',
    paragraphs: [
      'An implicit surface. Several point sources each add a falloff to a shared scalar field, and the field is ' +
        'thresholded — so blobs bulge towards each other as they approach, fuse with a smooth neck, and part again ' +
        'without ever showing a seam.',
      'The merging is not a drawing trick. Nothing in the code knows about blobs or necks: two balls whose ' +
        'contributions each fall short of the threshold cross it together, and the neck is only what a sum does when ' +
        'two falloffs overlap.',
      'The falloff is a cubic with compact support rather than an exponential, which is exactly zero past its ' +
        'radius. That changes the algorithm rather than trimming it — each ball scatters over its own bounding box, ' +
        'so the cost is the sum of the ball areas instead of cells times balls.',
      SHARED,
    ],
  },
};
