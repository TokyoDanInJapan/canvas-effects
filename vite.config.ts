import { defineConfig } from 'vite';

import pkg from './package.json';

// Only for the demo page - the library itself is built with tsc.
export default defineConfig({
  root: 'demo',
  // Substituted into the page rather than imported by it, so package.json does
  // not end up in the bundle - and applied by `vite dev` as well as by a build,
  // so the number on the local page is the number that will be deployed.
  define: { __VERSION__: JSON.stringify(pkg.version) },
  server: { open: true },
  build: { outDir: '../demo-dist', emptyOutDir: true },
});
