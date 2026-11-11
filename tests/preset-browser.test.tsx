// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  InstallResult,
  MarketEntryView,
  MarketStatus,
} from '../src/shared/market/types';
import { PresetBrowser } from '../src/renderer/components/PresetBrowser';
import { makeSpec } from './factories';

afterEach(cleanup);

const SHA = 'a'.repeat(64);

function makeEntry(overrides: Partial<MarketEntryView> = {}): MarketEntryView {
  return {
    id: 'alpha',
    version: '1.0.0',
    name: 'Competitive FPS',
    description: 'Low-latency tuning for high-refresh shooters.',
    risk: 'moderate',
    tags: ['gaming', 'latency'],
    authors: ['nova'],
    license: 'MIT',
    sha256: SHA,
    publishedAt: '2026-01-01T00:00:00.000Z',
    ratings: { up: 4, down: 0, crashes: 0, recoveries: 0 },
    safety: { score: 88, label: 'good', reasons: ['Signed by the curator'] },
    compatibility: {
      applicable: true,
      score: 0.92,
      blocked: false,
      reasons: ['CPU and memory match'],
    },
    stats: {
      applies: 0,
      failed: 0,
      interrupted: 0,
      recovered: 0,
      crashRate: 0,
      recoveryRate: 0,
    },
    installedVersion: null,
    updateAvailable: false,
    ...overrides,
  };
}

function makeStatus(
  entries: MarketEntryView[],
  rejected: MarketStatus['rejected'] = [],
): MarketStatus {
  return {
    configured: true,
    source: 'https://market.example/catalog.json',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    error: null,
    rejected,
    entries,
    telemetry: {
      consent: false,
      pending: 0,
      uploadConfigured: false,
      lastUploadAt: null,
      lastUploadError: null,
    },
  };
}

const okInstall: InstallResult = {
  presetId: 'alpha',
  version: '1.0.0',
  file: 'alpha.json',
  sha256: SHA,
};

describe('PresetBrowser', () => {
  it('renders verified catalog items with hardware badges, then filters by search and category', async () => {
    const workstation = makeEntry({
      id: 'workstation',
      name: 'Workstation Throughput',
      description: 'Batch workloads on a big desktop.',
      tags: ['workstation'],
      authors: ['atlas'],
      compatibility: {
        applicable: false,
        score: 0.2,
        blocked: false,
        reasons: ['Requires 32 GB RAM'],
      },
    });
    const loadCatalog = vi.fn().mockResolvedValue(makeStatus([makeEntry(), workstation]));

    render(
      <PresetBrowser
        hardware={makeSpec()}
        loadCatalog={loadCatalog}
        installPreset={vi.fn()}
      />,
    );

    expect(await screen.findByText('Competitive FPS')).toBeTruthy();
    expect(screen.getByText(/nova/)).toBeTruthy();
    expect(screen.getByText(/Low-latency tuning/)).toBeTruthy();
    expect(screen.getByText('Great match · 92%')).toBeTruthy();
    expect(screen.getByText('Not for this PC')).toBeTruthy();
    expect(screen.getAllByText(/matched to AMD_Ryzen5_5600X/).length).toBeGreaterThan(0);
    expect(loadCatalog).toHaveBeenCalledWith(false);

    fireEvent.change(screen.getByLabelText('Search community presets'), {
      target: { value: 'batch workloads' },
    });
    expect(screen.queryByText('Competitive FPS')).toBeNull();
    expect(screen.getByText('Workstation Throughput')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search community presets'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'gaming' }));
    expect(screen.getByText('Competitive FPS')).toBeTruthy();
    expect(screen.queryByText('Workstation Throughput')).toBeNull();
  });

  it('shows a SHA-256 mismatch warning for an entry rejected before rendering', async () => {
    const loadCatalog = vi.fn().mockResolvedValue(
      makeStatus([], [
        {
          id: 'tampered',
          reason: 'Digest mismatch: the preset does not match the published hash.',
        },
      ]),
    );

    render(
      <PresetBrowser
        hardware={makeSpec()}
        loadCatalog={loadCatalog}
        installPreset={vi.fn()}
      />,
    );

    expect(await screen.findByText(/failed integrity verification/)).toBeTruthy();
    expect(screen.getByText(/SHA-256\/Ed25519 mismatch/)).toBeTruthy();
    expect(screen.getByText(/Digest mismatch/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download & Install' })).toBeNull();
  });

  it('installs through the bridge callback and reports the verified result', async () => {
    const installPreset = vi.fn().mockResolvedValue(okInstall);
    const onInstalled = vi.fn();

    render(
      <PresetBrowser
        hardware={makeSpec()}
        loadCatalog={vi.fn().mockResolvedValue(makeStatus([makeEntry()]))}
        installPreset={installPreset}
        onInstalled={onInstalled}
      />,
    );

    const button = await screen.findByRole('button', { name: 'Download & Install' });
    fireEvent.click(button);

    await waitFor(() => expect(onInstalled).toHaveBeenCalledWith(okInstall));
    expect(installPreset).toHaveBeenCalledWith('alpha');
    expect(await screen.findByText(/Installed alpha v1\.0\.0/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Installed' })).toHaveProperty('disabled', true);
  });

  it('surfaces a hash mismatch returned by the installer and does not claim success', async () => {
    const installPreset = vi
      .fn()
      .mockRejectedValue(new Error('The preset payload does not match its published SHA-256 digest.'));

    render(
      <PresetBrowser
        hardware={makeSpec()}
        loadCatalog={vi.fn().mockResolvedValue(makeStatus([makeEntry()]))}
        installPreset={installPreset}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Download & Install' }));

    const warning = await screen.findByText(/Integrity check failed/);
    expect(warning.closest('[data-integrity="failed"]')).not.toBeNull();
    expect(screen.queryByText(/Installed alpha/)).toBeNull();
  });

  it('offers a retry when the catalog request fails', async () => {
    const loadCatalog = vi
      .fn()
      .mockRejectedValueOnce(new Error('The marketplace answered HTTP 503.'))
      .mockResolvedValueOnce(makeStatus([makeEntry()]));

    render(
      <PresetBrowser
        hardware={makeSpec()}
        loadCatalog={loadCatalog}
        installPreset={vi.fn()}
      />,
    );

    expect(await screen.findByText(/Could not load the community catalog/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Competitive FPS')).toBeTruthy();
    expect(loadCatalog).toHaveBeenLastCalledWith(true);
  });
});
