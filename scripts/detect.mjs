/** Bundles scripts/detect-entry.ts to dist/detect.mjs and runs it. */
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'dist/detect-entry.mjs');

await build({
  entryPoints: [path.join(root, 'scripts/detect-entry.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  logLevel: 'warning',
});

const mod = await import(pathToFileURL(outfile).href);
process.exit(await mod.main(process.argv.slice(2)));
