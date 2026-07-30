// The demo page. Not part of the library - it exists so the dials can be
// turned while looking at the result, which is the only sane way to tune any
// of this.

import {
  MANDELBROT_BACKGROUND_DEFAULTS,
  MANDELBROT_DEFAULTS,
  PLASMA_BACKGROUND_DEFAULTS,
  METABALLS_BACKGROUND_DEFAULTS,
  METABALL_DEFAULTS,
  RAIN_BACKGROUND_DEFAULTS,
  RAIN_DEFAULTS,
  RIDGE_DEFAULTS,
  RIDGES_BACKGROUND_DEFAULTS,
  SMOKE_BACKGROUND_DEFAULTS,
  TUNNEL_BACKGROUND_DEFAULTS,
  TUNNEL_DEFAULTS,
  createPlasmaBackground,
  createMandelbrotBackground,
  createMetaballsBackground,
  createRainBackground,
  createRidgesBackground,
  createSmokeBackground,
  createTunnelBackground,
  type BackgroundHandle,
  type Shading,
} from '../src/index.js';
import { COPY } from './copy.js';

const canvas = document.getElementById('background') as HTMLCanvasElement;

// Frames actually drawn, which is the number worth watching - every effect
// deliberately draws well below the refresh rate.
//
// Counted by wrapping `putImageData`, which is crude but is the only paint
// any of them makes. Done here, before anything mounts, and with the same
// `{ alpha: false }` the library asks for: a canvas hands back the context it
// was first given, so fetching it without that flag would quietly downgrade
// every later caller to a transparent canvas.
let frames = 0;
let since = performance.now();

const metered = canvas.getContext('2d', { alpha: false });
if (metered) {
  const original = metered.putImageData.bind(metered);
  metered.putImageData = ((...args: Parameters<typeof original>) => {
    frames++;
    return original(...args);
  }) as typeof metered.putImageData;
}

function meter() {
  requestAnimationFrame(meter);
  const now = performance.now();
  if (now - since < 1000) return;
  fpsOut.textContent = String(Math.round((frames * 1000) / (now - since)));
  frames = 0;
  since = now;
}

const dials = document.getElementById('dials') as HTMLDivElement;
const panel = document.getElementById('panel') as HTMLElement;
const themeButton = document.getElementById('theme') as HTMLButtonElement;
const fpsOut = document.getElementById('fps') as HTMLSpanElement;
const heading = document.getElementById('heading') as HTMLHeadingElement;
const copyOut = document.getElementById('copy') as HTMLDivElement;
const rampPick = document.getElementById('ramp') as HTMLSelectElement;
const rampName = document.getElementById('ramp-name') as HTMLElement;
const ditherButton = document.getElementById('dither') as HTMLButtonElement;
const textButton = document.getElementById('text') as HTMLButtonElement;
const prose = document.querySelector('main') as HTMLElement;

type Effect = 'smoke' | 'plasma' | 'rain' | 'ridges' | 'metaballs' | 'tunnel' | 'mandelbrot';

type Stops = ReadonlyArray<readonly [number, number, number]>;

/**
 * Colour ramps. The first stop is substituted with the page colour at use time -
 * the canvas is opaque, so the darkest level has to match what is behind it or
 * the canvas edge shows a seam.
 */
const RAMPS: Array<{ id: string; name: string; dark: Stops | null; light: Stops | null }> = [
  { id: 'grey', name: 'greyscale', dark: null, light: null },
  {
    id: 'fire',
    name: 'fire',
    dark: [
      [18, 18, 18],
      [92, 16, 4],
      [190, 66, 8],
      [244, 158, 30],
      [255, 240, 200],
    ],
    light: [
      [255, 255, 255],
      [250, 214, 150],
      [235, 140, 40],
      [170, 52, 10],
      [70, 16, 4],
    ],
  },
  {
    id: 'matrix',
    name: 'matrix green',
    dark: [
      [18, 18, 18],
      [10, 54, 22],
      [22, 122, 46],
      [60, 200, 88],
      [190, 255, 200],
    ],
    light: [
      [255, 255, 255],
      [186, 232, 196],
      [70, 168, 96],
      [22, 96, 44],
      [8, 40, 18],
    ],
  },
  {
    id: 'ice',
    name: 'ice',
    dark: [
      [18, 18, 18],
      [20, 46, 82],
      [40, 110, 168],
      [110, 190, 232],
      [225, 246, 255],
    ],
    light: [
      [255, 255, 255],
      [198, 226, 246],
      [96, 158, 208],
      [34, 84, 140],
      [12, 34, 62],
    ],
  },
  {
    id: 'amber',
    name: 'amber terminal',
    dark: [
      [18, 18, 18],
      [64, 38, 4],
      [140, 88, 8],
      [214, 150, 24],
      [255, 224, 150],
    ],
    light: [
      [255, 255, 255],
      [248, 222, 168],
      [206, 152, 32],
      [130, 84, 10],
      [54, 34, 4],
    ],
  },
  {
    id: 'violet',
    name: 'violet',
    dark: [
      [18, 18, 18],
      [46, 22, 74],
      [104, 48, 152],
      [172, 118, 214],
      [238, 220, 252],
    ],
    light: [
      [255, 255, 255],
      [224, 206, 244],
      [150, 100, 200],
      [86, 42, 132],
      [34, 16, 56],
    ],
  },
];

