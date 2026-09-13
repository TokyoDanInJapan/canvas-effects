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
  'Everything runs on the CPU, with a 2D context, typed arrays and putImageData. There is no WebGL and no shader. ' +
  'The controls change the effect as you move them. <code>amplitude</code> controls readability, ' +
  '<code>levels</code> sets how many colours the palette has, and the palette picker replaces the greys with ' +
  'a colour ramp.';

export const COPY: Record<string, Copy> = {
  smoke: {
    heading: 'Smoke',
    paragraphs: [
      'This is a real fluid simulation. It uses semi-Lagrangian advection with a Jacobi pressure projection, from ' +
        "Jos Stam's <em>Stable Fluids</em>. The projection is the most important step. Without it, the fluid " +
        'compresses and looks like a stretched texture.',
      'About every ten seconds, a jet fires in from a random edge. About half the jets are dark. A light jet paints ' +
        'a plume, and a dark jet cuts a clear channel. Both have the same momentum, because the velocity causes the ' +
        'disturbance, not the smoke that the jet carries.',
      '<strong>Drag with a mouse button pressed to stir it.</strong> Movement without a press does nothing, so a ' +
        'reader who moves the pointer away from the text does not disturb the page.',
      SHARED,
    ],
  },

  tunnel: {
    heading: 'Tunnel',
    paragraphs: [
      'This is the classic demoscene tunnel, and it needs one division. Each pixel becomes polar coordinates about ' +
        'the vanishing point, and the effect reads a wall texture at <code>(angle, depth / radius)</code>. That ' +
        'division gives the perspective. A point on the wall of a cylinder appears at a radius in inverse proportion ' +
        'to its distance, so there is no camera, matrix or depth buffer.',
      'The corridor <strong>bends</strong>, and this makes it look like flight. Its axis moves, so the near wall ' +
        'sweeps past while the far end stays still, and the view banks into each turn. The bend costs one more pass ' +
        'of a fixed-point iteration. The effect solves for a straight tunnel, looks up the axis at that depth, ' +
        'subtracts it and solves again.',
      'An increase in the depth coordinate moves you forwards. The far wall is compressed into the centre, so ' +
        'features do not move outwards at a constant rate. They stretch, and the farther out a feature is, the ' +
        'faster it moves. This gives the feeling of speed. The maths fails at the exact centre, so the vignette ' +
        'hides the centre.',
      'The wall is made of sinusoids with whole-number frequencies, not noise, because it must wrap round the ' +
        'circumference without a seam. For this reason, <code>repeats</code> is also a whole number, and a rotation ' +
        'by a whole number of repeats is invisible.',
      '<strong>Press and drag to steer it.</strong> The vanishing point moves towards the pointer. When you ' +
        'release, it moves back to its own drift.',
      SHARED,
    ],
  },

  mandelbrot: {
    heading: 'Mandelbrot',
    paragraphs: [
      'This zooms into the Mandelbrot set. The problem is to draw it in five greys at 120 cells across. ' +
        'Escape-time colouring fails at that size, because the bands crowd together at the boundary and turn into ' +
        'noise where the detail is.',
      'The shading uses a <strong>distance estimate</strong> instead, and it costs almost nothing. The smooth ' +
        'escape count <code>mu = n + 1 - log2(log|z|)</code> is exactly the exterior potential on a log scale, ' +
        '<code>1 - log2 G</code>. The distance to the set is <code>G / |grad G|</code>, which in terms of ' +
        '<code>mu</code> is <code>1 / (ln2 * |grad mu|)</code>. That is a finite difference over the field that ' +
        'the effect has already computed.',
      'The interior uses the same estimate and is not drawn flat black. This stops cells from flickering. When ' +
        'interior cells were zero, they sat next to boundary cells at full brightness. A cell on the line changed ' +
        'class each time the view moved by less than one cell, so it flickered between black and white. With the ' +
        'same estimate, a cell is black deep inside the set and bright next to the boundary, like its neighbour.',
      'The estimate also antialiases the picture. The grid does not sample a thread thinner than a cell, so the ' +
        'difference gives a distance of about one cell, not zero. The thread shows as a soft grey line and does ' +
        'not disappear. Brightness depends on distance in <em>cells</em>, so the picture has the same amount of ' +
        'detail at every depth.',
      'About every second, the autopilot chooses a new target from the current frame, because a point chosen at ' +
        'the start is empty space 20 doublings later. It scores each candidate by the area around it, not by the ' +
        'cell, because it is choosing what to <em>magnify</em>.',
      'The autopilot rejects <strong>three</strong> kinds of area, and all three rules are necessary. Without any ' +
        'one of them, it fails in a different way. An area with too much interior is the edge of a lake, which ' +
        'becomes a straight line when magnified. An area that is too bright has threads finer than the grid. The ' +
        'frame is a flat grey, and its few dark cells get a <em>high</em> score, so the autopilot goes deeper into ' +
        'the same problem. An area with too little interior has no set in it, and the first two rules alone lead ' +
        'there.',
      'It turns round at about 1e-11, because double precision runs out. Past that, neighbouring cells get the ' +
        'same number, and the estimate has no room inside a cell. Depth does not cost more per frame. The number ' +
        'of iterations depends on how much boundary is on the screen, so it is the same at 48 doublings as at 24. ' +
        'The way back out is a function of the span, not an animation. It ends on the whole set, and the point ' +
        'where it turned stays still on the screen all the way.',
      'The camera <strong>has mass</strong>. It is a critically damped spring with velocity as state, in screen ' +
        'units, so its momentum behaves the same at every magnification. Its target moves smoothly. The target ' +
        "eases towards the autopilot's choice and also moves along the boundary, which makes the zoom explore. " +
        'Movement along the boundary alone drifts into the glow and loses the set. The easing keeps the picture ' +
        'good, and the movement keeps it interesting.',
      'The descent has pauses. About every ten seconds it either stops the zoom and <strong>moves ' +
        'sideways</strong> at one magnification, or backs out a few doublings for a wider view. The same two moves ' +
        'also recover from a bad frame. A washed-out frame has too much detail for the grid, so the zoom backs ' +
        'out. A frame with nothing lit has too little, so the zoom stops and moves sideways.',
      'Nothing in the camera changes suddenly. The other seven effects move in many directions at once, so the ' +
        'eye follows no single motion. A zoom is one motion of the whole frame, so every jump shows. The zoom rate ' +
        'is damped, so it speeds up and slows down smoothly. Each turn starts early by the distance that the zoom ' +
        'coasts. A second lag smooths the aim, so a new aim gives a curve and not a corner. The timestep follows ' +
        'the clock. At 24 fps on a 60 Hz screen, a fixed step shows equal movement for 33 ms and 50 ms in turn, ' +
        'which looks like judder.',
      '<strong>Press and drag to aim it.</strong> The pointer chooses the rough area and the autopilot chooses the ' +
        'exact point. If you aim at the middle of a lake, the zoom goes to the nearest detail and not into the ' +
        'dark.',
      SHARED,
    ],
  },

  plasma: {
    heading: 'Plasma',
    paragraphs: [
      'This is a domain warp. Fractal Brownian motion is folded into itself as ' +
        '<code>fbm(p + fbm(p + fbm(p)))</code>, and the result chooses where to read a seamless plasma tile. The ' +
        'second fold turns cloudy noise into threads.',
      'Time is used in two places. One term moves the whole domain, which alone looks like a moving photograph. ' +
        'The other term moves the inner fields against each other, so the pattern changes in place.',
      '<strong>Click or drag to send ripples out from the pointer.</strong> A ripple is a ring of radial ' +
        'displacement, fixed in screen space, so it stays where you clicked while the field drifts. Its age uses ' +
        'real time, not animation time, so a change to <code>speed</code> does not make it last longer.',
      'Apart from the ripples, the field has no state. It is a function of the clock, so any frame can be drawn ' +
        'without the frames before it.',
      SHARED,
    ],
  },

  rain: {
    heading: 'Rain',
    paragraphs: [
      'There is one falling lane per column of the field. Each head lights the cells it passes, and the whole ' +
        'field fades every frame. Nothing draws the trail behind a drop. The trail is the part that has not faded ' +
        'yet.',
      'This has two good results. A fast drop leaves a <em>longer</em> streak than a slow one, because its ' +
        'brightness has less time to fade over the same distance. A drop that stops at the bottom leaves its trail ' +
        'to fade where it is.',
      '<strong>Click or drag to send distortions through it.</strong> A distortion moves the existing picture and ' +
        'adds no light. It is a growing ring that bends the streaks as it passes, like a lens. The streaks have the ' +
        'most contrast on the screen, so bending them shows much more than a faint new shape would.',
      'The rain is streaks of light, with no characters. At a six-pixel dither cell, a character is about three ' +
        'cells tall and looks like noise. Streaks survive the small palette, but letters do not.',
      SHARED,
    ],
  },

  ridges: {
    heading: 'Ridges',
    paragraphs: [
      'This flies over a landscape drawn as a stack of horizontal profiles. Each profile hides the ones behind it. ' +
        "The look comes from the cover of Joy Division's <em>Unknown Pleasures</em>, Peter Saville's design of a " +
        "figure from Harold Craft's 1970 thesis. The figure plots radio pulses from the pulsar CP 1919.",
      'The hidden lines make the effect. Without them, the lines are a tangle. With them, you see depth, and each ' +
        'near crest cuts into the rows above. A floating horizon hides the lines. The effect draws from nearest to ' +
        'farthest and keeps the highest covered point in each column. This takes one pass, with no z-buffer.',
      '<strong>Click or drag across the lines to send wobbles through the stack.</strong> A wobble is a wave ' +
        'packet, which is an envelope multiplied by an oscillation. The line ripples through a few crests, and the ' +
        'wobble spreads to the rows next to it. The wobble belongs to the row, not the screen point, so it moves ' +
        'with the terrain.',
      'Each row belongs to a whole number of travel, not to a screen position. As a result, a profile keeps its ' +
        'shape, moves down as you pass it and goes off the bottom edge before it is removed.',
      SHARED,
    ],
  },

  metaballs: {
    heading: 'Metaballs',
    paragraphs: [
      'This is an implicit surface. Each point source adds a falloff to a shared field, and a threshold turns the ' +
        'field into a surface. Blobs bulge towards each other, join with a smooth neck and separate cleanly.',
      'No code draws the joins. Two balls that are each below the threshold can be above it together. The neck ' +
        'is the sum of two overlapping falloffs.',
      '<strong>Press and drag to pick up a blob and carry it.</strong> A held ball is one more term in the sum, ' +
        'so it joins other balls in the same way. Move it into another ball and they join. Pull it away and the ' +
        'neck stretches and breaks. When you release it, it moves smoothly back to its own path, because that path ' +
        'continued to move while you held the ball. If you flick it, it keeps moving in that direction before it ' +
        'curves back.',
      'The falloff is a cubic that is exactly zero past its radius. As a result, each ball writes only to its own ' +
        'bounding box, and the cost is the sum of the ball areas, not cells multiplied by balls.',
      SHARED,
    ],
  },

  beer: {
    heading: 'Beer',
    paragraphs: [
      'This is a glass of fizzing beer. Bubbles rise from fixed nucleation sites, like the scratches in a real ' +
        'glass. They grow as the pressure drops and burst at the surface. The bubbles are metaballs, with the same ' +
        'falloff as the blobs, so two that pass close together join. No code draws the join.',
      '<strong>No code draws the head.</strong> Each burst adds its area to the foam. The foam drains and spreads ' +
        'sideways, and the head is as thick as those two rates allow. With a lower <code>rate</code>, the head gets ' +
        'thinner. With a lower <code>drain</code>, it grows until it reaches its limit. A breaking wave also adds ' +
        'foam, so a hard stir makes the head thicker.',
      '<strong>Drag to stir it. Click to splash it.</strong> The bubbles near the pointer move towards its speed, ' +
        'but never faster. The drag creates new bubbles as it passes. The sideways movement also pushes the beer, ' +
        'so the beer piles up against the wall ahead, throws spray and swings back. A hard drag can push it to the ' +
        'top of the frame. A click makes a splash, throws droplets and starts new bubbles.',
      'The surface is shallow water, with a height for each column and a flow between columns. No code animates ' +
        'the slosh. Gravity and the depth of the beer set its period, as in a real glass, so a half-full glass ' +
        'sloshes more slowly. Bursting bubbles push the same flow, and this is the only motion at rest. Without ' +
        'fizz, the glass is completely still. To watch the glass fill, set <code>pour</code> to 1 and remount. The ' +
        'palette picker colours the beer as it colours every effect. Try amber terminal.',
      SHARED,
    ],
  },
};
