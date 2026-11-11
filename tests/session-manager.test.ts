import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JournalStore } from '../src/main/engine/journal';
import { SessionLock } from '../src/main/engine/lock';
import { SessionManager } from '../src/main/journal/sessionManager';
import type { JournalRecord } from '../src/shared/session';
import { FakeAdapter } from './factories';

let root: string;
let journal: JournalStore;
let lock: SessionLock;
let adapter: FakeAdapter;
let manager: SessionManager;

const SESSION_ID = 'crash-session-1';

const INPUT = {
  id: SESSION_ID,
  presetId: 'test-preset',
  presetName: 'Test Preset',
  presetVersion: '1.0.0',
  presetRisk: 'moderate',
  signature: 'AMD_Ryzen5_5600X_RTX3060_32GB_SSD',
  appVersion: 'test',
  stepCount: 3,
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'tunesmith-recovery-'));
  journal = new JournalStore(path.join(root, 'sessions'));
  lock = new SessionLock(root);
  adapter = new FakeAdapter();
  manager = new SessionManager({ journal, lock, adapter });
});

afterEach(async () => {
  await journal.closeAll();
  await rm(root, { recursive: true, force: true });
});

function entry(seq: number, target: string): JournalRecord {
  const at = '2026-01-01T00:00:00.000Z';
  return {
    type: 'entry',
    seq,
    at,
    entry: {
      seq,
      at,
      key: `k${seq}`,
      group: 'Registry',
      label: `Change ${seq}`,
      target,
      before: { kind: 'registry', target, exists: false },
    },
  };
}

function outcome(seq: number, status: 'applied' | 'failed' = 'applied'): JournalRecord {
  return { type: 'outcome', seq, status };
}

describe('atomic manifests', () => {
  it('writes a complete applying manifest and leaves no temporary file', async () => {
    const manifest = await manager.begin(INPUT);
    const dir = journal.sessionDir(manifest.id);

    const parsed = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as {
      id: string;
      status: string;
      stepCount: number;
    };
    expect(parsed.id).toBe(SESSION_ID);
    expect(parsed.status).toBe('applying');
    expect(parsed.stepCount).toBe(3);
    expect(await readdir(dir)).not.toContain('manifest.json.tmp');
  });
});

describe('crash recovery', () => {
  it('detects an unclosed manifest and restores announced steps newest-first', async () => {
    await manager.begin(INPUT);
    await manager.append(SESSION_ID, entry(1, 'target-0'));
    await manager.append(SESSION_ID, outcome(1));
    await manager.append(SESSION_ID, entry(2, 'target-1'));
    await manager.append(SESSION_ID, outcome(2));
    // Simulated crash: step 3 was announced (and may have been partially applied) but
    // the process died before its outcome record was fsynced.
    await manager.append(SESSION_ID, entry(3, 'target-2'));

    const interrupted = await manager.scanInterrupted();
    expect(interrupted.map((session) => session.id)).toContain(SESSION_ID);
    expect(interrupted.find((session) => session.id === SESSION_ID)?.pendingRollback).toBe(3);
    expect((await manager.scanNeedingRecovery()).map((session) => session.id)).toContain(SESSION_ID);

    const report = await manager.restore(SESSION_ID);

    expect(report.ok).toBe(true);
    expect(report.restored).toBe(3);
    expect(adapter.restored).toEqual(['target-2', 'target-1', 'target-0']);

    const manifest = await journal.readManifest(SESSION_ID);
    expect(manifest.status).toBe('rolled-back');
    expect(manifest.notes.join(' ')).toContain('Rolled back 3 step(s).');

    const entries = await journal.entries(SESSION_ID);
    expect(entries.every((record) => record.rolledBack === true)).toBe(true);
    expect(await manager.scanInterrupted()).toEqual([]);
  });

  it('restores a failed step too, because it may have partially mutated the machine', async () => {
    await manager.begin(INPUT);
    await manager.append(SESSION_ID, entry(1, 'target-0'));
    await manager.append(SESSION_ID, outcome(1));
    await manager.append(SESSION_ID, entry(2, 'target-1'));
    await manager.append(SESSION_ID, outcome(2, 'failed'));

    const report = await manager.restore(SESSION_ID);

    expect(report.restored).toBe(2);
    expect(adapter.restored).toEqual(['target-1', 'target-0']);
  });

  it('does not report a finalised session as interrupted', async () => {
    await manager.begin(INPUT);
    await journal.updateManifest(SESSION_ID, {
      status: 'applied',
      finishedAt: '2026-01-01T00:01:00.000Z',
    });

    expect(await manager.scanInterrupted()).toEqual([]);
  });
});

describe('cross-process lock', () => {
  it('uses sessions/lock and refuses a second live writer', async () => {
    await lock.acquire('first');
    expect(await lock.currentHolder()).toMatchObject({ reason: 'first' });

    const second = new SessionLock(root);
    await expect(second.acquire('second')).rejects.toThrow(/already running/i);

    await lock.release();
  });

  it('does not break a brand-new lock directory that has no holder record yet', async () => {
    await mkdir(path.join(root, 'sessions', 'lock'), { recursive: true });

    const contender = new SessionLock(root);
    await expect(contender.acquire('second')).rejects.toThrow(/already running/i);
  });

  it('breaks a stale lock older than ten minutes and logs a warning', async () => {
    const dir = path.join(root, 'sessions', 'lock');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'holder.json'),
      JSON.stringify({
        pid: 1,
        startedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
        reason: 'crashed',
      }),
      'utf8',
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const replacement = new SessionLock(root);
      await expect(replacement.acquire('recovery')).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('breaking stale lock'));
      expect(await replacement.currentHolder()).toMatchObject({ reason: 'recovery' });
      await replacement.release();
    } finally {
      warn.mockRestore();
    }
  });
});