let rampId = 'grey';
let dithering = true;

interface Dial {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  note?: string;
}

/**
 * The greys. `base` has to match the page colour behind the canvas - the canvas
 * is opaque, so it paints the page colour itself rather than letting CSS show
 * through.
 */
function shading(): Shading {
  const dark = document.documentElement.classList.contains('dark');
  // `tint` scales the amplitude per channel. At 0 the green dial is off and
  // all three match, which is the greyscale the other effects use.
  const chosen = RAMPS.find((r) => r.id === rampId);
  const stops = dark ? chosen?.dark : chosen?.light;

  // The two ends of the spectrum, straight off their dials. `[0, 1]` is the
  // whole throw, and what the library does with no `range` at all.
  const range = [values.rangeLo ?? 0, values.rangeHi ?? 1] as [number, number];

  if (stops) {
    // `amplitude` still has to mean something with a ramp on, or the readability
    // dial would go dead. It scales each stop back towards the page colour.
    const page = stops[0];
    const strength = Math.min(1, values.amplitude / 60);
    const ramp = stops.map(
      (stop) =>
        [
          page[0] + (stop[0] - page[0]) * strength,
          page[1] + (stop[1] - page[1]) * strength,
          page[2] + (stop[2] - page[2]) * strength,
        ] as [number, number, number]
    );
    return { base: page[0], amplitude: 0, ramp, range };
  }

  return dark
    ? { base: 18, amplitude: values.amplitude, range }
    : { base: 255, amplitude: -Math.round(values.amplitude * 0.85), range };
}

const SMOKE_DIALS: Dial[] = [
  { key: 'amplitude', label: 'amplitude', min: 0, max: 255, step: 1, value: 26, note: 'the readability dial' },
  { key: 'gamma', label: 'gamma', min: 0.6, max: 3, step: 0.05, value: SMOKE_BACKGROUND_DEFAULTS.gamma },
  {
    key: 'levels',
    label: 'levels',
    min: 2,
    max: 12,
    step: 1,
    value: SMOKE_BACKGROUND_DEFAULTS.levels,
    note: 'colours in the palette',
  },
  { key: 'pixelSize', label: 'pixelSize', min: 2, max: 16, step: 1, value: SMOKE_BACKGROUND_DEFAULTS.pixelSize },
  { key: 'fps', label: 'fps', min: 6, max: 60, step: 1, value: SMOKE_BACKGROUND_DEFAULTS.fps },
  { key: 'drag', label: 'drag', min: 0.1, max: 3, step: 0.05, value: 0.9, note: 'sets how fast it mixes to fog' },
  { key: 'buoyancy', label: 'buoyancy', min: 0, max: 40, step: 1, value: 14 },
  { key: 'vorticity', label: 'vorticity', min: 0, max: 60, step: 1, value: 26, note: 'the wisps and curls' },
  { key: 'replenish', label: 'replenish', min: 0, max: 3, step: 0.05, value: 0.9 },
  { key: 'iterations', label: 'iterations', min: 1, max: 60, step: 1, value: 24, note: 'Jacobi pressure solve' },
  { key: 'jetInterval', label: 'jetInterval', min: 1, max: 30, step: 1, value: 12 },
  { key: 'jetSpeed', label: 'jetSpeed', min: 10, max: 200, step: 2, value: 92 },
  { key: 'jetDarkChance', label: 'jetDarkChance', min: 0, max: 1, step: 0.05, value: 0.45 },
];

