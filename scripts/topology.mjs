/** Bundles scripts/topology-entry.ts to dist/topology-entry.mjs and runs it. */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'dist/topology-entry.mjs');

await build({
  entryPoints: [path.join(root, 'scripts/topology-entry.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  logLevel: 'warning',
});

const mod = await import(pathToFileURL(outfile).href);
process.exit(await mod.main());
