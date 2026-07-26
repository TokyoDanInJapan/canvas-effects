import { defineConfig } from 'vite';

// Only for the demo page - the library itself is built with tsc.
export default defineConfig({
  root: 'demo',
  server: { open: true },
  build: { outDir: '../demo-dist', emptyOutDir: true },
});
