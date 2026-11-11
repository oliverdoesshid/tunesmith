/**
 * Integrity-gate tests: SHA-256 is not provenance.
 *
 * Every fixture here updates the index digest after tampering, so the digest check passes
 * and only the Ed25519 signature can catch the change.
 */
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PRESET_SIGNING_PUBLIC_KEY } from '../src/main/security/keys';
import { verifyPresetSignature } from '../src/main/pipeline/integrity';
import {
  loadPresetDirectory,
  loadPresetFile,
  sha256Hex,
  type PresetIndexEntry,
} from '../src/shared/preset/loader';
import { makePreset } from '../tests/factories';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const OTHER_KEYS = generateKeyPairSync('ed25519');

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tunesmith-sig-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function presetText(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(makePreset({ id, ...extra }), null, 2);
}

function signatureFor(bytes: string, key = privateKey): string {
  return sign(null, Buffer.from(bytes, 'utf8'), key).toString('base64');
}

function indexEntry(file: string, id: string, text: string, signature?: string): PresetIndexEntry {
  return {
    file,
    id,
    version: '1.0.0',
    sha256: sha256Hex(Buffer.from(text, 'utf8')),
    ...(signature !== undefined ? { signature } : {}),
  };
}

describe('pinned preset key', () => {
  it('is a valid Ed25519 public key, not a placeholder', () => {
    const key = createPublicKey(PRESET_SIGNING_PUBLIC_KEY);
    expect(key.asymmetricKeyType).toBe('ed25519');
  });
});

describe('integrity gate signature check', () => {
  it('accepts a preset with a valid detached .sig file', async () => {
    const dir = await tempDir();
    const text = presetText('signed-preset');
    const file = path.join(dir, 'signed.json');
    await writeFile(file, text, 'utf8');
    await writeFile(`${file}.sig`, `${signatureFor(text)}\n`, 'utf8');

    const result = await loadPresetFile(file, indexEntry('signed.json', 'signed-preset', text), true, {
      requireSignature: true,
      publicKey: PUBLIC_PEM,
    });

    expect(result.failure).toBeNull();
    expect(result.preset?.preset.id).toBe('signed-preset');
    expect(result.preset?.trust).toBe('bundled-verified');
  });

  it('accepts a signature carried by the manifest entry', async () => {
    const dir = await tempDir();
    const text = presetText('manifest-signed');
    const file = path.join(dir, 'manifest.json');
    await writeFile(file, text, 'utf8');
    const entry = indexEntry('manifest.json', 'manifest-signed', text, signatureFor(text));

    const result = await loadPresetFile(file, entry, true, {
      requireSignature: true,
      publicKey: PUBLIC_PEM,
    });

    expect(result.failure).toBeNull();
    expect(result.preset?.preset.id).toBe('manifest-signed');
  });

  it('rejects a tampered payload even when the index digest was rewritten to match', async () => {
    const dir = await tempDir();
    const original = presetText('tampered-preset');
    const tampered = presetText('tampered-preset', { description: 'A tampered description that differs from signing time.' });
    const file = path.join(dir, 'tampered.json');
    await writeFile(file, original, 'utf8');
    await writeFile(`${file}.sig`, `${signatureFor(original)}\n`, 'utf8');
    await writeFile(file, tampered, 'utf8');

    const result = await loadPresetFile(file, indexEntry('tampered.json', 'tampered-preset', tampered), true, {
      requireSignature: true,
      publicKey: PUBLIC_PEM,
    });

    expect(result.preset).toBeNull();
    expect(result.failure?.code).toBe('ERR_INVALID_SIGNATURE');
    expect(result.failure?.message).toContain('does not verify');
  });

  it('rejects a preset with no signature at all', async () => {
    const dir = await tempDir();
    const text = presetText('unsigned-preset');
    const file = path.join(dir, 'unsigned.json');
    await writeFile(file, text, 'utf8');

    const result = await loadPresetFile(file, indexEntry('unsigned.json', 'unsigned-preset', text), true, {
      requireSignature: true,
      publicKey: PUBLIC_PEM,
    });

    expect(result.preset).toBeNull();
    expect(result.failure?.code).toBe('ERR_INVALID_SIGNATURE');
    expect(result.failure?.message).toContain('No .sig file');
  });

  it('rejects a malformed signature', async () => {
    const dir = await tempDir();
    const text = presetText('malformed-preset');
    const file = path.join(dir, 'malformed.json');
    await writeFile(file, text, 'utf8');
    await writeFile(`${file}.sig`, 'this is not base64!\n', 'utf8');

    const result = await loadPresetFile(file, indexEntry('malformed.json', 'malformed-preset', text), true, {
      requireSignature: true,
      publicKey: PUBLIC_PEM,
    });

    expect(result.preset).toBeNull();
    expect(result.failure?.code).toBe('ERR_INVALID_SIGNATURE');
    expect(result.failure?.message).toContain('not a valid base64');
  });

  it('rejects a signature from the wrong key', async () => {
    const dir = await tempDir();
    const text = presetText('wrong-key');
    const file = path.join(dir, 'wrong-key.json');
    await writeFile(file, text, 'utf8');
    await writeFile(`${file}.sig`, signatureFor(text, OTHER_KEYS.privateKey), 'utf8');

    const result = await loadPresetFile(file, indexEntry('wrong-key.json', 'wrong-key', text), true, {
      requireSignature: true,
      publicKey: PUBLIC_PEM,
    });

    expect(result.failure?.code).toBe('ERR_INVALID_SIGNATURE');
  });

  it('runs before the Structural Zod gate', async () => {
    const dir = await tempDir();
    // Not JSON at all: if the loader parsed first, this would be `parse`, not a signature failure.
    const text = '{ not valid json';
    const file = path.join(dir, 'broken.json');
    await writeFile(file, text, 'utf8');

    const result = await loadPresetFile(file, indexEntry('broken.json', 'broken-preset', text), true, {
      requireSignature: true,
      publicKey: PUBLIC_PEM,
    });

    expect(result.failure?.code).toBe('ERR_INVALID_SIGNATURE');
    expect(result.failure?.code).not.toBe('parse');
  });

  it('exposes the check directly for callers that already have the bytes', async () => {
    const bytes = Buffer.from('preset bytes', 'utf8');
    const valid = await verifyPresetSignature({ filePath: 'unused.json', bytes, publicKey: PUBLIC_PEM, manifestSignature: signatureFor('preset bytes') });
    expect(valid.ok).toBe(true);

    const missing = await verifyPresetSignature({ filePath: path.join(os.tmpdir(), 'definitely-absent.json'), bytes, publicKey: PUBLIC_PEM });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('missing');
  });
});

