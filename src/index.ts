// canvas-effects: two animated, ordered-dithered greyscale backgrounds for a
// 2D canvas. See the README for what they are and how they work.
//
// Three layers, and you can enter at any of them:
//
//   • The mounts - `createSmokeBackground`, `createPlasmaBackground`. A canvas
//     in, a handle out, everything wired up.
//   • The rendering - `createSurface`, and the dither and noise it is built on.
//     Use these to shade a field of your own.
//   • The maths - the fluid solver and the domain warp, both DOM-free and
//     usable on their own.

export { createSmokeBackground, SMOKE_BACKGROUND_DEFAULTS, type SmokeBackgroundOptions } from './smoke-background';

export { createPlasmaBackground, PLASMA_BACKGROUND_DEFAULTS, type PlasmaBackgroundOptions } from './plasma-background';

export { createRainBackground, RAIN_BACKGROUND_DEFAULTS, type RainBackgroundOptions } from './rain-background';

export { createRidgesBackground, RIDGES_BACKGROUND_DEFAULTS, type RidgesBackgroundOptions } from './ridges-background';

export { createFireBackground, FIRE_BACKGROUND_DEFAULTS, type FireBackgroundOptions } from './fire-background';

export {
  createSurface,
  planSurface,
  defaultShading,
  type BackgroundHandle,
  type Shading,
  type Surface,
  type SurfaceOptions,
} from './render';

export { createDriver, prefersReducedMotion, type Driver, type DriverOptions } from './driver';

// The falling-streak field.
export {
  RAIN_DEFAULTS,
  createRain,
  rollLane,
  stepRain,
  meanBrightness,
  type Rain,
  type RainLane,
  type RainParams,
} from './rain';

// The ridgeline landscape.
export {
  RIDGE_DEFAULTS,
  createRidges,
  randomizeRidges,
  renderRidges,
  ridgeHeight,
  rowAmplitude,
  rowBrightness,
  rowY,
  stepRidges,
  type RidgeParams,
  type RidgeState,
  type Ridges,
} from './ridges';

// The heat field.
export {
  FIRE_DEFAULTS,
  createFire,
  randomizeFire,
  seedFire,
  propagateFire,
  stepFire,
  windAt,
  flameHeight,
  type Fire,
  type FireParams,
  type FireState,
} from './fire';

export { withDefaults } from './options';

export { BAYER_4X4, darken, orderedDither, quantise } from './dither';

export { fbm, hash2, makeRandom, valueNoise } from './noise';

// The fluid solver, in the order a frame uses it.
export {
  SMOKE_DEFAULTS,
  createFluid,
  randomizeSmoke,
  computeSource,
  applyBuoyancy,
  applyStirring,
  applyVorticityConfinement,
  advect,
  advectMacCormack,
  computeDivergence,
  solvePressure,
  subtractPressureGradient,
  stepFluid,
  planJet,
  nextJetDelay,
  applyJet,
  applyStroke,
  sampleWrapped,
  sampleBounds,
  meanAbsDivergence,
  type Fluid,
  type Jet,
  type SmokeParams,
  type SmokeState,
  type Stroke,
} from './smoke';

// The domain warp.
export {
  WARP_GRID_X,
  WARP_GRID_Y,
  PLASMA_WARP_DEFAULTS,
  buildPlasmaTile,
  fillDisplacementGrid,
  randomizePlasmaWarp,
  sampleDisplacementGrid,
  samplePlasma,
  type PlasmaWarpConfig,
  type PlasmaWarpSeed,
} from './plasma-warp';
