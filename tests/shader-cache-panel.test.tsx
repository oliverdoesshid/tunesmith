// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShaderCachePanel } from '../src/renderer/components/ShaderCachePanel';
import type { ShaderCacheStatus } from '../src/shared/shader-cache';

afterEach(cleanup);

const STATUS: ShaderCacheStatus = {
  schemaVersion: 1,
  scannedAt: '2026-01-01T00:00:00.000Z',
  roots: [
    {
      id: 'directx',
      label: 'DirectX PSO cache',
      provider: 'directx',
      displayPath: 'C:\\Users\\Preview\\AppData\\Local\\D3DSCache',
      exists: true,
      readable: true,
      orphanSupport: 'metadata',
      fileCount: 118,
      totalBytes: 1_048_576_000,
      orphanedFileCount: 2,
      orphanedBytes: 8_388_608,
      newestMtimeMs: Date.parse('2026-01-01T00:00:00.000Z'),
      warnings: [],
    },
    {
      id: 'nvidia-dx',
      label: 'NVIDIA DXCache',
      provider: 'nvidia',
      displayPath: 'C:\\Users\\Preview\\AppData\\Local\\NVIDIA\\DXCache',
      exists: true,
      readable: true,
      orphanSupport: 'opaque',
      fileCount: 80,
      totalBytes: 536_870_912,
      orphanedFileCount: 0,
      orphanedBytes: 0,
      newestMtimeMs: Date.parse('2026-01-01T00:00:00.000Z'),
      warnings: [],
    },
  ],
  totals: { fileCount: 198, totalBytes: 1_585_446_912, orphanedFiles: 2, orphanedBytes: 8_388_608 },
  warnings: [],
  error: null,
};

describe('ShaderCachePanel', () => {
  it('shows the inventory and requests a fresh scan', () => {
    const onScan = vi.fn();
    render(<ShaderCachePanel status={STATUS} busy={false} onScan={onScan} onPrune={vi.fn()} />);

    expect(screen.getByText('DirectX PSO cache')).toBeTruthy();
    expect(screen.getByText('NVIDIA DXCache')).toBeTruthy();
    expect(screen.getByText(/opaque driver cache, read-only/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Scan now' }));
    expect(onScan).toHaveBeenCalledOnce();
  });

  it('requires a second click before pruning orphaned files', () => {
    const onPrune = vi.fn();
    render(<ShaderCachePanel status={STATUS} busy={false} onScan={vi.fn()} onPrune={onPrune} />);

    fireEvent.click(screen.getByRole('button', { name: 'Prune orphaned (2)' }));
    expect(onPrune).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm orphan prune' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm orphan prune' }));
    expect(onPrune).toHaveBeenCalledOnce();
  });

  it('disables orphan cleanup when the metadata says there are no orphans', () => {
    const noOrphans: ShaderCacheStatus = {
      ...STATUS,
      roots: STATUS.roots.map((root) =>
        root.id === 'directx' ? { ...root, orphanedFileCount: 0, orphanedBytes: 0 } : root,
      ),
      totals: { ...STATUS.totals, orphanedFiles: 0, orphanedBytes: 0 },
    };

    render(<ShaderCachePanel status={noOrphans} busy={false} onScan={vi.fn()} onPrune={vi.fn()} />);

    expect((screen.getByRole('button', { name: 'Prune orphaned' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
