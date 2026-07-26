import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The maths is deliberately DOM-free, which is what lets it be tested here
    // rather than in a browser. The canvas and loop code is covered by the demo
    // page and by whatever mounts it.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Headroom above the 5s default. Several of these tests run numeric
    // simulations for hundreds of frames, and under coverage instrumentation on
    // a slow CI runner that is a different proposition from running locally -
    // which is exactly how a smoke test came to pass here and time out there.
    testTimeout: 20_000,
    coverage: {
      // Without `include`, v8 only reports files a test happens to import, so
      // an entirely untested module is invisible rather than counted as 0%.
      // Naming the source set means these numbers describe the maths as a
      // whole, and a new untested module pushes them down instead of hiding.
      include: ['src/**/*.ts'],
      // Everything excluded here needs a canvas, a window or a frame loop, and
      // is covered by the demo page rather than by vitest. `render.ts` is on
      // the list for its `createSurface` half; the pure `planSurface` half it
      // also holds is tested in render.test.ts regardless of the exclusion.
      exclude: [
        'src/**/*.test.ts',
        'src/index.ts',
        'src/driver.ts',
        'src/render.ts',
        'src/smoke-background.ts',
        'src/plasma-background.ts',
        'src/rain-background.ts',
        'src/ridges-background.ts',
        'src/metaballs-background.ts',
        'src/tunnel-background.ts',
      ],
      thresholds: { statements: 95, branches: 85, functions: 95, lines: 95 },
    },
  },
});
