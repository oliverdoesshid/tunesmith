#!/usr/bin/env node
/**
 * Run the TypeScript signed-catalog generator without adding a runtime transpiler.
 *
 * esbuild bundles `generateMarketCatalog.ts` (including zod) into a temporary ESM file;
 * Node builtins stay external. The repository root is passed through the environment
 * because the temporary bundle no longer sits beside the source tree.
 */
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tunesmith-market-catalog-'));
const outfile = path.join(tempDir, 'generateMarketCatalog.mjs');

try {
  await build({
    entryPoints: [path.join(root, 'scripts', 'generateMarketCatalog.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    sourcemap: false,
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
  });

  process.env.TUNESMITH_REPO_ROOT = root;
  await import(pathToFileURL(outfile).href);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