const PLASMA_DIALS: Dial[] = [
  { key: 'amplitude', label: 'amplitude', min: 0, max: 255, step: 1, value: 24, note: 'the readability dial' },
  { key: 'gamma', label: 'gamma', min: 0.6, max: 3, step: 0.05, value: PLASMA_BACKGROUND_DEFAULTS.gamma },
  {
    key: 'levels',
    label: 'levels',
    min: 2,
    max: 12,
    step: 1,
    value: PLASMA_BACKGROUND_DEFAULTS.levels,
    note: 'colours in the palette',
  },
  { key: 'pixelSize', label: 'pixelSize', min: 2, max: 16, step: 1, value: PLASMA_BACKGROUND_DEFAULTS.pixelSize },
  { key: 'fps', label: 'fps', min: 6, max: 60, step: 1, value: PLASMA_BACKGROUND_DEFAULTS.fps },
  { key: 'speed', label: 'speed', min: 0.05, max: 3, step: 0.05, value: PLASMA_BACKGROUND_DEFAULTS.speed },
  { key: 'blend', label: 'blend', min: 0, max: 0.95, step: 0.01, value: PLASMA_BACKGROUND_DEFAULTS.blend },
  { key: 'frequency', label: 'frequency', min: 0.3, max: 5, step: 0.05, value: 1.45 },
  { key: 'warp1', label: 'warp1', min: 0, max: 5, step: 0.05, value: 1.9 },
  { key: 'warp2', label: 'warp2', min: 0, max: 3, step: 0.05, value: 0.85, note: 'the marbling' },
  { key: 'spread', label: 'spread', min: 0, max: 2, step: 0.02, value: 0.34 },
  { key: 'octaves', label: 'octaves', min: 1, max: 6, step: 1, value: 3 },
  {
    key: 'rippleStrength',
    label: 'rippleStrength',
    min: 0,
    max: 0.3,
    step: 0.01,
    value: 0.09,
    note: 'click to ripple',
  },
  { key: 'rippleSpeed', label: 'rippleSpeed', min: 0.1, max: 2, step: 0.05, value: 0.7 },
  { key: 'rippleLifetime', label: 'rippleLifetime', min: 0.3, max: 5, step: 0.1, value: 1.6 },
];

const RAIN_DIALS: Dial[] = [
  { key: 'amplitude', label: 'amplitude', min: 0, max: 255, step: 1, value: 52, note: 'the readability dial' },
  {
    key: 'levels',
    label: 'levels',
    min: 2,
    max: 12,
    step: 1,
    value: RAIN_BACKGROUND_DEFAULTS.levels,
    note: 'colours in the palette',
  },
  { key: 'pixelSize', label: 'pixelSize', min: 2, max: 16, step: 1, value: RAIN_BACKGROUND_DEFAULTS.pixelSize },
  {
    key: 'fieldScale',
    label: 'fieldScale',
    min: 1,
    max: 6,
    step: 1,
    value: RAIN_BACKGROUND_DEFAULTS.fieldScale,
    note: '1 keeps streaks crisp',
  },
  { key: 'fps', label: 'fps', min: 6, max: 60, step: 1, value: RAIN_BACKGROUND_DEFAULTS.fps },
  { key: 'gamma', label: 'gamma', min: 0.5, max: 3, step: 0.05, value: RAIN_BACKGROUND_DEFAULTS.gamma },
  { key: 'speed', label: 'speed', min: 4, max: 120, step: 1, value: RAIN_DEFAULTS.speed },
  { key: 'fade', label: 'fade', min: 0.2, max: 8, step: 0.1, value: RAIN_DEFAULTS.fade, note: 'sets trail length' },
  {
    key: 'respawn',
    label: 'respawn',
    min: 0.3,
    max: 12,
    step: 0.1,
    value: RAIN_DEFAULTS.respawn,
    note: 'the density dial',
  },
  { key: 'speedVariance', label: 'speedVariance', min: 0, max: 0.9, step: 0.05, value: RAIN_DEFAULTS.speedVariance },
  { key: 'flicker', label: 'flicker', min: 0, max: 0.8, step: 0.02, value: RAIN_DEFAULTS.flicker },
  { key: 'boldChance', label: 'boldChance', min: 0, max: 0.6, step: 0.02, value: RAIN_DEFAULTS.boldChance },
  { key: 'distortStrength', label: 'distortStrength', min: 0, max: 20, step: 1, value: 6, note: 'click to distort' },
  { key: 'distortSpeed', label: 'distortSpeed', min: 10, max: 250, step: 5, value: 90 },
  { key: 'distortWidth', label: 'distortWidth', min: 1, max: 25, step: 1, value: 7 },
  { key: 'minBrightness', label: 'minBrightness', min: 0.1, max: 1, step: 0.05, value: RAIN_DEFAULTS.minBrightness },
];

