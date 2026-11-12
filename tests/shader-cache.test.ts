import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {
  ShaderCacheService,
  defaultShaderCacheRoots,
  type ShaderCacheRootDefinition,
} from '../src/main/services/shader-cache';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-01-02T00:00:00.000Z');
const OLD = new Date(NOW.getTime() - 2 * DAY);
const RECENT = new Date(NOW.getTime() - HOUR);
const LIVE_EXE = 'C:\\Games\\Installed\\game.exe';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'tunesmith-shader-cache-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function rootDefinition(
  id: ShaderCacheRootDefinition['id'],
  label: string,
  provider: ShaderCacheRootDefinition['provider'],
  dir: string,
): ShaderCacheRootDefinition {
  return {
    id,
    label,
    provider,
    path: dir,
    orphanSupport: id === 'directx' ? 'metadata' : 'opaque',
  };
}

function makeDxCache(file: string, executablePaths: readonly string[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec('CREATE TABLE app_id (id INTEGER PRIMARY KEY, exe_path TEXT, app_name TEXT)');
  const insert = database.prepare('INSERT INTO app_id (exe_path, app_name) VALUES (?, ?)');
  for (const executable of executablePaths) insert.run(executable, null);
  database.close();
}

async function age(file: string, date: Date): Promise<void> {
  await utimes(file, date, date);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

describe('shader-cache roots', () => {
  it('derives only the fixed per-user roots from LocalAppData', () => {
    const base = 'C:\\Users\\preview\\AppData\\Local';
    const roots = defaultShaderCacheRoots(base);

    expect(roots.map((root) => root.id)).toEqual([
      'directx',
      'nvidia-dx',
      'nvidia-gl',
      'nvidia-vk',
      'amd-dx',
      'amd-dxc',
      'amd-gl',
      'amd-vk',
    ]);
    expect(roots[0]?.path).toBe(path.join(base, 'D3DSCache'));
    expect(roots[1]?.path).toBe(path.join(base, 'NVIDIA', 'DXCache'));
    expect(roots[4]?.path).toBe(path.join(base, 'AMD', 'DxCache'));
    expect(defaultShaderCacheRoots('')).toEqual([]);
  });
});

describe('shader-cache inventory', () => {
  it('detects whole orphaned DirectX files while preserving linked, recent and unknown metadata', async () => {
    const directxDir = path.join(root, 'D3DSCache');
    const nvidiaDir = path.join(root, 'NVIDIA', 'DXCache');
    await mkdir(directxDir, { recursive: true });
    await mkdir(nvidiaDir, { recursive: true });

    const orphan = path.join(directxDir, 'aa', 'orphan.dxcache');
    const linked = path.join(directxDir, 'aa', 'linked.dxcache');
    const mixed = path.join(directxDir, 'aa', 'mixed.dxcache');
    const recent = path.join(directxDir, 'aa', 'recent.dxcache');
    const unknown = path.join(directxDir, 'aa', 'unknown.dxcache');
    const vendor = path.join(nvidiaDir, '00000001.nvph');

    makeDxCache(orphan, ['C:\\Games\\Removed\\gone.exe']);
    makeDxCache(linked, [LIVE_EXE]);
    makeDxCache(mixed, ['C:\\Games\\Removed\\gone.exe', LIVE_EXE]);
    makeDxCache(recent, ['C:\\Games\\Removed\\gone.exe']);
    const unknownDatabase = new DatabaseSync(unknown);
    unknownDatabase.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
    unknownDatabase.close();
    await writeFile(vendor, 'opaque driver cache');

    await Promise.all([
      age(orphan, OLD),
      age(linked, OLD),
      age(mixed, OLD),
      age(recent, RECENT),
      age(unknown, OLD),
      age(vendor, OLD),
    ]);

    const service = new ShaderCacheService({
      roots: [
        rootDefinition('directx', 'DirectX PSO cache', 'directx', directxDir),
        rootDefinition('nvidia-dx', 'NVIDIA DXCache', 'nvidia', nvidiaDir),
      ],
      now: () => NOW,
      isExecutablePresent: async (executable) => executable === LIVE_EXE,
    });

    const status = await service.scan(true);
    const directx = status.roots.find((entry) => entry.id === 'directx');
    const nvidia = status.roots.find((entry) => entry.id === 'nvidia-dx');

    expect(directx).toMatchObject({
      exists: true,
      readable: true,
      fileCount: 5,
      orphanedFileCount: 1,
      orphanSupport: 'metadata',
    });
    expect(directx?.orphanedBytes).toBeGreaterThan(0);
    expect(nvidia).toMatchObject({
      exists: true,
      fileCount: 1,
      orphanedFileCount: 0,
      orphanSupport: 'opaque',
    });
    expect(status.totals).toMatchObject({
      fileCount: 6,
      orphanedFiles: 1,
    });
  });

  it('prunes only the confirmed orphan and leaves valid and recent files untouched', async () => {
    const directxDir = path.join(root, 'D3DSCache');
    const nvidiaDir = path.join(root, 'NVIDIA', 'DXCache');
    await mkdir(directxDir, { recursive: true });
    await mkdir(nvidiaDir, { recursive: true });

    const orphan = path.join(directxDir, 'orphan.dxcache');
    const linked = path.join(directxDir, 'linked.dxcache');
    const recent = path.join(directxDir, 'recent.dxcache');
    const vendor = path.join(nvidiaDir, '00000002.nvph');

    makeDxCache(orphan, ['C:\\Games\\Removed\\gone.exe']);
    makeDxCache(linked, [LIVE_EXE]);
    makeDxCache(recent, ['C:\\Games\\Removed\\gone.exe']);
    await writeFile(vendor, 'opaque driver cache');
    await Promise.all([age(orphan, OLD), age(linked, OLD), age(recent, RECENT), age(vendor, OLD)]);

    const service = new ShaderCacheService({
      roots: [
        rootDefinition('directx', 'DirectX PSO cache', 'directx', directxDir),
        rootDefinition('nvidia-dx', 'NVIDIA DXCache', 'nvidia', nvidiaDir),
      ],
      now: () => NOW,
      isExecutablePresent: async (executable) => executable === LIVE_EXE,
    });

    const result = await service.prune(['directx']);

    expect(result.ok).toBe(true);
    expect(result.removedFiles).toBe(1);
    expect(result.removedBytes).toBeGreaterThan(0);
    expect(result.status.totals.orphanedFiles).toBe(0);
    expect(await exists(orphan)).toBe(false);
    expect(await exists(linked)).toBe(true);
    expect(await exists(recent)).toBe(true);
    expect(await exists(vendor)).toBe(true);
  });

  it('does not delete a cache that gains a live app after the inventory', async () => {
    const directxDir = path.join(root, 'D3DSCache');
    const orphan = path.join(directxDir, 'changed.dxcache');
    makeDxCache(orphan, ['C:\\Games\\Removed\\gone.exe']);
    await age(orphan, OLD);

    const service = new ShaderCacheService({
      roots: [rootDefinition('directx', 'DirectX PSO cache', 'directx', directxDir)],
      now: () => NOW,
      isExecutablePresent: async (executable) => executable === LIVE_EXE,
    });

    const inventory = await service.scan(true);
    expect(inventory.totals.orphanedFiles).toBe(1);

    await rm(orphan);
    makeDxCache(orphan, [LIVE_EXE]);
    await age(orphan, OLD);

    const result = await service.prune(['directx']);
    expect(result.removedFiles).toBe(0);
    expect(await exists(orphan)).toBe(true);
    expect(result.status.totals.orphanedFiles).toBe(0);
  });

  it('refuses to prune opaque vendor caches even when a caller asks for them', async () => {
    const directxDir = path.join(root, 'D3DSCache');
    const service = new ShaderCacheService({
      roots: [rootDefinition('directx', 'DirectX PSO cache', 'directx', directxDir)],
      now: () => NOW,
    });

    await expect(service.prune(['nvidia-dx'])).rejects.toThrow(/Only the DirectX PSO cache/i);
  });

  it('reports a missing cache root without treating it as a scan failure', async () => {
    const service = new ShaderCacheService({
      roots: [rootDefinition('amd-dx', 'AMD DxCache', 'amd', path.join(root, 'missing'))],
      now: () => NOW,
    });

    const status = await service.scan(true);
    expect(status.error).toBeNull();
    expect(status.roots[0]).toMatchObject({
      id: 'amd-dx',
      exists: false,
      readable: true,
      fileCount: 0,
    });
  });
});
