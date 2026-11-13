import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

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
  plugins: [react(), tailwindcss()],
  server: {
    port: 5273,
    strictPort: true,
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    // The renderer only runs in Electron's bundled Chromium, so there is no reason to
    // down-level modern syntax or ship compatibility helpers.
    target: 'esnext',
    minify: 'esbuild',
    cssMinify: 'esbuild',
    sourcemap: false,
    reportCompressedSize: false,
    modulePreload: { polyfill: false },
    rolldownOptions: {
      input: {
        app: path.join(rootDir, 'index.html'),
        overlay: path.join(rootDir, 'overlay.html'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx', 'test/**/*.test.ts', 'test/**/*.test.tsx'],
    reporters: 'default',
  },
});
