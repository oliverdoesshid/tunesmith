/**
 * Rebuilds presets/community/index.json from the preset files on disk.
 *
 * The digest is not a signature: it proves the bytes match what was reviewed, but a
 * party that can rewrite both the file and the index can also rewrite the digest.
 * Production distribution pairs this index with an Ed25519 signature over the whole
 * manifest (see docs/SECURITY-MODEL.md, "Provenance").
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'presets/community');

const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== 'index.json').sort();

const presets = [];
for (const file of files) {
  const bytes = await readFile(path.join(dir, file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new Error(`${file}: ${err.message}`);
  }
  presets.push({ file, id: parsed.id, version: parsed.version, sha256 });
  console.log(`${sha256.slice(0, 12)}  ${file}`);
}

const index = {
  schemaVersion: 1,
  generatedBy: 'scripts/hash-presets.mjs',
  presets,
};

await writeFile(path.join(dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
console.log(`\nwrote index.json with ${presets.length} preset(s)`);
