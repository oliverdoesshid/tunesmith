#!/usr/bin/env node
/**
 * Write `<preset>.sig` files for a preset directory.
 *
 *   node scripts/sign-presets.mjs --dir presets/community --key tmp/preset-signing-key.pem
 *
 * The signature covers the exact file bytes, matching `src/main/pipeline/integrity.ts`.
 * The private key must correspond to the pinned public key in `src/main/security/keys.ts`;
 * it is never committed.
 */
import { createPrivateKey, sign } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dir = arg('dir');
const keyPath = arg('key');

if (!dir || !keyPath) {
  console.error('Usage: sign-presets.mjs --dir <preset-dir> --key <ed25519-private.pem>');
  process.exit(2);
}

const privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'));
if (privateKey.asymmetricKeyType !== 'ed25519') {
  console.error('The key is not an Ed25519 private key.');
  process.exit(1);
}

const files = readdirSync(dir)
  .filter((file) => file.endsWith('.json') && file !== 'index.json')
  .sort();

if (files.length === 0) {
  console.error(`No preset files in ${dir}.`);
  process.exit(1);
}

for (const file of files) {
  const bytes = readFileSync(path.join(dir, file));
  const signature = sign(null, bytes, privateKey).toString('base64');
  writeFileSync(path.join(dir, `${file}.sig`), `${signature}\n`, 'utf8');
  console.log(`signed ${file}`);
}

console.log(`\n${files.length} signature file(s) written to ${dir}`);
