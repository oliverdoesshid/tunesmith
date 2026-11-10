/**
 * Catalog validation.
 *
 * Bounds are deliberately tight: a catalog is fetched from the network and parsed before
 * anything else touches it, so entries, string sizes and numbers are capped here rather
 * than trusted and checked later.
 */
import { z } from 'zod';
import { PRESET_LIMITS, presetSchema } from '../preset/schema';

export const MARKET_LIMITS = {
  maxEntries: 100,
  maxComparisons: 1_000_000,
  maxTextBytes: 2 * 1024 * 1024,
  maxFutureSkewMs: 24 * 60 * 60 * 1000,
} as const;

const isoDate = z
  .string()
  .min(20)
  .max(40)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);

const signatureSchema = z.strictObject({
  keyId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/),
  sig: z
    .string()
    .min(80)
    .max(120)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

const ratingsSchema = z.strictObject({
  up: z.number().int().min(0).max(MARKET_LIMITS.maxComparisons),
  down: z.number().int().min(0).max(MARKET_LIMITS.maxComparisons),
  crashes: z.number().int().min(0).max(MARKET_LIMITS.maxComparisons),
  recoveries: z.number().int().min(0).max(MARKET_LIMITS.maxComparisons),
});

export const marketEntrySchema = z.strictObject({
  preset: presetSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  signature: signatureSchema,
  ratings: ratingsSchema,
  publishedAt: isoDate,
});

export const marketCatalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generatedAt: isoDate,
  entries: z.array(marketEntrySchema).min(1).max(MARKET_LIMITS.maxEntries),
});

export const marketEnvelopeSchema = z.strictObject({
  catalog: marketCatalogSchema,
  signature: signatureSchema,
});

export type MarketEnvelopeInput = z.infer<typeof marketEnvelopeSchema>;

/** The payload signed by the curator: sha256 hex of the canonical preset for entries. */
export function entrySigningPayload(sha256: string): string {
  return `tunesmith-entry-v1:${sha256}`;
}

/** The payload signed by the catalog publisher. */
export function catalogSigningPayload(canonicalCatalog: string): string {
  return `tunesmith-catalog-v1:${canonicalCatalog}`;
}

export { PRESET_LIMITS };
