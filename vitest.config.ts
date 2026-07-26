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
      // `driver.ts` and `render.ts` used to be on this list, on the grounds that
      // they need a canvas and a frame loop. They are here now with the DOM
      // stubbed, and finding three bugs in them the moment they were tested is
      // the argument against ever excluding a file for being awkward: the
      // untested half is where the bugs were, which is not a coincidence.
      //
      // Nothing is excluded now but the tests themselves and `index.ts`, which is
      // re-exports only. The six mounts are covered by backgrounds.test.ts, which
      // mounts each of them against a stubbed canvas and reads the bytes back.
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      // Re-baselined once the driver, the renderer and the six mounts came under
      // test, with a point or two of headroom rather than pinned to the current
      // numbers: a threshold that fails on an unrelated refactor teaches people
      // to lower it.
      //
      // Branches sit lower than the rest and are meant to. What is left uncovered
      // is almost entirely the `?? null` and `if (!field) return` guards in the
      // mount specs, which hold against a state that cannot arise while the
      // harness is calling them in order. Testing them would mean constructing
      // that impossible state, which tests the test rather than the library.
      //
      // Branches came down from 93 with vitest 4, and not because anything stopped
      // being tested. Version 4 maps v8's output through the AST rather than
      // approximating it, so a guard that only ever ran one way is now counted as
      // one way rather than credited as covered. The numbers are less flattering
      // and describe the suite more accurately, which is the better trade.
      thresholds: { statements: 99, branches: 92, functions: 100, lines: 99 },
    },
  },
});
