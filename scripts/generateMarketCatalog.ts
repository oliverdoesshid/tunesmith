#!/usr/bin/env node
/**
 * Generate the signed in-app marketplace catalog.
 *
 * The app fetches `market/catalog.json` and verifies:
 *   1. the catalog envelope's Ed25519 signature over `tunesmith-catalog-v1:` + canonical JSON;
 *   2. each entry's SHA-256 over the canonical preset and its Ed25519 signature over
 *      `tunesmith-entry-v1:<sha256>`.
 *
 * This script builds that envelope from `presets/community/`, using the same offline
 * publisher key that signs the bundled presets. It refuses to run with a key that does not
 * match the pinned public key in `src/main/security/keys.ts`, so a catalog can never claim
 * a trust root the app does not already ship.
 *
 * Usage:
 *   npm run market:catalog -- --key tmp/preset-signing-key.pem
 *   npm run market:catalog:check
 *
 * `--check` verifies the committed catalog against the current presets and the pinned key
 * without needing the private key. CI runs it before deploying the Pages artifact.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify as cryptoVerify } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '../src/shared/market/canonical';
import {
  catalogSigningPayload,
  entrySigningPayload,
  marketEnvelopeSchema,
  type MarketEnvelopeInput,
} from '../src/shared/market/schema';
import { PRESET_SIGNING_KEY_ID, PRESET_SIGNING_PUBLIC_KEY } from '../src/main/security/keys';
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

const outPath = path.resolve(root, arg('out') ?? 'market/catalog.json');

function fail(message: string): never {
  throw new Error(message);
}

function issueList(error: Parameters<typeof formatZodIssues>[0]): string {
  return formatZodIssues(error)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('\n  ');
}

async function readPreset(file: string): Promise<Preset> {
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
    fail(`${file} failed preset validation:\n  ${issueList(parsed.error)}`);
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

  const publicKey = createPublicKey(PRESET_SIGNING_PUBLIC_KEY);
  if (!cryptoVerify(null, bytes, publicKey, Buffer.from(signature, 'base64'))) {
    fail(`${file}.sig does not verify against the pinned Tunesmith preset key.`);
  }

  return preset;
}

async function readExisting(): Promise<MarketEnvelopeInput | null> {
  let text: string;
  try {
    text = await readFile(outPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    fail(`${path.relative(root, outPath)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = marketEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    fail(`${path.relative(root, outPath)} is not a signed catalog envelope:\n  ${issueList(parsed.error)}`);
  }
  return parsed.data;
}

function entryPayload(sha256: string): string {
  return entrySigningPayload(sha256);
}

function verifyPinned(payload: string, signature: string): boolean {
  return cryptoVerify(
    null,
    Buffer.from(payload, 'utf8'),
    createPublicKey(PRESET_SIGNING_PUBLIC_KEY),
    Buffer.from(signature, 'base64'),
  );
}

interface EntryPlan {
  preset: Preset;
  sha256: string;
  ratings: MarketEnvelopeInput['catalog']['entries'][number]['ratings'];
  publishedAt: string;
}

async function main(): Promise<void> {
  const files = (await readdir(communityDir))
    .filter((file) => file.endsWith('.json') && file !== 'index.json')
    .sort();
  if (files.length === 0) fail(`No preset files found in ${communityDir}.`);

  const presets: Preset[] = [];
  for (const file of files) presets.push(await readPreset(file));
  presets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const existing = await readExisting();
  const generatedAt =
    arg('generated-at') ?? existing?.catalog.generatedAt ?? new Date().toISOString();

  const plans: EntryPlan[] = presets.map((preset) => {
    const sha256 = createHash('sha256').update(canonicalJson(preset), 'utf8').digest('hex');
    const previous = existing?.catalog.entries.find(
      (entry) => entry.preset.id === preset.id && entry.sha256 === sha256,
    );
    const byId = existing?.catalog.entries.find((entry) => entry.preset.id === preset.id);
    return {
      preset,
      sha256,
      ratings: byId?.ratings ?? { up: 0, down: 0, crashes: 0, recoveries: 0 },
      publishedAt: previous?.publishedAt ?? generatedAt,
    };
  });

  if (checkOnly) {
    if (existing === null) fail(`${path.relative(root, outPath)} is missing. Run npm run market:catalog.`);

    const catalogPayload = catalogSigningPayload(canonicalJson(existing.catalog));
    if (
      existing.signature.keyId !== PRESET_SIGNING_KEY_ID ||
      !verifyPinned(catalogPayload, existing.signature.sig)
    ) {
      fail(`${path.relative(root, outPath)} does not verify against the pinned publisher key.`);
    }

    if (existing.catalog.entries.length !== plans.length) {
      fail(
        `${path.relative(root, outPath)} has ${existing.catalog.entries.length} entries; ${plans.length} verified presets are present. Run npm run market:catalog.`,
      );
    }

    for (const [index, plan] of plans.entries()) {
      const actual = existing.catalog.entries[index];
      if (actual === undefined) fail(`Missing catalog entry for ${plan.preset.id}.`);
      if (actual.signature.keyId !== PRESET_SIGNING_KEY_ID) {
        fail(`${plan.preset.id} is signed by ${actual.signature.keyId}, not the pinned publisher key.`);
      }
      if (!verifyPinned(entryPayload(plan.sha256), actual.signature.sig)) {
        fail(`${plan.preset.id} entry signature does not verify against the pinned publisher key.`);
      }
      if (canonicalJson(actual.preset) !== canonicalJson(plan.preset)) {
        fail(`${plan.preset.id} in ${path.relative(root, outPath)} is stale. Run npm run market:catalog.`);
      }
      if (actual.sha256 !== plan.sha256) {
        fail(`${plan.preset.id} has a stale SHA-256. Run npm run market:catalog.`);
      }
      if (
        actual.ratings.up !== plan.ratings.up ||
        actual.ratings.down !== plan.ratings.down ||
        actual.ratings.crashes !== plan.ratings.crashes ||
        actual.ratings.recoveries !== plan.ratings.recoveries
      ) {
        fail(`${plan.preset.id} ratings changed in ${path.relative(root, outPath)}.`);
      }
      if (actual.publishedAt !== plan.publishedAt) {
        fail(`${plan.preset.id} publishedAt is stale. Run npm run market:catalog.`);
      }
    }

    console.log(
      `\n${path.relative(root, outPath)} verifies against the pinned publisher key: ${plans.length} entry(ies).`,
    );
    return;
  }

  const keyPath = arg('key');
  if (keyPath === undefined) {
    fail('A signing key is required. Pass --key tmp/preset-signing-key.pem.');
  }
  const privateKey = await (async () => {
    try {
      const key = createPrivateKey(await readFile(path.resolve(root, keyPath), 'utf8'));
      if (key.asymmetricKeyType !== 'ed25519') fail('The signing key is not an Ed25519 private key.');
      const derived = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString().trim();
      if (derived !== PRESET_SIGNING_PUBLIC_KEY.trim()) {
        fail('The signing key does not match the pinned publisher key in src/main/security/keys.ts.');
      }
      return key;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('The signing key')) throw error;
      fail(`Could not read the signing key: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();

  const entries: MarketEnvelopeInput['catalog']['entries'] = plans.map((plan) => ({
    preset: plan.preset,
    sha256: plan.sha256,
    signature: {
      keyId: PRESET_SIGNING_KEY_ID,
      sig: sign(null, Buffer.from(entryPayload(plan.sha256), 'utf8'), privateKey).toString('base64'),
    },
    ratings: plan.ratings,
    publishedAt: plan.publishedAt,
  }));

  const catalog = { schemaVersion: 1 as const, generatedAt, entries };
  const envelope = {
    catalog,
    signature: {
      keyId: PRESET_SIGNING_KEY_ID,
      sig: sign(null, Buffer.from(catalogSigningPayload(canonicalJson(catalog)), 'utf8'), privateKey).toString(
        'base64',
      ),
    },
  };

  const validated = marketEnvelopeSchema.safeParse(envelope);
  if (!validated.success) {
    fail(`Generated catalog failed its own schema:\n  ${issueList(validated.error)}`);
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(validated.data, null, 2)}\n`, 'utf8');
  console.log(
    `\nwrote ${path.relative(root, outPath)} with ${entries.length} signed entry(ies), key ${PRESET_SIGNING_KEY_ID}`,
  );
}

await main().catch((error: unknown) => {
  console.error(`market catalog: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
