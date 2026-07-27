// canvas-effects: six animated, ordered-dithered greyscale backgrounds for a
// 2D canvas. See the README for what they are and how they work.
//
// Three layers, and you can enter at any of them:
//
//   • The mounts - `createSmokeBackground` and the five beside it. A canvas in,
//     a handle out, everything wired up.
//   • The rendering - `createSurface` and the dither and noise it is built on,
//     plus `mountBackground` if you would rather write a seventh effect than use
//     one of these six. Use these to shade a field of your own.
//   • The maths - the fluid solver, the domain warp, the projections. All
//     DOM-free and usable on their own.
//
// Everything each module exports is re-exported here. That is checked by a test
// rather than by good intentions: the interaction work went in without ever
// reaching this file, and for two releases a caller could use `maxRipples`
// without being able to name a `Ripple`.

export { createSmokeBackground, SMOKE_BACKGROUND_DEFAULTS, type SmokeBackgroundOptions } from './smoke-background.js';

export {
  createPlasmaBackground,
  PLASMA_BACKGROUND_DEFAULTS,
  type PlasmaBackgroundOptions,
} from './plasma-background.js';

export { createRainBackground, RAIN_BACKGROUND_DEFAULTS, type RainBackgroundOptions } from './rain-background.js';

export {
  createRidgesBackground,
  RIDGES_BACKGROUND_DEFAULTS,
  type RidgesBackgroundOptions,
} from './ridges-background.js';

export {
  createMetaballsBackground,
  METABALLS_BACKGROUND_DEFAULTS,
  type MetaballsBackgroundOptions,
} from './metaballs-background.js';

export {
  createTunnelBackground,
  TUNNEL_BACKGROUND_DEFAULTS,
  type TunnelBackgroundOptions,
} from './tunnel-background.js';

// The mount harness the six above are built on, for writing a seventh.
export {
  mountBackground,
  createAgeingList,
  aspectOf,
  cellSpansOf,
  approach,
  ringPulse,
  COMMON_BACKGROUND_DEFAULTS,
  type AgeingList,
  type Ageing,
  type BackgroundSpec,
  type CommonBackgroundOptions,
  type Timestep,
} from './background.js';

export {
  createSurface,
  planSurface,
  buildPalette,
  defaultShading,
  sameShading,
  type BackgroundHandle,
  type Shading,
  type Surface,
  type SurfaceOptions,
} from './render.js';

export {
  createDriver,
  createDragSource,
  prefersReducedMotion,
  type DragOptions,
  type Driver,
  type DriverOptions,
} from './driver.js';

// The falling-streak field.
export {
  RAIN_DEFAULTS,
  createRain,
  distortField,
  rollLane,
  stepRain,
  meanBrightness,
  type Distortion,
  type Rain,
  type RainLane,
  type RainParams,
} from './rain.js';

// The ridgeline landscape.
export {
  RIDGE_DEFAULTS,
  createRidges,
  randomizeRidges,
  renderRidges,
  depthAtY,
  fillShadeFor,
  ridgeHeight,
  rowAmplitude,
  rowBrightness,
  rowY,
  stepRidges,
  wobbleOffset,
  type RidgeParams,
  type RidgeState,
  type Ridges,
  type Wobble,
} from './ridges.js';

// The implicit surface.
export {
  METABALL_DEFAULTS,
  createMetaballs,
  randomizeMetaballs,
  renderMetaballs,
  advanceThrow,
  ballsAt,
  fieldAt,
  falloff,
  nearestBall,
  startThrow,
  surface as metaballSurface,
  coverage,
  type Ball,
  type BallOverride,
  type MetaballParams,
  type MetaballState,
  type Metaballs,
  type Throw,
} from './metaballs.js';

// The tunnel projection.
export {
  TUNNEL_DEFAULTS,
  buildTunnelTile,
  createTunnel,
  randomizeTunnel,
  renderTunnel,
  axisAt,
  axisFromTable,
  createAxisTable,
  fillAxisTable,
  sampleTile,
  tunnelCentre,
  vignetteAt,
  wallCoords,
  type AxisTable,
  type Tunnel,
  type TunnelParams,
  type TunnelState,
} from './tunnel.js';

export { withDefaults } from './options.js';

export { BAYER_4X4, darken, orderedDither, quantise } from './dither.js';

export { fbm, hash2, makeRandom, valueNoise } from './noise.js';

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
} from './smoke.js';

// The domain warp.
export {
  WARP_GRID_X,
  WARP_GRID_Y,
  PLASMA_WARP_DEFAULTS,
  buildPlasmaTile,
  fillDisplacementGrid,
  randomizePlasmaWarp,
  rippleDisplacement,
  sampleDisplacementGrid,
  samplePlasma,
  type PlasmaWarpConfig,
  type PlasmaWarpSeed,
  type Ripple,
} from './plasma-warp.js';