const RIDGE_DIALS: Dial[] = [
  { key: 'amplitude', label: 'amplitude', min: 0, max: 255, step: 1, value: 46, note: 'the readability dial' },
  {
    key: 'levels',
    label: 'levels',
    min: 2,
    max: 12,
    step: 1,
    value: RIDGES_BACKGROUND_DEFAULTS.levels,
    note: 'colours in the palette',
  },
  { key: 'pixelSize', label: 'pixelSize', min: 2, max: 12, step: 1, value: RIDGES_BACKGROUND_DEFAULTS.pixelSize },
  { key: 'fps', label: 'fps', min: 6, max: 60, step: 1, value: RIDGES_BACKGROUND_DEFAULTS.fps },
  { key: 'gamma', label: 'gamma', min: 0.5, max: 3, step: 0.05, value: RIDGES_BACKGROUND_DEFAULTS.gamma },
  { key: 'rows', label: 'rows', min: 8, max: 90, step: 1, value: RIDGE_DEFAULTS.rows },
  { key: 'speed', label: 'speed', min: 0.1, max: 8, step: 0.1, value: RIDGE_DEFAULTS.speed, note: 'rows per second' },
  { key: 'ridgeAmp', label: 'peak height', min: 0.02, max: 0.7, step: 0.01, value: RIDGE_DEFAULTS.amplitude },
  {
    key: 'focus',
    label: 'focus',
    min: 0.06,
    max: 2,
    step: 0.02,
    value: RIDGE_DEFAULTS.focus,
    note: 'central band width',
  },
  { key: 'sharpness', label: 'sharpness', min: 0.6, max: 6, step: 0.1, value: RIDGE_DEFAULTS.sharpness },
  { key: 'xScale', label: 'xScale', min: 0.5, max: 10, step: 0.1, value: RIDGE_DEFAULTS.xScale },
  {
    key: 'zScale',
    label: 'zScale',
    min: 0.05,
    max: 1.5,
    step: 0.01,
    value: RIDGE_DEFAULTS.zScale,
    note: 'row to row change',
  },
  {
    key: 'perspective',
    label: 'perspective',
    min: 1,
    max: 3.5,
    step: 0.05,
    value: RIDGE_DEFAULTS.perspective,
    note: '1 = flat stack',
  },
  { key: 'ampFalloff', label: 'ampFalloff', min: 0, max: 4, step: 0.1, value: RIDGE_DEFAULTS.ampFalloff },
  {
    key: 'depthFade',
    label: 'depthFade',
    min: 0.05,
    max: 1,
    step: 0.05,
    value: RIDGE_DEFAULTS.depthFade,
    note: 'distance haze',
  },
  { key: 'fill', label: 'fill', min: 0, max: 1, step: 1, value: 0, note: 'solid silhouettes, not lines' },
  {
    key: 'fillLevel',
    label: 'fillLevel',
    min: 0.05,
    max: 1,
    step: 0.05,
    value: RIDGE_DEFAULTS.fillLevel,
    note: 'ceiling on fill brightness',
  },
  { key: 'fillRandom', label: 'fillRandom', min: 0, max: 1, step: 1, value: 0, note: 'a colour per ridge' },
  {
    key: 'wobbleAmplitude',
    label: 'wobbleAmplitude',
    min: 0,
    max: 0.15,
    step: 0.005,
    value: 0.045,
    note: 'click to wobble',
  },
  { key: 'wobbleSpeed', label: 'wobbleSpeed', min: 0.05, max: 2, step: 0.05, value: 0.55 },
  { key: 'wobbleWavelength', label: 'wobbleWavelength', min: 0.03, max: 0.5, step: 0.01, value: 0.13 },
  {
    key: 'wobbleRowSpacing',
    label: 'wobbleRowSpacing',
    min: 0.005,
    max: 0.3,
    step: 0.005,
    value: 0.045,
    note: 'lower spreads across rows',
  },
  {
    key: 'trail',
    label: 'trail',
    min: 0,
    max: 0.95,
    step: 0.05,
    value: RIDGE_DEFAULTS.trail,
    note: 'ghost behind each ridge',
  },
  { key: 'octaves', label: 'octaves', min: 1, max: 6, step: 1, value: RIDGE_DEFAULTS.octaves },
];

const METABALL_DIALS: Dial[] = [
  { key: 'amplitude', label: 'amplitude', min: 0, max: 255, step: 1, value: 34, note: 'the readability dial' },
  {
    key: 'levels',
    label: 'levels',
    min: 2,
    max: 12,
    step: 1,
    value: METABALLS_BACKGROUND_DEFAULTS.levels,
    note: 'colours in the palette',
  },
  { key: 'pixelSize', label: 'pixelSize', min: 2, max: 16, step: 1, value: METABALLS_BACKGROUND_DEFAULTS.pixelSize },
  { key: 'fieldScale', label: 'fieldScale', min: 1, max: 4, step: 1, value: METABALLS_BACKGROUND_DEFAULTS.fieldScale },
  { key: 'fps', label: 'fps', min: 6, max: 60, step: 1, value: METABALLS_BACKGROUND_DEFAULTS.fps },
  { key: 'gamma', label: 'gamma', min: 0.5, max: 3, step: 0.05, value: METABALLS_BACKGROUND_DEFAULTS.gamma },
  { key: 'count', label: 'count', min: 1, max: 20, step: 1, value: METABALL_DEFAULTS.count },
  { key: 'ballRadius', label: 'radius', min: 0.06, max: 0.5, step: 0.01, value: METABALL_DEFAULTS.radius },
  {
    key: 'radiusVariance',
    label: 'radiusVariance',
    min: 0,
    max: 0.9,
    step: 0.05,
    value: METABALL_DEFAULTS.radiusVariance,
  },
  { key: 'iso', label: 'iso', min: 0.1, max: 2, step: 0.05, value: METABALL_DEFAULTS.iso, note: 'the surface level' },
  {
    key: 'shoulder',
    label: 'shoulder',
    min: 0,
    max: 1,
    step: 0.02,
    value: METABALL_DEFAULTS.shoulder,
    note: '0 = hard edge',
  },
  { key: 'ballSpeed', label: 'speed', min: 0.02, max: 1, step: 0.02, value: METABALL_DEFAULTS.speed },
  { key: 'wander', label: 'wander', min: 0, max: 1, step: 0.05, value: METABALL_DEFAULTS.wander },
  { key: 'grabReach', label: 'grabReach', min: 0.05, max: 1, step: 0.05, value: 0.4, note: 'drag a blob about' },
  { key: 'releaseEase', label: 'releaseEase', min: 0.05, max: 3, step: 0.05, value: 0.9, note: 'settling back' },
];

