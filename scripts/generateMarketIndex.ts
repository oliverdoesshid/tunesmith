#!/usr/bin/env node
/**
 * Generate the public static marketplace index.
 *
 * For every preset in `presets/community/` this script:
 *   1. validates the file against the authoritative preset schema;
 *   2. requires a detached Ed25519 `.sig` over the exact file bytes and verifies it
 *      against the pinned preset key compiled into TuneSmith;
 *   3. computes the SHA-256 of those bytes;
 *   4. emits `market/index.json` with a raw GitHub download URL.
 *
 * The output is deterministic (sorted by id, no timestamps), so CI can regenerate it
 * and prove the committed catalog is current.
 *
 * Usage:
 *   npm run market:index
 *   npm run market:check        # fail if market/index.json is stale
 *
 * Environment:
 *   GITHUB_REPOSITORY   owner/repo used to build download URLs (default: this repo)
 *   GITHUB_REF_NAME     branch used in raw URLs (default: main)
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PRESET_SIGNING_PUBLIC_KEY } from '../src/main/security/keys';
import {
  MARKET_INDEX_SCHEMA_VERSION,
  marketIndexSchema,
  type MarketIndex,
  type MarketIndexEntry,
} from '../src/shared/market/index-schema';
import {
  formatZodIssues,
  PRESET_LIMITS,
  presetSchema,
  type Preset,
} from '../src/shared/preset/schema';

const root = path.resolve(process.env.TUNESMITH_REPO_ROOT ?? process.cwd());
const communityDir = path.join(root, 'presets', 'community');
const checkOnly = process.argv.includes('--check');

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const outPath = path.resolve(root, arg('out') ?? 'market/index.json');

function fail(message: string): never {
  throw new Error(message);
}

function repositorySlug(): string {
  const value = process.env.GITHUB_REPOSITORY ?? 'oliverdoesshid/tunesmith';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    fail(`GITHUB_REPOSITORY must be owner/repo, received "${value}".`);
  }
  return value;
}

function branchName(): string {
  const value = process.env.GITHUB_REF_NAME ?? 'main';
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.includes('..')) {
    fail(`GITHUB_REF_NAME contains unsupported characters: "${value}".`);
  }
  return value;
}

function formatRam(range: { min?: number; max?: number } | undefined): string | null {
  if (range === undefined) return null;
  if (range.min !== undefined && range.max !== undefined) return `${range.min}–${range.max} GB`;
  if (range.min !== undefined) return `≥ ${range.min} GB`;
  if (range.max !== undefined) return `≤ ${range.max} GB`;
  return null;
}

function hardwareSignatureFor(preset: Preset): string {
  const compatibility = preset.compatibility;
  if (compatibility.signature !== undefined && compatibility.signature.length > 0) {
    return compatibility.signature.join(' | ').slice(0, 600);
  }

  const parts: string[] = [];
  if (compatibility.cpu !== undefined && compatibility.cpu.length > 0) {
    parts.push(`CPU ${compatibility.cpu.join(' | ')}`);
  }
  if (compatibility.gpu !== undefined && compatibility.gpu.length > 0) {
    parts.push(`GPU ${compatibility.gpu.join(' | ')}`);
  }
  const ram = formatRam(compatibility.ramGb);
  if (ram !== null) parts.push(`RAM ${ram}`);
  if (compatibility.storage !== undefined && compatibility.storage.length > 0) {
    parts.push(compatibility.storage.join('/'));
  }
  return parts.length > 0 ? parts.join(' · ').slice(0, 600) : 'universal';
}

async function readVerifiedPreset(file: string): Promise<{
  preset: Preset;
  bytes: Buffer;
  sha256: string;
  signature: string;
}> {
  const filePath = path.join(communityDir, file);
  const bytes = await readFile(filePath);

  if (bytes.byteLength > PRESET_LIMITS.maxFileBytes) {
    fail(`${file} is ${bytes.byteLength} bytes; the preset limit is ${PRESET_LIMITS.maxFileBytes}.`);
  }
  if (bytes.includes(0x0d)) {
    fail(`${file} contains CR bytes; signed presets must be stored with LF line endings.`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    fail(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const parsed = presetSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = formatZodIssues(parsed.error)
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join('\n  ');
    fail(`${file} failed preset validation:\n  ${issues}`);
  }
  const preset = parsed.data;

  if (`${preset.id}.json` !== file) {
    fail(`${file} must be named after its preset id (${preset.id}.json).`);
  }

  let signature: string;
  try {
    signature = (await readFile(`${filePath}.sig`, 'utf8')).trim();
  } catch {
    fail(`${file} has no detached .sig file; unsigned presets cannot be published.`);
  }
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) {
    fail(`${file}.sig is not a 64-byte base64 Ed25519 signature.`);
  }

  const signatureBytes = Buffer.from(signature, 'base64');
  if (signatureBytes.length !== 64) {
    fail(`${file}.sig decodes to ${signatureBytes.length} bytes; expected 64.`);
  }

  const publicKey = createPublicKey(PRESET_SIGNING_PUBLIC_KEY);
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    fail('The pinned preset signing key is not an Ed25519 public key.');
  }
  if (!verify(null, bytes, publicKey, signatureBytes)) {
    fail(`${file}.sig does not verify against the pinned TuneSmith preset key.`);
  }

  return {
    preset,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    signature,
  };
}

function entryFor(
  file: string,
  preset: Preset,
  sha256: string,
  signature: string,
  rawBase: string,
): MarketIndexEntry {
  return {
    id: preset.id,
    name: preset.name,
    version: preset.version,
    author: preset.authors.map((author) => author.handle).join(', ').slice(0, 600),
    description: preset.description,
    hardwareSignature: hardwareSignatureFor(preset),
    sha256,
    signature,
    downloadUrl: `${rawBase}/${encodeURIComponent(file)}`,
    file,
    risk: preset.risk,
    tags: preset.tags,
    license: preset.license,
    profileCount: preset.profiles.length,
    requirements: {
      cpu: preset.compatibility.cpu ?? [],
      gpu: preset.compatibility.gpu ?? [],
      ram: formatRam(preset.compatibility.ramGb),
      storage: preset.compatibility.storage ?? [],
      elevation: preset.requires?.elevation === true,
      restorePoint: preset.requires?.restorePoint ?? null,
    },
  };
}

async function main(): Promise<void> {
  const files = (await readdir(communityDir))
    .filter((file) => file.endsWith('.json') && file !== 'index.json')
    .sort();

  if (files.length === 0) {
    fail(`No preset files found in ${communityDir}.`);
  }

  const repository = repositorySlug();
  const branch = branchName();
  const encodedBranch = branch.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  const rawBase = `https://raw.githubusercontent.com/${repository}/${encodedBranch}/presets/community`;

  const entries: MarketIndexEntry[] = [];
  for (const file of files) {
    const verified = await readVerifiedPreset(file);
    entries.push(entryFor(file, verified.preset, verified.sha256, verified.signature, rawBase));
    console.log(`${verified.sha256.slice(0, 12)}  ${file}`);
  }

  // Deterministic ordering is what lets CI regenerate and diff the file.
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const catalog: MarketIndex = {
    schemaVersion: MARKET_INDEX_SCHEMA_VERSION,
    repository: `https://github.com/${repository}`,
    presets: entries,
  };

  const validated = marketIndexSchema.safeParse(catalog);
  if (!validated.success) {
    const issues = formatZodIssues(validated.error)
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join('\n  ');
    fail(`Generated catalog failed its own schema:\n  ${issues}`);
  }

  const text = `${JSON.stringify(validated.data, null, 2)}\n`;
  const relative = path.relative(root, outPath) || outPath;

  if (checkOnly) {
    let existing: string;
    try {
      existing = await readFile(outPath, 'utf8');
    } catch {
      fail(`${relative} is missing. Run npm run market:index.`);
    }
    if (existing !== text) {
      fail(`${relative} is stale. Run npm run market:index and commit the result.`);
    }
    console.log(`\n${relative} is current: ${entries.length} verified preset(s).`);
    return;
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, text, 'utf8');
  console.log(`\nwrote ${relative} with ${entries.length} verified preset(s)`);
}

await main().catch((error: unknown) => {
  console.error(`market index: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
