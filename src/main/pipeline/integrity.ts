/**
 * Integrity gate: SHA-256 already passed, now prove authorship.
 *
 * The digest in `index.json` is integrity, not provenance: whoever can rewrite a preset
 * can rewrite the digest beside it. This gate requires a detached Ed25519 signature over
 * the exact preset bytes, produced by the private key matching the pinned public key in
 * `src/main/security/keys.ts`.
 *
 * Signature sources, in order:
 *   1. a sibling `<preset>.json.sig` file (base64, one line)
 *   2. a `signature` field on the preset's `index.json` entry
 *
 * Every failure here is `ERR_INVALID_SIGNATURE`; the loader reports it before the preset
 * reaches the Zod structural gate, so malformed or unsigned bytes are never parsed as a
 * preset.
 */
import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PRESET_SIGNING_PUBLIC_KEY } from '../security/keys';

/** Distinct code required when authenticity cannot be established. */
export const SIGNATURE_ERROR_CODE = 'ERR_INVALID_SIGNATURE' as const;

const MAX_SIGNATURE_FILE_BYTES = 512;
/** Ed25519 signatures are 64 bytes, i.e. 88 base64 characters with padding. */
const SIGNATURE_BASE64_RE = /^[A-Za-z0-9+/]{86}==$/;

export type SignatureFailureReason = 'missing' | 'malformed' | 'invalid';

export type PresetSignatureCheck =
  | { ok: true }
  | { ok: false; reason: SignatureFailureReason; message: string };

export interface PresetSignatureOptions {
  filePath: string;
  bytes: Uint8Array;
  /** Test/injection seam; production always uses the pinned constant. */
  publicKey?: string;
  /** Optional signature carried by the manifest entry instead of a `.sig` file. */
  manifestSignature?: string;
}

function decodeSignature(text: string): Buffer | null {
  const trimmed = text.trim();
  if (!SIGNATURE_BASE64_RE.test(trimmed)) return null;
  const signature = Buffer.from(trimmed, 'base64');
  return signature.length === 64 ? signature : null;
}

/** Reads `<file>.sig`, enforcing a hard size cap before parsing anything. */
async function readSignatureFile(filePath: string): Promise<string | null> {
  try {
    const raw = await readFile(`${filePath}.sig`, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > MAX_SIGNATURE_FILE_BYTES) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function verifyPresetSignature(
  options: PresetSignatureOptions,
): Promise<PresetSignatureCheck> {
  let encoded: string | undefined = options.manifestSignature;
  if (encoded === undefined) {
    const fileSignature = await readSignatureFile(options.filePath);
    if (fileSignature === null) {
      return {
        ok: false,
        reason: 'missing',
        message: 'No .sig file or manifest signature accompanies this preset.',
      };
    }
    encoded = fileSignature;
  }

  const signature = decodeSignature(encoded);
  if (signature === null) {
    return {
      ok: false,
      reason: 'malformed',
      message: 'The preset signature is not a valid base64-encoded Ed25519 signature.',
    };
  }

  try {
    const key = createPublicKey(options.publicKey ?? PRESET_SIGNING_PUBLIC_KEY);
    if (key.asymmetricKeyType !== 'ed25519') {
      return { ok: false, reason: 'invalid', message: 'The pinned preset key is not an Ed25519 key.' };
    }
    if (!verify(null, options.bytes, key, signature)) {
      return {
        ok: false,
        reason: 'invalid',
        message: 'The preset signature does not verify against the pinned public key.',
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      reason: 'invalid',
      message: 'The preset signature could not be verified with the pinned public key.',
    };
  }
}
