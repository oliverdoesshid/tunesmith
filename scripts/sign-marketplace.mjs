#!/usr/bin/env node
/**
 * Sign a marketplace catalog with an Ed25519 private key.
 *
 * Input (`--catalog`) is an unsigned catalog:
 *
 *   {
 *     "schemaVersion": 1,
 *     "generatedAt": "2026-01-01T00:00:00.000Z",
 *     "entries": [
 *       { "preset": { ... }, "ratings": { "up": 0, "down": 0, "crashes": 0, "recoveries": 0 },
 *         "publishedAt": "2026-01-01T00:00:00.000Z" }
 *     ]
 *   }
 *
 * Output (`--out`, default stdout) is the envelope the app expects. The matching public
 * key goes into `TUNESMITH_MARKET_KEYS` (or `market/config.json`) under `--key-id`.
 *
 *   node scripts/sign-marketplace.mjs --catalog catalog.json --key private.pem --key-id tunesmith-2026
 */
import { createHash, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const catalogPath = arg('catalog');
const keyPath = arg('key');
const keyId = arg('key-id') ?? 'tunesmith';
const outPath = arg('out');

if (!catalogPath || !keyPath) {
  console.error('Usage: sign-marketplace.mjs --catalog <file> --key <ed25519-private.pem> [--key-id id] [--out file]');
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(keyId)) {
  console.error('--key-id must be lowercase letters, digits and dashes (2-32 characters).');
  process.exit(2);
}

const unsigned = JSON.parse(readFileSync(catalogPath, 'utf8'));
const privateKey = readFileSync(keyPath, 'utf8');

if (!Array.isArray(unsigned.entries) || unsigned.entries.length === 0) {
  console.error('The catalog has no entries.');
  process.exit(1);
}

const entries = unsigned.entries.map((entry) => {
  const canonicalPreset = canonical(entry.preset);
  const sha256 = createHash('sha256').update(canonicalPreset, 'utf8').digest('hex');
  const sig = sign(null, Buffer.from(`tunesmith-entry-v1:${sha256}`, 'utf8'), privateKey).toString('base64');
  return {
    preset: entry.preset,
    sha256,
    signature: { keyId, sig },
    ratings: entry.ratings ?? { up: 0, down: 0, crashes: 0, recoveries: 0 },
    publishedAt: entry.publishedAt,
  };
});

const catalog = {
  schemaVersion: unsigned.schemaVersion ?? 1,
  generatedAt: unsigned.generatedAt ?? new Date().toISOString(),
  entries,
};

const catalogSig = sign(
  null,
  Buffer.from(`tunesmith-catalog-v1:${canonical(catalog)}`, 'utf8'),
  privateKey,
).toString('base64');

const envelope = { catalog, signature: { keyId, sig: catalogSig } };
const text = JSON.stringify(envelope, null, 2) + '\n';

if (outPath) {
  writeFileSync(outPath, text, 'utf8');
  console.error(`Wrote ${outPath} (${entries.length} entries, key ${keyId}).`);
} else {
  process.stdout.write(text);
}
