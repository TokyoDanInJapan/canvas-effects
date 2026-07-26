// The demo page. Not part of the library - it exists so the dials can be
// turned while looking at the result, which is the only sane way to tune any
// of this.

import {
  PLASMA_BACKGROUND_DEFAULTS,
  SMOKE_BACKGROUND_DEFAULTS,
  createPlasmaBackground,
  createSmokeBackground,
  type BackgroundHandle,
  type Shading,
} from '../src/index';

const canvas = document.getElementById('background') as HTMLCanvasElement;

// Frames actually drawn, which is the number worth watching - both effects
// deliberately draw well below the refresh rate.
//
// Counted by wrapping `putImageData`, which is crude but is the only paint
// either effect makes. Done here, before anything mounts, and with the same
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

type Effect = 'smoke' | 'plasma';

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
  return dark
    ? { base: 18, amplitude: values.amplitude }
    : { base: 255, amplitude: -Math.round(values.amplitude * 0.85) };
}

const SMOKE_DIALS: Dial[] = [
  { key: 'amplitude', label: 'amplitude', min: 0, max: 90, step: 1, value: 26, note: 'the readability dial' },
  { key: 'gamma', label: 'gamma', min: 0.6, max: 3, step: 0.05, value: SMOKE_BACKGROUND_DEFAULTS.gamma },
  { key: 'levels', label: 'levels', min: 2, max: 12, step: 1, value: SMOKE_BACKGROUND_DEFAULTS.levels },
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
  { key: 'amplitude', label: 'amplitude', min: 0, max: 90, step: 1, value: 24, note: 'the readability dial' },
  { key: 'gamma', label: 'gamma', min: 0.6, max: 3, step: 0.05, value: PLASMA_BACKGROUND_DEFAULTS.gamma },
  { key: 'levels', label: 'levels', min: 2, max: 12, step: 1, value: PLASMA_BACKGROUND_DEFAULTS.levels },
  { key: 'pixelSize', label: 'pixelSize', min: 2, max: 16, step: 1, value: PLASMA_BACKGROUND_DEFAULTS.pixelSize },
  { key: 'fps', label: 'fps', min: 6, max: 60, step: 1, value: PLASMA_BACKGROUND_DEFAULTS.fps },
  { key: 'speed', label: 'speed', min: 0.05, max: 3, step: 0.05, value: PLASMA_BACKGROUND_DEFAULTS.speed },
  { key: 'blend', label: 'blend', min: 0, max: 0.95, step: 0.01, value: PLASMA_BACKGROUND_DEFAULTS.blend },
  { key: 'frequency', label: 'frequency', min: 0.3, max: 5, step: 0.05, value: 1.45 },
  { key: 'warp1', label: 'warp1', min: 0, max: 5, step: 0.05, value: 1.9 },
  { key: 'warp2', label: 'warp2', min: 0, max: 3, step: 0.05, value: 0.85, note: 'the marbling' },
  { key: 'spread', label: 'spread', min: 0, max: 2, step: 0.02, value: 0.34 },
  { key: 'octaves', label: 'octaves', min: 1, max: 6, step: 1, value: 3 },
];

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
    gamma: values.gamma,
    levels: Math.round(values.levels),
    pixelSize: Math.round(values.pixelSize),
    fps: Math.round(values.fps),
    random,
  };

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

function buildDials() {
  const list = effect === 'smoke' ? SMOKE_DIALS : PLASMA_DIALS;
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

buildDials();
mount();
requestAnimationFrame(meter);
