/**
 * Marketplace wire types.
 *
 * Everything in a catalog is untrusted until `src/main/market` verifies it. The browser
 * never sees an entry that failed verification, so the renderer can treat these fields as
 * display data only — never as a reason to skip review or consent.
 */
import type { Preset } from '../preset/schema';

export interface MarketSignature {
  /** Identifier of the public key that produced `sig`. */
  keyId: string;
  /** Base64 Ed25519 signature over the canonical signed payload. */
  sig: string;
}

export interface MarketRatings {
  up: number;
  down: number;
  crashes: number;
  recoveries: number;
}

export interface MarketEntry {
  preset: Preset;
  /** sha256 of the canonical JSON of `preset`. */
  sha256: string;
  /** Curator signature over `sha256`. */
  signature: MarketSignature;
  ratings: MarketRatings;
  publishedAt: string;
}

export interface MarketCatalog {
  schemaVersion: 1;
  generatedAt: string;
  entries: MarketEntry[];
}

/** The file a publisher hosts: the catalog plus a signature over its canonical JSON. */
export interface MarketEnvelope {
  catalog: MarketCatalog;
  signature: MarketSignature;
}

export type MarketTrust = 'verified' | 'untrusted-key' | 'invalid-signature' | 'digest-mismatch';

export interface SafetyScore {
  /** 0..100. */
  score: number;
  label: 'safe' | 'good' | 'caution' | 'risky';
  reasons: string[];
}

export interface TelemetryStats {
  applies: number;
  failed: number;
  interrupted: number;
  recovered: number;
  /** interrupted / applies, 0 when there is not enough data. */
  crashRate: number;
  /** recovered / interrupted, 0 when no crashes were reported. */
  recoveryRate: number;
}

export interface MarketEntryView {
  id: string;
  version: string;
  name: string;
  description: string;
  risk: Preset['risk'];
  tags: string[];
  authors: string[];
  license: string;
  sha256: string;
  publishedAt: string;
  ratings: MarketRatings;
  safety: SafetyScore;
  stats: TelemetryStats;
  installedVersion: string | null;
  updateAvailable: boolean;
}

export interface MarketStatus {
  configured: boolean;
  source: string | null;
  fetchedAt: string | null;
  error: string | null;
  rejected: { id: string | null; reason: string }[];
  entries: MarketEntryView[];
  telemetry: {
    consent: boolean;
    pending: number;
    uploadConfigured: boolean;
    lastUploadAt: string | null;
    lastUploadError: string | null;
  };
}

export interface InstallResult {
  presetId: string;
  version: string;
  file: string;
  sha256: string;
}