describe('directory enforcement', () => {
  it('rejects unsigned files in a signed bundle and keeps signed ones', async () => {
    const dir = await tempDir();
    const signedText = presetText('signed-preset');
    const unsignedText = presetText('unsigned-preset');
    await writeFile(path.join(dir, 'a.json'), signedText, 'utf8');
    await writeFile(path.join(dir, 'a.json.sig'), `${signatureFor(signedText)}\n`, 'utf8');
    await writeFile(path.join(dir, 'b.json'), unsignedText, 'utf8');

    await writeFile(
      path.join(dir, 'index.json'),
      JSON.stringify({
        schemaVersion: 1,
        generatedBy: 'scripts/hash-presets.mjs',
        presets: [
          indexEntry('a.json', 'signed-preset', signedText),
          indexEntry('b.json', 'unsigned-preset', unsignedText),
        ],
      }),
      'utf8',
    );

    const result = await loadPresetDirectory(dir, { requireSignatures: true, publicKey: PUBLIC_PEM });
    expect(result.presets.map((preset) => preset.preset.id)).toEqual(['signed-preset']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.file).toBe('b.json');
    expect(result.failures[0]?.code).toBe('ERR_INVALID_SIGNATURE');
  });

  it('verifies the shipped library with the pinned constant key', async () => {
    const dir = path.resolve(process.cwd(), 'presets/community');
    const result = await loadPresetDirectory(dir, { requireSignatures: true });

    expect(result.failures).toEqual([]);
    expect(result.presets.length).toBeGreaterThanOrEqual(4);
    expect(result.presets.every((preset) => preset.trust === 'bundled-verified')).toBe(true);
  });
});
