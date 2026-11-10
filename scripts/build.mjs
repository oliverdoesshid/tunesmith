/**
 * Production build.
 *
 * Three independent targets:
 *   1. main process  -> dist/main/index.cjs     (CommonJS, external: electron)
 *   2. preload       -> dist/preload/index.cjs  (CommonJS, sandbox-compatible)
 *   3. renderer      -> dist/renderer/**        (ESM + assets, via Vite)
 *   4. cli           -> dist/cli/index.cjs     (headless companion, CommonJS)
 *
 * Source maps are intentionally not emitted for the packaged app: they would ship
 * internal file paths to end users.
 */
import { build as esbuild } from 'esbuild';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
};

async function buildMain() {
  await esbuild({
    ...shared,
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(dist, 'main/index.cjs'),
  });
}

async function buildPreload() {
  await esbuild({
    ...shared,
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    outfile: path.join(dist, 'preload/index.cjs'),
  });
}

async function buildCli() {
  await esbuild({
    ...shared,
    entryPoints: [path.join(root, 'src/cli/index.ts')],
    outfile: path.join(dist, 'cli/index.cjs'),
    // The shebang makes the file runnable directly on systems that honour it; on
    // Windows the npm bin shim installed from `package.json#bin` handles the rest.
    banner: { js: '#!/usr/bin/env node' },
  });
}

async function buildRenderer() {
  const { build } = await import('vite');
  await build({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    logLevel: 'warn',
  });
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await buildMain();
  await buildPreload();
  await buildCli();
  await buildRenderer();

  for (const rel of ['main/index.cjs', 'preload/index.cjs', 'cli/index.cjs', 'renderer/index.html']) {
    const s = await stat(path.join(dist, rel));
    if (s.size === 0) throw new Error(`build produced an empty artifact: ${rel}`);
    console.log(`  built  ${rel}  (${(s.size / 1024).toFixed(1)} kB)`);
  }
  console.log('build ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
