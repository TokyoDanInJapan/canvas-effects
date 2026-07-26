// Does `index.ts` actually export the library?
//
// This exists because it did not. The interactive features went in over several
// releases - ripples, droplet distortions, wobbles, throwable blobs, a steerable
// tunnel - and none of them ever reached this file. The options that configure
// them were exported, so a caller could set `maxRipples` and could not name a
// `Ripple`; `createDragSource` was documented as the shared way to read a drag
// and was not reachable at all.
//
// So rather than a list of exports to keep in step by hand, this reads what each
// module exports and asserts that the public entry point passes it on. A new
// function is public by default and has to be named below to be kept private,
// which is the opposite of the arrangement that let the drift happen.

import { describe, expect, it } from 'vitest';

import * as index from './index';
import * as background from './background';
import * as dither from './dither';
import * as driver from './driver';
import * as metaballs from './metaballs';
import * as noise from './noise';
import * as options from './options';
import * as plasmaWarp from './plasma-warp';
import * as rain from './rain';
import * as render from './render';
import * as ridges from './ridges';
import * as smoke from './smoke';
import * as tunnel from './tunnel';

import * as metaballsBackground from './metaballs-background';
import * as plasmaBackground from './plasma-background';
import * as rainBackground from './rain-background';
import * as ridgesBackground from './ridges-background';
import * as smokeBackground from './smoke-background';
import * as tunnelBackground from './tunnel-background';

/**
 * Runtime values only. A type-only export leaves nothing behind at runtime, so
 * `import * as` cannot see one - types are checked by `tsc` instead, which fails
 * the build if `index.ts` re-exports a type that does not exist.
 */
const MODULES: Array<{ name: string; module: Record<string, unknown> }> = [
  { name: 'background', module: background },
  { name: 'dither', module: dither },
  { name: 'driver', module: driver },
  { name: 'metaballs', module: metaballs },
  { name: 'metaballs-background', module: metaballsBackground },
  { name: 'noise', module: noise },
  { name: 'options', module: options },
  { name: 'plasma-background', module: plasmaBackground },
  { name: 'plasma-warp', module: plasmaWarp },
  { name: 'rain', module: rain },
  { name: 'rain-background', module: rainBackground },
  { name: 'render', module: render },
  { name: 'ridges', module: ridges },
  { name: 'ridges-background', module: ridgesBackground },
  { name: 'smoke', module: smoke },
  { name: 'smoke-background', module: smokeBackground },
  { name: 'tunnel', module: tunnel },
  { name: 'tunnel-background', module: tunnelBackground },
];

/**
 * Exports that are deliberately not public, with the reason.
 *
 * Keep this short. An entry here is a decision that something is useful enough to
 * export from its module and not useful enough to support, which is a position
 * worth having to write down.
 */
const INTERNAL: Record<string, string> = {
  // Renamed on the way out, because `surface` on its own says nothing at the top
  // level - it is the metaballs' iso-surface shaper, not a `Surface`.
  surface: 'exported as `metaballSurface`',
};

describe('index', () => {
  it.each(MODULES)('re-exports everything from $name', ({ module }) => {
    const missing = Object.keys(module).filter((name) => !(name in index) && !(name in INTERNAL));
    expect(missing).toEqual([]);
  });

  it('exports the six mounts and their defaults', () => {
    // The documented entry points, spelled out rather than derived: this is the
    // list the README promises.
    for (const name of [
      'createSmokeBackground',
      'createPlasmaBackground',
      'createRainBackground',
      'createRidgesBackground',
      'createMetaballsBackground',
      'createTunnelBackground',
    ]) {
      expect(typeof index[name as keyof typeof index]).toBe('function');
    }

    for (const name of [
      'SMOKE_BACKGROUND_DEFAULTS',
      'PLASMA_BACKGROUND_DEFAULTS',
      'RAIN_BACKGROUND_DEFAULTS',
      'RIDGES_BACKGROUND_DEFAULTS',
      'METABALLS_BACKGROUND_DEFAULTS',
      'TUNNEL_BACKGROUND_DEFAULTS',
    ]) {
      expect(index[name as keyof typeof index]).toBeTypeOf('object');
    }
  });

  it('exports the middle layer, so a field of your own can be shaded', () => {
    expect(index.createSurface).toBeTypeOf('function');
    expect(index.mountBackground).toBeTypeOf('function');
    expect(index.createDragSource).toBeTypeOf('function');
    expect(index.createDriver).toBeTypeOf('function');
  });

  it('exports the interaction helpers the options refer to', () => {
    // Every one of these was unreachable while the option documenting it was not.
    expect(index.distortField).toBeTypeOf('function');
    expect(index.rippleDisplacement).toBeTypeOf('function');
    expect(index.wobbleOffset).toBeTypeOf('function');
    expect(index.depthAtY).toBeTypeOf('function');
    expect(index.nearestBall).toBeTypeOf('function');
    expect(index.startThrow).toBeTypeOf('function');
    expect(index.advanceThrow).toBeTypeOf('function');
  });

  it('names nothing it cannot deliver', () => {
    for (const [name, value] of Object.entries(index)) {
      expect(value, `${name} is exported as undefined`).toBeDefined();
    }
  });
});
