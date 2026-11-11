// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JournalStore, newSessionManifest, staleJournalReason } from '../src/main/engine/journal';
import { HealthStore } from '../src/main/health/store';
import { HealthWatchdog, type HealthJournalPort } from '../src/main/health/watchdog';
import { fingerprintFile } from '../src/main/health/probes';
import { compareHealth } from '../src/main/health/compare';
import type { HealthSnapshot } from '../src/shared/health/types';
import { SystemHealthPanel } from '../src/renderer/components/SystemHealthPanel';

const FILE = {
  path: 'C:\\Windows\\System32\\ntoskrnl.exe',
  size: 100,
  mtimeMs: 1,
  sha256: 'a'.repeat(64),
};

function snapshot(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    schemaVersion: 1,
    capturedAt: '2026-01-01T00:00:00.000Z',
    os: { build: '22631', revision: 100, displayVersion: '23H2' },
    servicing: {
      rebootPending: false,
      packagesPending: false,
      windowsUpdateReboot: false,
      pendingFileRename: false,
    },
    files: [FILE],
    warnings: [],
    ...overrides,
  };
}

function fakeJournals(overrides: Partial<HealthJournalPort> = {}): HealthJournalPort {
  return {
    journalHealth: async () => ({ stale: 2, needingRollback: 1 }),
    flushStale: async () => ({ flushed: ['old-session'], kept: [] }),
    ...overrides,
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'tunesmith-health-'));
});

afterEach(async () => {
  cleanup();
  await rm(root, { recursive: true, force: true });
});

describe('health comparison', () => {
  it('reports an OS update instead of duplicating system-file drift', () => {
    const baseline = snapshot();
    const current = snapshot({
      capturedAt: '2026-01-02T00:00:00.000Z',
      os: { build: '26100', revision: 1, displayVersion: '24H2' },
      files: [{ ...FILE, sha256: 'b'.repeat(64) }],
    });

    const signals = compareHealth(baseline, current);
    expect(signals.map((signal) => signal.kind)).toEqual(['os-update']);
    expect(signals[0]?.detail).toContain('22631.100');
    expect(signals[0]?.detail).toContain('26100.1');
  });

  it('reports newly pending servicing and an unexplained core-file change', () => {
    const current = snapshot({
      servicing: { ...snapshot().servicing, rebootPending: true },
      files: [{ ...FILE, sha256: 'c'.repeat(64) }],
    });

    const signals = compareHealth(snapshot(), current);
    expect(signals.map((signal) => signal.kind)).toEqual(['servicing', 'system-file']);
    expect(signals[0]?.detail).toContain('component servicing restart pending');
    expect(signals[1]?.detail).toContain('ntoskrnl.exe');
  });
});

