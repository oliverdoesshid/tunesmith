/**
 * Ed25519 verification and the trust store.
 *
 * Only SPKI (`BEGIN PUBLIC KEY`) Ed25519 keys are accepted. The key ring comes from
 * `TUNESMITH_MARKET_KEYS`, a JSON object of `{ "key-id": "-----BEGIN PUBLIC KEY-----..." }`.
 * A shipped build with no key ring is intentionally incapable of trusting a catalog:
 * an empty trust store must not mean "trust everything".
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

const KEY_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const MAX_KEYS = 8;
const MAX_PEM_BYTES = 2_000;

export function isValidEd25519PublicKey(pem: string): boolean {
  try {
    const key = createPublicKey(pem);
    return key.asymmetricKeyType === 'ed25519' && !key.export({ format: 'pem', type: 'spki' }).toString().includes('PRIVATE');
  } catch {
    return false;
  }
}

/** Parse the env-supplied key ring. Malformed entries are dropped, never guessed at. */
export function loadTrustedKeys(raw: string | undefined): Map<string, string> {
  const keys = new Map<string, string>();
  if (raw === undefined || raw.trim().length === 0) return keys;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[market] TUNESMITH_MARKET_KEYS is not valid JSON; no keys trusted.');
    return keys;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return keys;

  for (const [keyId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (keys.size >= MAX_KEYS) break;
    if (!KEY_ID_RE.test(keyId) || typeof value !== 'string') continue;
    if (Buffer.byteLength(value, 'utf8') > MAX_PEM_BYTES) continue;
    if (!isValidEd25519PublicKey(value)) {
      console.warn(`[market] key ${keyId} is not an Ed25519 public key; ignored.`);
      continue;
    }
    keys.set(keyId, value);
  }
  return keys;
}

/** True for a valid Ed25519 signature over `payload` with `pem`. Never throws. */
export function verifyEd25519(payload: string, sigBase64: string, pem: string): boolean {
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const signature = Buffer.from(sigBase64, 'base64');
    if (signature.length !== 64) return false;
    return cryptoVerify(null, Buffer.from(payload, 'utf8'), key, signature);
  } catch {
    return false;
  }
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
