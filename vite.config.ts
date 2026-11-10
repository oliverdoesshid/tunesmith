import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Only the renderer goes through Vite. The main process and the preload script are
 * bundled by esbuild (see scripts/build.mjs) because they must be CommonJS and must
 * not be code-split.
 *
 * `base: './'` keeps asset URLs relative so the packaged app can load the bundle
 * from `file://` without a custom protocol handler.
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: 'default',
  },
});
