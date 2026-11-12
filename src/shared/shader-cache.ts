/**
 * Shader-cache health DTOs and the closed set of cache roots.
 *
 * The renderer never supplies a filesystem path. It receives read-only summaries and can
 * ask main to prune only the DirectX cache, where the cache's own SQLite metadata makes an
 * orphan determination possible. Vendor driver caches are hashed and opaque, so they are
 * inventoried but never guessed at or deleted here.
 */

export const SHADER_CACHE_IDS = [
  'directx',
  'nvidia-dx',
  'nvidia-gl',
  'nvidia-vk',
  'amd-dx',
  'amd-dxc',
  'amd-gl',
  'amd-vk',
] as const;

export type ShaderCacheId = (typeof SHADER_CACHE_IDS)[number];
export type ShaderCacheProvider = 'directx' | 'nvidia' | 'amd';
export type ShaderCacheOrphanSupport = 'metadata' | 'opaque';

export interface ShaderCacheTotals {
  fileCount: number;
  totalBytes: number;
  orphanedFiles: number;
  orphanedBytes: number;
}

export interface ShaderCacheRootStatus {
  id: ShaderCacheId;
  label: string;
  provider: ShaderCacheProvider;
  /** Display-only path. Never accepted back as a request parameter. */
  displayPath: string;
  exists: boolean;
  readable: boolean;
  orphanSupport: ShaderCacheOrphanSupport;
  fileCount: number;
  totalBytes: number;
  /** Whole DirectX cache files whose every recorded executable is gone. */
  orphanedFileCount: number;
  orphanedBytes: number;
  newestMtimeMs: number | null;
  warnings: string[];
}

export interface ShaderCacheStatus {
  schemaVersion: 1;
  /** Null before the first scan. */
  scannedAt: string | null;
  roots: ShaderCacheRootStatus[];
  totals: ShaderCacheTotals;
  warnings: string[];
  error: string | null;
}

export interface ShaderCachePruneRequest {
  /** Only the DirectX root has metadata that can prove an entry is orphaned. */
  cacheIds: ShaderCacheId[];
  /** Explicit second confirmation; the renderer asks again before sending this. */
  confirm: true;
}

export interface ShaderCachePruneResult {
  /** True when every candidate encountered was handled without an unexpected failure. */
  ok: boolean;
  removedFiles: number;
  removedBytes: number;
  skippedFiles: number;
  warnings: string[];
  message: string;
  /** Fresh inventory after the deletion attempt. */
  status: ShaderCacheStatus;
}