const TUNNEL_DIALS: Dial[] = [
  { key: 'amplitude', label: 'amplitude', min: 0, max: 255, step: 1, value: 30, note: 'the readability dial' },
  {
    key: 'levels',
    label: 'levels',
    min: 2,
    max: 12,
    step: 1,
    value: TUNNEL_BACKGROUND_DEFAULTS.levels,
    note: 'colours in the palette',
  },
  { key: 'pixelSize', label: 'pixelSize', min: 2, max: 16, step: 1, value: TUNNEL_BACKGROUND_DEFAULTS.pixelSize },
  { key: 'fieldScale', label: 'fieldScale', min: 1, max: 4, step: 1, value: TUNNEL_BACKGROUND_DEFAULTS.fieldScale },
  { key: 'fps', label: 'fps', min: 6, max: 60, step: 1, value: TUNNEL_BACKGROUND_DEFAULTS.fps },
  { key: 'gamma', label: 'gamma', min: 0.5, max: 3, step: 0.05, value: TUNNEL_BACKGROUND_DEFAULTS.gamma },
  { key: 'speed', label: 'speed', min: 0, max: 1.5, step: 0.02, value: TUNNEL_DEFAULTS.speed, note: 'flight speed' },
  {
    key: 'depth',
    label: 'depth',
    min: 0.05,
    max: 1.2,
    step: 0.01,
    value: TUNNEL_DEFAULTS.depth,
    note: 'longer and narrower',
  },
  { key: 'repeats', label: 'repeats', min: 1, max: 8, step: 1, value: TUNNEL_DEFAULTS.repeats, note: 'whole turns' },
  { key: 'twist', label: 'twist', min: -0.5, max: 0.5, step: 0.01, value: TUNNEL_DEFAULTS.twist },
  {
    key: 'vignette',
    label: 'vignette',
    min: 0,
    max: 1,
    step: 0.02,
    value: TUNNEL_DEFAULTS.vignette,
    note: 'size of the dark throat',
  },
  { key: 'coreRadius', label: 'coreRadius', min: 0.005, max: 0.2, step: 0.005, value: TUNNEL_DEFAULTS.coreRadius },
  {
    key: 'bend',
    label: 'bend',
    min: 0,
    max: 3,
    step: 0.05,
    value: TUNNEL_DEFAULTS.bend,
    note: '0 = a straight tunnel',
  },
  { key: 'bendRate', label: 'bendRate', min: 0.05, max: 2, step: 0.05, value: TUNNEL_DEFAULTS.bendRate },
  { key: 'bank', label: 'bank', min: 0, max: 0.3, step: 0.01, value: TUNNEL_DEFAULTS.bank, note: 'roll into a turn' },
  { key: 'sway', label: 'sway', min: 0, max: 0.3, step: 0.01, value: TUNNEL_DEFAULTS.sway, note: 'how far it drifts' },
  { key: 'swaySpeed', label: 'swaySpeed', min: 0, max: 1, step: 0.02, value: TUNNEL_DEFAULTS.swaySpeed },
  { key: 'steerEase', label: 'steerEase', min: 0.05, max: 3, step: 0.05, value: 0.5, note: 'drag to steer it' },
];

