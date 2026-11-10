/**
 * Catalog fetching and verification.
 *
 * The network is untrusted end to end: the body is size-capped before parsing, every
 * field is schema-checked, the catalog signature must verify against a pinned key, and
 * every entry must match its published digest and carry a curator signature. An entry
 * that fails any check is excluded from the browser, not shown with a warning badge.
 */
import { TuneSmithError } from '../../shared/errors';
import { canonicalJson } from '../../shared/market/canonical';
import {
  catalogSigningPayload,
  entrySigningPayload,
  MARKET_LIMITS,
  marketEnvelopeSchema,
} from '../../shared/market/schema';
import type { MarketEntry } from '../../shared/market/types';
import { sha256Hex, verifyEd25519 } from './verify';

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface VerifiedEntry {
  entry: MarketEntry;
  canonical: string;
  sha256: string;
}

export interface CatalogResult {
  entries: VerifiedEntry[];
  rejected: { id: string | null; reason: string }[];
  fetchedAt: string;
}

export interface CatalogSource {
  url: string;
  keyRing: Map<string, string>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

function keyFor(keyRing: Map<string, string>, keyId: string, what: string): string {
  const pem = keyRing.get(keyId);
  if (pem === undefined) {
    throw new TuneSmithError('integrity-failed', `The ${what} is signed by an unknown key (${keyId}).`);
  }
  return pem;
}

export async function fetchVerifiedCatalog(source: CatalogSource): Promise<CatalogResult> {
  // Config validation already restricts the scheme; re-check here so a caller cannot
  // hand this function an unvalidated URL.
  const url = new URL(source.url);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new TuneSmithError('invalid-request', 'The marketplace URL must use HTTPS.');
  }

  const fetchImpl: FetchLike = source.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = source.timeoutMs ?? 8_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let body: string;
  try {
    const response = await fetchImpl(source.url, { signal: controller.signal });
    if (!response.ok) {
      throw new TuneSmithError('unavailable', `The marketplace answered HTTP ${response.status}.`);
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MARKET_LIMITS.maxTextBytes) {
      throw new TuneSmithError('integrity-failed', 'The marketplace response is larger than the allowed 2 MiB.');
    }
    body = await response.text();
  } catch (error) {
    if (error instanceof TuneSmithError) throw error;
    const reason = controller.signal.aborted ? 'timed out' : error instanceof Error ? error.message : String(error);
    throw new TuneSmithError('unavailable', `Could not reach the marketplace (${reason}).`);
  } finally {
    clearTimeout(timer);
  }

  if (Buffer.byteLength(body, 'utf8') > MARKET_LIMITS.maxTextBytes) {
    throw new TuneSmithError('integrity-failed', 'The marketplace response is larger than the allowed 2 MiB.');
  }

  let envelopeRaw: unknown;
  try {
    envelopeRaw = JSON.parse(body);
  } catch {
    throw new TuneSmithError('parse-failed', 'The marketplace returned malformed JSON.');
  }

  const envelope = marketEnvelopeSchema.safeParse(envelopeRaw);
  if (!envelope.success) {
    throw new TuneSmithError('parse-failed', 'The marketplace catalog failed validation.');
  }

  const catalogPem = keyFor(source.keyRing, envelope.data.signature.keyId, 'catalog');
  const catalogPayload = catalogSigningPayload(canonicalJson(envelope.data.catalog));
  if (!verifyEd25519(catalogPayload, envelope.data.signature.sig, catalogPem)) {
    throw new TuneSmithError('integrity-failed', 'The marketplace catalog signature does not verify.');
  }

  const entries: VerifiedEntry[] = [];
  const rejected: { id: string | null; reason: string }[] = [];
  const seen = new Set<string>();

  for (const entry of envelope.data.catalog.entries) {
    const id = entry.preset.id;
    const canonical = canonicalJson(entry.preset);
    const digest = sha256Hex(canonical);

    if (digest !== entry.sha256) {
      rejected.push({ id, reason: 'Digest mismatch: the preset does not match the published hash.' });
      continue;
    }
    let pem: string;
    try {
      pem = keyFor(source.keyRing, entry.signature.keyId, `preset ${id}`);
    } catch (error) {
      rejected.push({ id, reason: error instanceof TuneSmithError ? error.message : 'Unknown key.' });
      continue;
    }
    if (!verifyEd25519(entrySigningPayload(entry.sha256), entry.signature.sig, pem)) {
      rejected.push({ id, reason: 'Signature does not verify for this preset hash.' });
      continue;
    }
    if (seen.has(id)) {
      rejected.push({ id, reason: 'Duplicate preset id in the catalog.' });
      continue;
    }
    seen.add(id);
    entries.push({ entry, canonical, sha256: digest });
  }

  return { entries, rejected, fetchedAt: new Date().toISOString() };
}