describe('health watchdog', () => {
  it('captures a baseline on first start without raising a signal', async () => {
    const probe = vi.fn(async () => snapshot());
    const watchdog = new HealthWatchdog({
      store: new HealthStore(root),
      probe,
      journal: fakeJournals(),
      resolvePreset: async () => null,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      intervalMs: 60_000,
    });

    await watchdog.start();
    watchdog.stop();

    const status = watchdog.statusSnapshot();
    expect(status.watchdog).toBe('healthy');
    expect(status.signals).toEqual([]);
    expect(status.baselineCapturedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(status.journals).toEqual({ stale: 2, needingRollback: 1, staleAfterDays: 7 });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('publishes drift, persists a pin, and accepts a new baseline only when asked', async () => {
    let current = snapshot();
    const store = new HealthStore(root);
    const watchdog = new HealthWatchdog({
      store,
      probe: async () => current,
      journal: fakeJournals(),
      resolvePreset: async (id) => ({ id, name: 'Pinned Profile', version: '1.2.3' }),
      now: () => new Date('2026-01-02T00:00:00.000Z'),
      intervalMs: 60_000,
    });

    await watchdog.start();
    watchdog.stop();
    await watchdog.pin('competitive-fps-low-latency');
    expect(watchdog.statusSnapshot().pinnedPreset).toEqual({
      id: 'competitive-fps-low-latency',
      name: 'Pinned Profile',
      version: '1.2.3',
    });

    current = snapshot({
      capturedAt: '2026-01-02T00:00:00.000Z',
      os: { build: '26100', revision: 2, displayVersion: '24H2' },
    });
    await watchdog.check();
    expect(watchdog.statusSnapshot().signals.map((signal) => signal.kind)).toContain('os-update');

    await watchdog.acknowledge();
    expect(watchdog.statusSnapshot().signals).toEqual([]);
    expect((await store.loadBaseline())?.os.build).toBe('26100');
  });

  it('refuses to accept a baseline while the latest probe is failing', async () => {
    let fail = false;
    const watchdog = new HealthWatchdog({
      store: new HealthStore(root),
      probe: async () => {
        if (fail) throw new Error('probe unavailable');
        return snapshot();
      },
      journal: fakeJournals(),
      resolvePreset: async () => null,
      now: () => new Date('2026-01-02T00:00:00.000Z'),
      intervalMs: 60_000,
    });

    await watchdog.start();
    watchdog.stop();
    fail = true;
    await watchdog.check();

    expect(watchdog.statusSnapshot().watchdog).toBe('error');
    await expect(watchdog.acknowledge()).rejects.toThrow(/cannot accept/i);
  });

  it('flushes only through the journal port and reports the retained count', async () => {
    const flushStale = vi.fn(async () => ({ flushed: ['old-session'], kept: [{ id: 'active', reason: 'changes are still applied' }] }));
    const watchdog = new HealthWatchdog({
      store: new HealthStore(root),
      probe: async () => snapshot(),
      journal: fakeJournals({ flushStale }),
      resolvePreset: async () => null,
      now: () => new Date('2026-01-02T00:00:00.000Z'),
      intervalMs: 60_000,
    });

    await watchdog.start();
    watchdog.stop();
    const result = await watchdog.flushJournals();

    expect(flushStale).toHaveBeenCalledWith(Date.parse('2026-01-02T00:00:00.000Z'), 7 * 24 * 60 * 60 * 1000);
    expect(result.flushed).toEqual(['old-session']);
    expect(result.message).toContain('1 stale journal(s)');
    expect(watchdog.statusSnapshot().journals.stale).toBe(2);
  });
});

describe('stale journal cleanup', () => {
  const NOW = Date.parse('2026-01-10T00:00:00.000Z');
  const OLD = '2026-01-01T00:00:00.000Z';
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

  async function createSession(
    journal: JournalStore,
    id: string,
    status: 'rolled-back' | 'applied' | 'rollback-failed',
    finishedAt: string,
    pending: boolean,
  ): Promise<void> {
    const manifest = newSessionManifest({
      id,
      presetId: 'test-preset',
      presetName: 'Test Preset',
      presetVersion: '1.0.0',
      presetRisk: 'moderate',
      signature: 'AMD_Ryzen5_5600X_RTX3060_32GB_SSD',
      appVersion: 'test',
      stepCount: 1,
    });
    await journal.createSession(manifest);
    await journal.append(id, {
      type: 'entry',
      seq: 1,
      at: OLD,
      entry: {
        seq: 1,
        at: OLD,
        key: 'k1',
        group: 'Registry',
        label: 'Test change',
        target: 'HKCU\\Test',
        before: { kind: 'registry', target: 'HKCU\\Test', exists: false },
      },
    });
    await journal.append(id, { type: 'outcome', seq: 1, status: 'applied' });
    if (!pending) await journal.append(id, { type: 'rollback', seq: 1, ok: true });
    await journal.updateManifest(id, { status, finishedAt });
  }

  it('removes only old, finalised journals with zero pending rollback', async () => {
    const journal = new JournalStore(path.join(root, 'sessions'));
    await createSession(journal, 'safe-old-session', 'rolled-back', OLD, false);
    await createSession(journal, 'recent-done-session', 'rolled-back', '2026-01-09T00:00:00.000Z', false);
    await createSession(journal, 'pending-old-session', 'applied', OLD, true);
    await createSession(journal, 'failed-old-session', 'rollback-failed', OLD, true);

    const health = await journal.journalHealth(NOW, SEVEN_DAYS);
    expect(health.stale).toBe(1);
    expect(health.needingRollback).toBe(2);

    const result = await journal.flushStale(NOW, SEVEN_DAYS);
    expect(result.flushed).toEqual(['safe-old-session']);
    expect(await readdir(path.join(root, 'sessions'))).not.toContain('safe-old-session');
    expect(await readdir(path.join(root, 'sessions'))).toContain('pending-old-session');
    expect(staleJournalReason({ status: 'applied', pendingRollback: 0, interrupted: false, finishedAt: OLD, createdAt: OLD }, NOW, SEVEN_DAYS)).not.toBeNull();
    await journal.closeAll();
  });
});

describe('core file fingerprint', () => {
  it('changes when the bytes change', async () => {
    const file = path.join(root, 'ntoskrnl.exe');
    await writeFile(file, 'one', 'utf8');
    const first = await fingerprintFile(file);
    await writeFile(file, 'two', 'utf8');
    const second = await fingerprintFile(file);

    expect(first.sha256).not.toBe(second.sha256);
    expect(first.size).toBe(3);
  });
});

describe('SystemHealthPanel', () => {
  const status = {
    watchdog: 'healthy' as const,
    lastCheckAt: '2026-01-01T00:00:00.000Z',
    baselineCapturedAt: '2026-01-01T00:00:00.000Z',
    os: { build: '26100', revision: 1, displayVersion: '24H2' },
    signals: [
      {
        id: 'os-update',
        kind: 'os-update' as const,
        severity: 'warning' as const,
        title: 'Windows build changed',
        detail: 'The build moved.',
      },
    ],
    warnings: [],
    error: null,
    pinnedPresetId: 'test-preset',
    pinnedPreset: { id: 'test-preset', name: 'Test Preset', version: '1.0.0' },
    pinnedPresetMissing: false,
    journals: { stale: 2, needingRollback: 0, staleAfterDays: 7 },
  };

  it('exposes check, accept, reapply and cleanup actions', () => {
    const onCheck = vi.fn();
    const onAcknowledge = vi.fn();
    const onReapply = vi.fn();
    const onFlush = vi.fn();

    render(
      <SystemHealthPanel
        health={status}
        busy={false}
        onCheck={onCheck}
        onAcknowledge={onAcknowledge}
        onReapply={onReapply}
        onFlush={onFlush}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Re-apply pinned preset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Flush stale journals' }));

    expect(onCheck).toHaveBeenCalledOnce();
    expect(onAcknowledge).toHaveBeenCalledOnce();
    expect(onReapply).toHaveBeenCalledOnce();
    expect(onFlush).toHaveBeenCalledOnce();
  });
});