const MANDELBROT_DIALS: Dial[] = [
  { key: 'amplitude', label: 'amplitude', min: 0, max: 255, step: 1, value: 40, note: 'the readability dial' },
  {
    key: 'levels',
    label: 'levels',
    min: 2,
    max: 12,
    step: 1,
    value: MANDELBROT_BACKGROUND_DEFAULTS.levels,
    note: 'colours in the palette',
  },
  {
    key: 'pixelSize',
    label: 'pixelSize',
    min: 2,
    max: 16,
    step: 1,
    value: MANDELBROT_BACKGROUND_DEFAULTS.pixelSize,
  },
  {
    key: 'fieldScale',
    label: 'fieldScale',
    min: 1,
    max: 4,
    step: 1,
    value: MANDELBROT_BACKGROUND_DEFAULTS.fieldScale,
  },
  {
    key: 'maxFieldCells',
    label: 'maxFieldCells',
    min: 2000,
    max: 40000,
    step: 1000,
    value: MANDELBROT_BACKGROUND_DEFAULTS.maxFieldCells,
    note: 'the cost dial - watch the fps',
  },
  { key: 'fps', label: 'fps', min: 6, max: 60, step: 1, value: MANDELBROT_BACKGROUND_DEFAULTS.fps },
  { key: 'gamma', label: 'gamma', min: 0.5, max: 3, step: 0.05, value: MANDELBROT_BACKGROUND_DEFAULTS.gamma },
  {
    key: 'speed',
    label: 'speed',
    min: 0.05,
    max: 3,
    step: 0.05,
    value: MANDELBROT_DEFAULTS.speed,
    note: 'doublings a second',
  },
  { key: 'returnSpeed', label: 'returnSpeed', min: 1, max: 12, step: 0.5, value: MANDELBROT_DEFAULTS.returnSpeed },
  {
    key: 'minSpanLog',
    label: 'depth',
    min: 4,
    max: 13,
    step: 0.25,
    // Decades, because the useful range spans seven orders of magnitude and a
    // linear slider cannot hold it. 7.25 is `MANDELBROT_DEFAULTS.minSpan`.
    value: Math.round(Math.log10(MANDELBROT_DEFAULTS.homeSpan / MANDELBROT_DEFAULTS.minSpan) * 4) / 4,
    note: 'decades below home - past ~13 a double gives out',
  },
  { key: 'iterations', label: 'iterations', min: 30, max: 400, step: 10, value: MANDELBROT_DEFAULTS.iterations },
  {
    key: 'iterationsPerDoubling',
    label: 'iterPerDoubling',
    min: 0,
    max: 40,
    step: 1,
    value: MANDELBROT_DEFAULTS.iterationsPerDoubling,
  },
  {
    key: 'maxIterations',
    label: 'maxIterations',
    min: 60,
    max: 1200,
    step: 20,
    value: MANDELBROT_DEFAULTS.maxIterations,
    note: 'too few and the filigree fills in solid',
  },
  {
    key: 'glow',
    label: 'glow',
    min: 0.5,
    max: 12,
    step: 0.5,
    value: MANDELBROT_DEFAULTS.glow,
    note: 'boundary mantle, in cells',
  },
  { key: 'bands', label: 'bands', min: 0, max: 1, step: 0.05, value: MANDELBROT_DEFAULTS.bands },
  { key: 'bandWidth', label: 'bandWidth', min: 2, max: 40, step: 1, value: MANDELBROT_DEFAULTS.bandWidth },
  {
    key: 'aimInterval',
    label: 'aimInterval',
    min: 0.1,
    max: 5,
    step: 0.1,
    value: MANDELBROT_DEFAULTS.aimInterval,
    note: 'how often it re-picks a target',
  },
  { key: 'aimEase', label: 'aimEase', min: 0.1, max: 5, step: 0.1, value: MANDELBROT_DEFAULTS.aimEase },
  { key: 'aimReach', label: 'aimReach', min: 0.05, max: 1, step: 0.05, value: MANDELBROT_DEFAULTS.aimReach },
  { key: 'aimBias', label: 'aimBias', min: 0, max: 0.5, step: 0.01, value: MANDELBROT_DEFAULTS.aimBias },
  {
    key: 'steerEase',
    label: 'steerEase',
    min: 0.05,
    max: 3,
    step: 0.05,
    value: MANDELBROT_DEFAULTS.steerEase,
    note: 'drag to aim it',
  },
  { key: 'dwell', label: 'dwell', min: 0, max: 5, step: 0.1, value: MANDELBROT_DEFAULTS.dwell },
];

const DIALS: Record<Effect, Dial[]> = {
  smoke: SMOKE_DIALS,
  plasma: PLASMA_DIALS,
  rain: RAIN_DIALS,
  ridges: RIDGE_DIALS,
  metaballs: METABALL_DIALS,
  tunnel: TUNNEL_DIALS,
  mandelbrot: MANDELBROT_DIALS,
};

let effect: Effect = 'smoke';
let values: Record<string, number> = {};
let handle: BackgroundHandle | null = null;
let seed = 1;

