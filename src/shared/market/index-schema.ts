/**
 * Public static marketplace index (`market/index.json`).
 *
 * This is the GitHub Pages discovery format. Unlike the in-app signed catalog
 * (`src/shared/market/schema.ts`), an entry carries only the presentation fields plus
 * the raw preset's SHA-256 and detached Ed25519 signature. The signature covers the
 * exact bytes at `downloadUrl`, so a static host can serve the catalog without holding
 * a private key or running a server.
 *
 * The schema is strict: unknown fields, invalid URLs and malformed signatures are
 * rejected before a generator can publish a catalog.
 */
import { z } from 'zod';
import { DRIVE_TYPES, RISK_LEVELS } from '../types';
import { PRESET_ID_RE, RESTORE_POINT_MODES, SEMVER_RE } from '../preset/schema';

export const MARKET_INDEX_SCHEMA_VERSION = 1 as const;

export const MARKET_INDEX_LIMITS = {
  maxPresets: 100,
  maxDownloadUrl: 2048,
} as const;

/** Base64 Ed25519 signatures are 64 bytes, or 88 characters with padding. */
export const ED25519_BASE64_RE = /^[A-Za-z0-9+/]{86}==$/;
export const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

export function isRawPresetDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'raw.githubusercontent.com') return false;
    if (url.username.length > 0 || url.password.length > 0 || url.port.length > 0) return false;
    return /\/presets\/community\/[a-z0-9][a-z0-9-]*\.json$/.test(url.pathname);
  } catch {
    return false;
  }
}

const repositoryUrlSchema = z
  .string()
  .max(300)
  .refine(
    (value) => /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value),
    'must be a GitHub repository URL',
  );

const rangeSchema = z
  .strictObject({
    min: z.number().int().min(0).max(4096).optional(),
    max: z.number().int().min(0).max(4096).optional(),
  })
  .refine((range) => range.min === undefined || range.max === undefined || range.min <= range.max, {
    message: 'min must not exceed max',
  });

export const marketIndexRequirementsSchema = z.strictObject({
  cpu: z.array(z.string().min(1).max(64)).max(24),
  gpu: z.array(z.string().min(1).max(64)).max(24),
  /** Human-readable RAM tier, e.g. `≥ 16 GB`; null when unconstrained. */
  ram: z.string().min(1).max(80).nullable(),
  storage: z.array(z.enum(DRIVE_TYPES)).max(3),
  elevation: z.boolean(),
  restorePoint: z.enum(RESTORE_POINT_MODES).nullable(),
});

export type MarketIndexRequirements = z.infer<typeof marketIndexRequirementsSchema>;

export const marketIndexEntrySchema = z.strictObject({
  id: z.string().regex(PRESET_ID_RE),
  name: z.string().min(3).max(80),
  version: z.string().regex(SEMVER_RE),
  author: z.string().min(1).max(600),
  description: z.string().min(10).max(2000),
  /** Human summary of the compatibility selector, or `universal`. */
  hardwareSignature: z.string().min(1).max(600),
  sha256: z.string().regex(SHA256_HEX_RE),
  /** Base64 Ed25519 signature over the exact bytes at `downloadUrl`. */
  signature: z.string().regex(ED25519_BASE64_RE),
  downloadUrl: z
    .string()
    .max(MARKET_INDEX_LIMITS.maxDownloadUrl)
    .refine(isRawPresetDownloadUrl, 'must be a raw.githubusercontent.com preset URL'),
  file: z.string().max(200).regex(/^[a-z0-9][a-z0-9-]*\.json$/),
  risk: z.enum(RISK_LEVELS),
  tags: z.array(z.string().regex(/^[a-z0-9-]{1,24}$/)).max(8),
  license: z.string().min(1).max(40),
  profileCount: z.number().int().min(1).max(12),
  requirements: marketIndexRequirementsSchema,
});

export type MarketIndexEntry = z.infer<typeof marketIndexEntrySchema>;

export const marketIndexSchema = z
  .strictObject({
    schemaVersion: z.literal(MARKET_INDEX_SCHEMA_VERSION),
    repository: repositoryUrlSchema,
    presets: z.array(marketIndexEntrySchema).min(1).max(MARKET_INDEX_LIMITS.maxPresets),
  })
  .superRefine((catalog, ctx) => {
    const ids = new Set<string>();
    const files = new Set<string>();
    catalog.presets.forEach((entry, index) => {
      if (ids.has(entry.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['presets', index, 'id'],
          message: `Duplicate preset id "${entry.id}".`,
        });
      }
      ids.add(entry.id);

      if (files.has(entry.file)) {
        ctx.addIssue({
          code: 'custom',
          path: ['presets', index, 'file'],
          message: `Duplicate preset file "${entry.file}".`,
        });
      }
      files.add(entry.file);
    });
  });

export type MarketIndex = z.infer<typeof marketIndexSchema>;

export { rangeSchema as marketIndexRangeSchema };
