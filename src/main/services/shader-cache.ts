/**
 * DirectX / GPU driver shader-cache health.
 *
 * Safety model:
 *   - only fixed, per-user cache roots are scanned; no renderer path ever reaches this file;
 *   - DirectX `.dxcache` files are SQLite databases with an `app_id` table. A whole cache
 *     file is called orphaned only when every executable it records is gone. A file with
 *     one live app is left alone, because deleting it would discard valid pipelines;
 *   - NVIDIA/AMD caches are hashed driver blobs with no game mapping. They are inventoried
 *     read-only and are never deleted by this service;
 *   - pruning re-checks the file and its metadata immediately before unlinking it, only
 *     removes regular files, never follows symlinks, and skips files touched in the last
 *     24 hours.
 */
import { lstat, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TuneSmithError } from '../../shared/errors';
import type {
  ShaderCacheId,
  ShaderCacheOrphanSupport,
  ShaderCachePruneResult,
  ShaderCacheProvider,
  ShaderCacheRootStatus,
  ShaderCacheStatus,
} from '../../shared/shader-cache';

export interface ShaderCacheRootDefinition {
  id: ShaderCacheId;
  label: string;
  provider: ShaderCacheProvider;
  path: string;
  orphanSupport: ShaderCacheOrphanSupport;
}

export interface ShaderCacheOptions {
  /** Injectable roots for tests; production uses `defaultShaderCacheRoots()`. */
  roots?: readonly ShaderCacheRootDefinition[];
  now?: () => Date;
  minOrphanAgeMs?: number;
  cacheTtlMs?: number;
  maxFilesPerRoot?: number;
  isExecutablePresent?: (executablePath: string) => Promise<boolean>;
  log?: (line: string) => void;
}

interface ShaderCacheRootSpec {
  id: ShaderCacheId;
  label: string;
  provider: ShaderCacheProvider;
  relative: readonly string[];
  orphanSupport: ShaderCacheOrphanSupport;
}

const ROOT_SPECS: readonly ShaderCacheRootSpec[] = [
  {
    id: 'directx',
    label: 'DirectX PSO cache',
    provider: 'directx',
    relative: ['D3DSCache'],
    orphanSupport: 'metadata',
  },
  {
    id: 'nvidia-dx',
    label: 'NVIDIA DXCache',
    provider: 'nvidia',
    relative: ['NVIDIA', 'DXCache'],
    orphanSupport: 'opaque',
  },
  {
    id: 'nvidia-gl',
    label: 'NVIDIA GLCache',
    provider: 'nvidia',
    relative: ['NVIDIA', 'GLCache'],
    orphanSupport: 'opaque',
  },
  {
    id: 'nvidia-vk',
    label: 'NVIDIA VkCache',
    provider: 'nvidia',
    relative: ['NVIDIA', 'VkCache'],
    orphanSupport: 'opaque',
  },
  {
    id: 'amd-dx',
    label: 'AMD DxCache',
    provider: 'amd',
    relative: ['AMD', 'DxCache'],
    orphanSupport: 'opaque',
  },
  {
    id: 'amd-dxc',
    label: 'AMD DxcCache',
    provider: 'amd',
    relative: ['AMD', 'DxcCache'],
    orphanSupport: 'opaque',
  },
  {
    id: 'amd-gl',
    label: 'AMD GLCache',
    provider: 'amd',
    relative: ['AMD', 'GLCache'],
    orphanSupport: 'opaque',
  },
  {
    id: 'amd-vk',
    label: 'AMD VkCache',
    provider: 'amd',
    relative: ['AMD', 'VkCache'],
    orphanSupport: 'opaque',
  },
];

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_MIN_ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FILES_PER_ROOT = 12_000;
const MAX_DATABASES_PER_ROOT = 2_000;
const MAX_DATABASE_BYTES = 512 * 1024 * 1024;
const MAX_APP_IDS = 256;
const MAX_WARNINGS = 5;
const MAX_DEPTH = 5;
const EXE_PATH_RE = /^[A-Za-z]:[\\/][^\u0000]+$/;