function mount() {
  handle?.destroy();

  // A fresh generator per mount, so "Reseed" actually changes the field rather
  // than replaying the same one.
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const common = {
    shading,
    dither: dithering,
    gamma: values.gamma,
    levels: Math.round(values.levels),
    pixelSize: Math.round(values.pixelSize),
    fps: Math.round(values.fps),
    random,
  };

  if (effect === 'mandelbrot') {
    handle = createMandelbrotBackground(canvas, {
      ...common,
      fieldScale: Math.round(values.fieldScale),
      maxFieldCells: Math.round(values.maxFieldCells),
      mandelbrot: {
        speed: values.speed,
        returnSpeed: values.returnSpeed,
        // The dial is decades below the home view, because the useful range
        // spans seven orders of magnitude and a linear slider cannot hold it.
        minSpan: MANDELBROT_DEFAULTS.homeSpan / Math.pow(10, values.minSpanLog),
        iterations: Math.round(values.iterations),
        iterationsPerDoubling: Math.round(values.iterationsPerDoubling),
        maxIterations: Math.round(values.maxIterations),
        glow: values.glow,
        bands: values.bands,
        bandWidth: values.bandWidth,
        aimInterval: values.aimInterval,
        aimEase: values.aimEase,
        aimReach: values.aimReach,
        aimBias: values.aimBias,
        steerEase: values.steerEase,
        dwell: values.dwell,
      },
    });
    if (!handle) fpsOut.textContent = 'no 2D context';
    return;
  }

  if (effect === 'tunnel') {
    handle = createTunnelBackground(canvas, {
      ...common,
      fieldScale: Math.round(values.fieldScale),
      steerEase: values.steerEase,
      tunnel: {
        speed: values.speed,
        depth: values.depth,
        repeats: Math.round(values.repeats),
        twist: values.twist,
        vignette: values.vignette,
        coreRadius: values.coreRadius,
        bend: values.bend,
        bendRate: values.bendRate,
        bank: values.bank,
        sway: values.sway,
        swaySpeed: values.swaySpeed,
      },
    });
    if (!handle) fpsOut.textContent = 'no 2D context';
    return;
  }

  if (effect === 'metaballs') {
    handle = createMetaballsBackground(canvas, {
      ...common,
      fieldScale: Math.round(values.fieldScale),
      metaballs: {
        count: Math.round(values.count),
        radius: values.ballRadius,
        radiusVariance: values.radiusVariance,
        iso: values.iso,
        shoulder: values.shoulder,
        speed: values.ballSpeed,
        wander: values.wander,
        grabReach: values.grabReach,
        releaseEase: values.releaseEase,
      },
    });
    if (!handle) fpsOut.textContent = 'no 2D context';
    return;
  }

  if (effect === 'ridges') {
    handle = createRidgesBackground(canvas, {
      ...common,
      ridges: {
        rows: Math.round(values.rows),
        speed: values.speed,
        amplitude: values.ridgeAmp,
        focus: values.focus,
        sharpness: values.sharpness,
        xScale: values.xScale,
        zScale: values.zScale,
        perspective: values.perspective,
        ampFalloff: values.ampFalloff,
        depthFade: values.depthFade,
        octaves: Math.round(values.octaves),
        fill: values.fill >= 0.5,
        fillLevel: values.fillLevel,
        fillRandom: values.fillRandom >= 0.5,
        trail: values.trail,
        wobbleAmplitude: values.wobbleAmplitude,
        wobbleSpeed: values.wobbleSpeed,
        wobbleWavelength: values.wobbleWavelength,
        wobbleRowSpacing: values.wobbleRowSpacing,
      },
    });
    if (!handle) fpsOut.textContent = 'no 2D context';
    return;
  }

  if (effect === 'rain') {
    handle = createRainBackground(canvas, {
      ...common,
      fieldScale: Math.round(values.fieldScale),
      rain: {
        speed: values.speed,
        fade: values.fade,
        respawn: values.respawn,
        speedVariance: values.speedVariance,
        flicker: values.flicker,
        boldChance: values.boldChance,
        minBrightness: values.minBrightness,
        distortStrength: values.distortStrength,
        distortSpeed: values.distortSpeed,
        distortWidth: values.distortWidth,
      },
    });
    if (!handle) fpsOut.textContent = 'no 2D context';
    return;
  }

  handle =
    effect === 'smoke'
      ? createSmokeBackground(canvas, {
          ...common,
          simulation: {
            drag: values.drag,
            buoyancy: values.buoyancy,
            vorticity: values.vorticity,
            replenish: values.replenish,
            iterations: Math.round(values.iterations),
            jetInterval: values.jetInterval,
            jetSpeed: values.jetSpeed,
            jetDarkChance: values.jetDarkChance,
          },
        })
      : createPlasmaBackground(canvas, {
          ...common,
          speed: values.speed,
          blend: values.blend,
          warp: {
            rippleStrength: values.rippleStrength,
            rippleSpeed: values.rippleSpeed,
            rippleLifetime: values.rippleLifetime,
            frequency: values.frequency,
            warp1: values.warp1,
            warp2: values.warp2,
            spread: values.spread,
            octaves: Math.round(values.octaves),
          },
        });

  if (!handle) {
    fpsOut.textContent = 'no 2D context';
  }
}

function renderCopy() {
  const copy = COPY[effect];
  heading.textContent = copy.heading;
  copyOut.replaceChildren();
  for (const text of copy.paragraphs) {
    const p = document.createElement('p');
    // The strings carry <code>, <em> and <strong>, and they are ours, not input.
    p.innerHTML = text;
    copyOut.append(p);
  }
}

function buildRampPicker() {
  rampPick.replaceChildren();
  for (const r of RAMPS) {
    const option = document.createElement('option');
    option.value = r.id;
    option.textContent = r.name;
    rampPick.append(option);
  }
  rampPick.value = rampId;
  rampName.textContent = RAMPS.find((r) => r.id === rampId)?.name ?? 'greyscale';

  rampPick.addEventListener('change', () => {
    rampId = rampPick.value;
    rampName.textContent = RAMPS.find((r) => r.id === rampId)?.name ?? 'greyscale';
    handle?.refresh();
  });
}

// Shared by every effect, because they are dials on the shading rather than on
// any field: the two ends of the spectrum, as fractions of the full throw.
const SHADING_DIALS: Dial[] = [
  {
    key: 'rangeLo',
    label: 'darkest',
    min: 0,
    max: 0.9,
    step: 0.05,
    value: 0,
    note: 'floor of the spectrum - above 0 the canvas shows as a wash',
  },
  { key: 'rangeHi', label: 'lightest', min: 0.1, max: 1, step: 0.05, value: 1, note: 'ceiling of the spectrum' },
];

function buildDials() {
  // A lookup rather than the ternary chain this used to be: six effects deep it
  // had stopped being readable, and the fall-through arm meant a new effect
  // silently showed the ridges' dials instead of failing to compile.
  const list = [...DIALS[effect], ...SHADING_DIALS];
  values = Object.fromEntries(list.map((d) => [d.key, d.value]));
  dials.replaceChildren();

  for (const dial of list) {
    const label = document.createElement('label');
    const caption = document.createElement('span');
    const name = document.createTextNode(dial.label);
    const readout = document.createElement('b');
    readout.textContent = String(dial.value);
    caption.append(name, readout);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(dial.min);
    input.max = String(dial.max);
    input.step = String(dial.step);
    input.value = String(dial.value);

    input.addEventListener('input', () => {
      values[dial.key] = Number(input.value);
      readout.textContent = input.value;
      // Every dial here is baked in at construction time, so changing one means
      // remounting. That is a demo concern, not a library one.
      mount();
    });

    label.append(caption, input);
    if (dial.note) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = dial.note;
      label.append(note);
    }
    dials.append(label);
  }
}

for (const button of panel.querySelectorAll<HTMLButtonElement>('[data-effect]')) {
  button.addEventListener('click', () => {
    effect = button.dataset.effect as Effect;
    for (const other of panel.querySelectorAll('[data-effect]')) other.classList.toggle('active', other === button);
    renderCopy();
    buildDials();
    mount();
  });
}

themeButton.addEventListener('click', () => {
  const dark = document.documentElement.classList.toggle('dark');
  themeButton.textContent = dark ? 'Light' : 'Dark';
  // The library watches the `class` on <html> by default, so this needs no
  // further prompting - `refresh()` is only here to make that explicit.
  handle?.refresh();
});

document.getElementById('reseed')?.addEventListener('click', mount);

// Hides the copy so the effect can be looked at on its own - which is most of
// what this page is for, and the panel is not in the way of the middle of the
// screen the way a column of prose is. Nothing is remounted: the canvas is behind
// the text rather than under it, so this only changes what is on top.
let showText = true;
textButton.addEventListener('click', () => {
  showText = !showText;
  prose.hidden = !showText;
  textButton.textContent = `Text: ${showText ? 'on' : 'off'}`;
  textButton.classList.toggle('active', showText);
});

// Collapses the panel to a single button in the same corner, for looking at an
// effect with nothing else on screen at all. The panel is hidden, not rebuilt,
// so every dial keeps its position and reopening puts things back as they were.
const collapseButton = document.getElementById('collapse') as HTMLButtonElement;
const revealButton = document.getElementById('reveal') as HTMLButtonElement;

collapseButton.addEventListener('click', () => {
  panel.hidden = true;
  revealButton.hidden = false;
});

revealButton.addEventListener('click', () => {
  panel.hidden = false;
  revealButton.hidden = true;
});

ditherButton.addEventListener('click', () => {
  dithering = !dithering;
  ditherButton.textContent = `Dither: ${dithering ? 'on' : 'off'}`;
  ditherButton.classList.toggle('active', dithering);
  // Baked in at construction, so this remounts - a demo concern, not the
  // library's; `dither` is a plain option there.
  mount();
});

renderCopy();
buildRampPicker();
buildDials();
mount();
requestAnimationFrame(meter);