interface CacheFile {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
}

interface OrphanCandidate {
  path: string;
  size: number;
  mtimeMs: number;
}

interface ScanRun {
  status: ShaderCacheStatus;
  candidates: OrphanCandidate[];
}

function emptyStatus(): ShaderCacheStatus {
  return {
    schemaVersion: 1,
    scannedAt: null,
    roots: [],
    totals: { fileCount: 0, totalBytes: 0, orphanedFiles: 0, orphanedBytes: 0 },
    warnings: [],
    error: null,
  };
}

function errorLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 240);
}

function uniqueWarnings(warnings: readonly string[]): string[] {
  return [...new Set(warnings)].slice(0, MAX_WARNINGS);
}

/** Build the fixed roots under the current user's LocalAppData. */
export function defaultShaderCacheRoots(
  localAppData: string = process.env.LOCALAPPDATA ?? '',
): ShaderCacheRootDefinition[] {
  const base = localAppData.trim();
  if (base.length === 0) return [];
  return ROOT_SPECS.map((spec) => ({
    id: spec.id,
    label: spec.label,
    provider: spec.provider,
    path: path.join(base, ...spec.relative),
    orphanSupport: spec.orphanSupport,
  }));
}

async function defaultExecutablePresent(executablePath: string): Promise<boolean> {
  try {
    const info = await stat(executablePath);
    return info.isFile();
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

export class ShaderCacheService {
  private readonly options: ShaderCacheOptions;
  private readonly minOrphanAgeMs: number;
  private readonly cacheTtlMs: number;
  private readonly maxFilesPerRoot: number;
  private cached: { at: number; status: ShaderCacheStatus } | null = null;
  private inFlight: Promise<ScanRun> | null = null;

  constructor(options: ShaderCacheOptions = {}) {
    this.options = options;
    this.minOrphanAgeMs = options.minOrphanAgeMs ?? DEFAULT_MIN_ORPHAN_AGE_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxFilesPerRoot = options.maxFilesPerRoot ?? MAX_FILES_PER_ROOT;
  }

  status(): ShaderCacheStatus {
    return this.cached?.status ?? emptyStatus();
  }

  async scan(force = false): Promise<ShaderCacheStatus> {
    if (!force && this.cached !== null && Date.now() - this.cached.at < this.cacheTtlMs) {
      return this.cached.status;
    }
    if (this.inFlight !== null) return (await this.inFlight).status;

    const pending = this.runScan();
    this.inFlight = pending;
    try {
      const run = await pending;
      this.cached = { at: Date.now(), status: run.status };
      return run.status;
    } finally {
      if (this.inFlight === pending) this.inFlight = null;
    }
  }

  /**
   * Delete only whole DirectX cache files whose SQLite metadata proves every registered
   * executable is gone. Opaque vendor caches are deliberately refused rather than guessed.
   */
  async prune(cacheIds: readonly ShaderCacheId[]): Promise<ShaderCachePruneResult> {
    const selected = [...new Set(cacheIds)];
    if (selected.length === 0) {
      throw new TuneSmithError('invalid-request', 'Select at least one shader cache to prune.');
    }
    if (selected.some((id) => id !== 'directx')) {
      throw new TuneSmithError(
        'invalid-request',
        'Only the DirectX PSO cache supports orphan pruning. NVIDIA and AMD caches are opaque driver files.',
      );
    }

    const run = await this.runScan();
    const nowMs = this.now().getTime();
    const warnings: string[] = [];
    let removedFiles = 0;
    let removedBytes = 0;
    let skippedFiles = 0;

    for (const candidate of run.candidates) {
      try {
        const info = await lstat(candidate.path);
        if (!info.isFile() || info.isSymbolicLink()) {
          skippedFiles += 1;
          continue;
        }
        if (info.size !== candidate.size || info.mtimeMs !== candidate.mtimeMs) {
          // The cache changed between the scan and the click. Never delete the new bytes.
          skippedFiles += 1;
          continue;
        }
        if (nowMs - info.mtimeMs < this.minOrphanAgeMs) {
          skippedFiles += 1;
          continue;
        }
        if ((await this.analyzeDirectXCache(candidate.path)) !== 'orphaned') {
          skippedFiles += 1;
          continue;
        }
        await unlink(candidate.path);
        removedFiles += 1;
        removedBytes += candidate.size;
      } catch (error) {
        skippedFiles += 1;
        warnings.push(`${path.basename(candidate.path)}: ${errorLine(error)}`);
      }
    }

    const status = await this.scan(true);
    const message =
      removedFiles === 0
        ? skippedFiles === 0
          ? 'No orphaned DirectX cache files were old enough to prune.'
          : `No orphaned DirectX cache files were removed; ${skippedFiles} candidate(s) were skipped.`
        : `Removed ${removedFiles} orphaned DirectX cache file(s) (${removedBytes} bytes). DirectX will rebuild the missing pipelines on the next launch.`;

    return {
      ok: warnings.length === 0,
      removedFiles,
      removedBytes,
      skippedFiles,
      warnings: uniqueWarnings(warnings),
      message,
      status,
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private roots(): readonly ShaderCacheRootDefinition[] {
    return this.options.roots ?? defaultShaderCacheRoots();
  }

  private async runScan(): Promise<ScanRun> {
    const now = this.now();
    const roots = this.roots();
    const candidates: OrphanCandidate[] = [];
    const statuses: ShaderCacheRootStatus[] = [];
    const warnings: string[] = [];

    if (roots.length === 0) {
      warnings.push('No LocalAppData shader-cache locations were found on this machine.');
    }

    for (const root of roots) {
      const result = await this.scanRoot(root, now.getTime());
      statuses.push(result.status);
      candidates.push(...result.candidates);
      warnings.push(...result.status.warnings);
    }

    const totals = statuses.reduce(
      (sum, root) => ({
        fileCount: sum.fileCount + root.fileCount,
        totalBytes: sum.totalBytes + root.totalBytes,
        orphanedFiles: sum.orphanedFiles + root.orphanedFileCount,
        orphanedBytes: sum.orphanedBytes + root.orphanedBytes,
      }),
      { fileCount: 0, totalBytes: 0, orphanedFiles: 0, orphanedBytes: 0 },
    );

    return {
      status: {
        schemaVersion: 1,
        scannedAt: now.toISOString(),
        roots: statuses,
        totals,
        warnings: uniqueWarnings(warnings),
        error: null,
      },
      candidates,
    };
  }

  private async scanRoot(
    root: ShaderCacheRootDefinition,
    nowMs: number,
  ): Promise<{ status: ShaderCacheRootStatus; candidates: OrphanCandidate[] }> {
    const base: ShaderCacheRootStatus = {
      id: root.id,
      label: root.label,
      provider: root.provider,
      displayPath: root.path,
      exists: false,
      readable: true,
      orphanSupport: root.orphanSupport,
      fileCount: 0,
      totalBytes: 0,
      orphanedFileCount: 0,
      orphanedBytes: 0,
      newestMtimeMs: null,
      warnings: [],
    };

    let rootInfo;
    try {
      rootInfo = await lstat(root.path);
    } catch (error) {
      if (isNotFound(error)) return { status: base, candidates: [] };
      return {
        status: {
          ...base,
          exists: true,
          readable: false,
          warnings: [`Could not inspect ${root.label}: ${errorLine(error)}`],
        },
        candidates: [],
      };
    }

    if (rootInfo.isSymbolicLink()) {
      return {
        status: {
          ...base,
          exists: true,
          readable: false,
          warnings: [`Refused to scan ${root.label}: the cache root is a symbolic link.`],
        },
        candidates: [],
      };
    }
    if (!rootInfo.isDirectory()) {
      return {
        status: {
          ...base,
          exists: true,
          readable: false,
          warnings: [`Refused to scan ${root.label}: the cache root is not a directory.`],
        },
        candidates: [],
      };
    }

    const files: CacheFile[] = [];
    const warnings: string[] = [];
    let truncated = false;

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (files.length >= this.maxFilesPerRoot) {
        truncated = true;
        return;
      }

      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        warnings.push(`Could not read ${root.label}: ${errorLine(error)}`);
        return;
      }

      for (const entry of entries) {
        if (files.length >= this.maxFilesPerRoot) {
          truncated = true;
          return;
        }
        if (entry.isSymbolicLink()) continue;

        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < MAX_DEPTH) await walk(fullPath, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;

        let info;
        try {
          info = await lstat(fullPath);
        } catch (error) {
          warnings.push(`Could not inspect ${entry.name}: ${errorLine(error)}`);
          continue;
        }
        if (!info.isFile() || info.isSymbolicLink()) continue;
        files.push({ path: fullPath, name: entry.name, size: info.size, mtimeMs: info.mtimeMs });
      }
    };

    await walk(root.path, 0);

    const candidates: OrphanCandidate[] = [];
    let totalBytes = 0;
    let newestMtimeMs: number | null = null;
    let analyzedDatabases = 0;
    let analysisCapReached = false;

    for (const file of files) {
      totalBytes += file.size;
      newestMtimeMs = newestMtimeMs === null ? file.mtimeMs : Math.max(newestMtimeMs, file.mtimeMs);

      if (root.orphanSupport !== 'metadata' || !/\.dxcache$/i.test(file.name)) continue;
      if (nowMs - file.mtimeMs < this.minOrphanAgeMs) continue;
      if (analyzedDatabases >= MAX_DATABASES_PER_ROOT) {
        analysisCapReached = true;
        continue;
      }
      analyzedDatabases += 1;

      const analysis = await this.analyzeDirectXCache(file.path);
      if (analysis === 'orphaned') {
        candidates.push({ path: file.path, size: file.size, mtimeMs: file.mtimeMs });
      }
    }

    if (truncated) {
      warnings.push(`Scan capped at ${this.maxFilesPerRoot} files; later files were not inspected.`);
    }
    if (analysisCapReached) {
      warnings.push(`Metadata analysis capped at ${MAX_DATABASES_PER_ROOT} DirectX cache files.`);
    }

    return {
      status: {
        ...base,
        exists: true,
        readable: true,
        fileCount: files.length,
        totalBytes,
        orphanedFileCount: candidates.length,
        orphanedBytes: candidates.reduce((sum, entry) => sum + entry.size, 0),
        newestMtimeMs,
        warnings: uniqueWarnings(warnings),
      },
      candidates,
    };
  }

  /** Read only the app-id metadata; no cache bytes are modified. */
  private async analyzeDirectXCache(file: string): Promise<'linked' | 'orphaned' | 'unknown'> {
    let database: DatabaseSync | null = null;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_DATABASE_BYTES) return 'unknown';

      database = new DatabaseSync(file, { readOnly: true });
      const table = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_id'")
        .get();
      if (table === undefined || table === null) return 'unknown';

      const rows = database
        .prepare('SELECT exe_path FROM app_id LIMIT 257')
        .all() as Array<{ exe_path?: unknown }>;
      if (rows.length === 0 || rows.length > MAX_APP_IDS) return 'unknown';

      const executables = rows.map((row) => (typeof row.exe_path === 'string' ? row.exe_path.trim() : ''));
      if (executables.some((value) => !EXE_PATH_RE.test(value))) return 'unknown';

      const present = await Promise.all(
        executables.map(async (executable) => {
          try {
            return await (this.options.isExecutablePresent ?? defaultExecutablePresent)(executable);
          } catch {
            return false;
          }
        }),
      );
      return present.some(Boolean) ? 'linked' : 'orphaned';
    } catch (error) {
      this.options.log?.(`metadata read failed: ${errorLine(error)}`);
      return 'unknown';
    } finally {
      try {
        database?.close();
      } catch {
        // A failed close must not turn a read-only inspection into a crash.
      }
    }
  }
}
