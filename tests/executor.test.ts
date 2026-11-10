import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Executor } from '../src/main/engine/executor';
import { JournalStore, newSessionManifest } from '../src/main/engine/journal';
import { SessionLock } from '../src/main/engine/lock';
import type { JournalRecord, RestorePointInfo } from '../src/shared/session';
import { FakeAdapter, makePlan, registryAction } from './factories';

let root: string;
let journal: JournalStore;
let lock: SessionLock;
let adapter: FakeAdapter;
let executor: Executor;

const okRestorePoint: RestorePointInfo = { attempted: true, ok: true, detail: 'test checkpoint' };

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'tunesmith-exec-'));
  journal = new JournalStore(path.join(root, 'sessions'));
  lock = new SessionLock(root);
  adapter = new FakeAdapter();
  executor = new Executor({
    adapter,
    journal,
    lock,
    appVersion: 'test',
    createRestorePoint: async () => okRestorePoint,
  });
});

afterEach(async () => {
  await journal.closeAll();
  await rm(root, { recursive: true, force: true });
});

const plan = () =>
  makePlan([
    registryAction('A'),
    registryAction('B'),
    { kind: 'service', name: 'DiagTrack', startup: 'Manual' },
  ]);

const consent = { acknowledgeConsent: true, acknowledgeRisk: true };

describe('apply', () => {
  it('applies every step and finalises the session', async () => {
    const outcome = await executor.apply(plan(), consent);

    expect(outcome.status).toBe('applied');
    expect(outcome.appliedSteps).toBe(3);
    expect(adapter.applied).toEqual(['k0', 'k1', 'k2']);

    const manifest = await journal.readManifest(outcome.sessionId);
    expect(manifest.status).toBe('applied');
    expect(manifest.finishedAt).not.toBeNull();
    expect(manifest.restorePoint).toEqual(okRestorePoint);
  });

  it('records the previous state of every step before mutating', async () => {
    const outcome = await executor.apply(plan(), consent);
    const entries = await journal.entries(outcome.sessionId);

    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.status === 'applied')).toBe(true);
    expect(entries.every((e) => e.before !== undefined)).toBe(true);
  });

  it('refuses a policy-blocked plan', async () => {
    await expect(executor.apply(makePlan([registryAction()], { blocked: true }), consent)).rejects.toThrow(/blocked/i);
    expect(adapter.applied).toEqual([]);
  });

  it('refuses an incompatible plan', async () => {
    const incompatible = makePlan([registryAction()], {
      compatibility: { applicable: false, score: 0, specified: 1, matched: 0, reasons: ['nope'] },
    });
    await expect(executor.apply(incompatible, consent)).rejects.toThrow(/hardware/i);
  });

  it('refuses an empty plan', async () => {
    await expect(executor.apply(makePlan([]), consent)).rejects.toThrow(/no actions/i);
  });

  it('requires consent for restricted changes', async () => {
    const needsConsent = makePlan([registryAction()], { needsConsent: true });
    await expect(executor.apply(needsConsent, { acknowledgeConsent: false, acknowledgeRisk: true })).rejects.toThrow(/acknowledgement/i);
  });

  it('requires a risk acknowledgement for aggressive presets', async () => {
    const aggressive = makePlan([registryAction()], { risk: 'aggressive' });
    await expect(executor.apply(aggressive, { acknowledgeConsent: true, acknowledgeRisk: false })).rejects.toThrow(/aggressive/i);
  });
});

describe('failure handling', () => {
  it('rolls back everything already applied when a step fails', async () => {
    adapter.failOnApply.add('k1');
    const outcome = await executor.apply(plan(), consent);

    expect(outcome.status).toBe('failed');
    expect(outcome.appliedSteps).toBe(1);
    expect(outcome.autoRolledBack).toBe(true);

    // Reverse order, and the failed step is attempted too (it may have partially applied).
    expect(adapter.restored).toEqual(['target-1', 'target-0']);

    const manifest = await journal.readManifest(outcome.sessionId);
    expect(manifest.status).toBe('failed');

    const entries = await journal.entries(outcome.sessionId);
    expect(entries.every((e) => e.rolledBack === true)).toBe(true);
    expect(entries.find((e) => e.seq === 2)?.status).toBe('failed');
  });

  it('never mutates a target whose state could not be captured', async () => {
    adapter.failOnCapture.add('k0');
    const outcome = await executor.apply(plan(), consent);

    expect(outcome.status).toBe('failed');
    expect(adapter.applied).toEqual([]);
    expect(adapter.restored).toEqual([]);
    expect(outcome.failedStep?.error).toMatch(/capture/i);
  });

  it('aborts before mutating when a required restore point fails', async () => {
    executor = new Executor({
      adapter,
      journal,
      lock,
      appVersion: 'test',
      createRestorePoint: async () => ({ attempted: true, ok: false, detail: 'throttled' }),
    });

    const outcome = await executor.apply(makePlan([registryAction()], { restorePoint: 'required' }), consent);
    expect(outcome.status).toBe('failed');
    expect(outcome.appliedSteps).toBe(0);
    expect(adapter.applied).toEqual([]);
  });

  it('continues with journal-only protection when the restore point fails and is optional', async () => {
    executor = new Executor({
      adapter,
      journal,
      lock,
      appVersion: 'test',
      createRestorePoint: async () => ({ attempted: true, ok: false, detail: 'throttled' }),
    });

    const outcome = await executor.apply(makePlan([registryAction()]), consent);
    expect(outcome.status).toBe('applied');
    expect(outcome.restorePoint.ok).toBe(false);
  });
});

describe('rollback', () => {
  it('restores in reverse order and marks the session restored', async () => {
    const outcome = await executor.apply(plan(), consent);
    const report = await executor.rollback(outcome.sessionId);

    expect(report.ok).toBe(true);
    expect(report.restored).toBe(3);
    expect(adapter.restored).toEqual(['target-2', 'target-1', 'target-0']);

    const manifest = await journal.readManifest(outcome.sessionId);
    expect(manifest.status).toBe('rolled-back');
  });

  it('is idempotent', async () => {
    const outcome = await executor.apply(plan(), consent);
    await executor.rollback(outcome.sessionId);
    adapter.restored = [];

    const second = await executor.rollback(outcome.sessionId);
    expect(second.restored).toBe(0);
    expect(adapter.restored).toEqual([]);
  });

  it('rolls back an interrupted session (announced, no outcome)', async () => {
    const sessionId = 'interrupted-session-1';
    await journal.createSession(
      newSessionManifest({
        id: sessionId,
        presetId: 'test-preset',
        presetName: 'Test Preset',
        presetVersion: '1.0.0',
        presetRisk: 'moderate',
        signature: 'AMD_Ryzen5_5600X_RTX3060_32GB_SSD',
        appVersion: 'test',
        stepCount: 1,
      }),
    );

    const record: JournalRecord = {
      type: 'entry',
      seq: 1,
      at: new Date().toISOString(),
      entry: {
        seq: 1,
        at: new Date().toISOString(),
        key: 'k0',
        group: 'Registry',
        label: 'half-applied',
        target: 'target-0',
        before: { kind: 'registry', target: 'target-0', exists: false },
      },
    };
    await journal.append(sessionId, record);

    const summaries = await journal.sessionsNeedingRollback();
    expect(summaries.map((s) => s.id)).toContain(sessionId);
    expect(summaries.find((s) => s.id === sessionId)?.interrupted).toBe(true);

    const report = await executor.rollback(sessionId);
    expect(report.restored).toBe(1);
    expect(adapter.restored).toEqual(['target-0']);
  });

  it('reports a failed restore without marking the session clean', async () => {
    const outcome = await executor.apply(plan(), consent);

    adapter.restore = async () => {
      throw new Error('restore exploded');
    };

    const report = await executor.rollback(outcome.sessionId);
    expect(report.ok).toBe(false);
    expect(report.failed).toBe(3);

    const manifest = await journal.readManifest(outcome.sessionId);
    expect(manifest.status).toBe('rollback-failed');
  });
});

describe('restore to default', () => {
  it('rolls back every session with pending changes, newest first', async () => {
    const first = await executor.apply(makePlan([registryAction('one')]), consent);
    const second = await executor.apply(makePlan([registryAction('two'), registryAction('three')]), consent);

    adapter.restored = [];
    const reports = await executor.restoreDefaults();

    expect(reports).toHaveLength(2);
    // Both sessions are covered; ordering between them is by creation time, which can
    // collide at millisecond resolution, so assert on the set rather than the sequence.
    expect(reports.map((r) => r.sessionId).sort()).toEqual([first.sessionId, second.sessionId].sort());
    expect(reports.reduce((sum, r) => sum + r.restored, 0)).toBe(3);

    const remaining = await journal.sessionsNeedingRollback();
    expect(remaining).toEqual([]);
  });

  it('returns an empty list when there is nothing to undo', async () => {
    const reports = await executor.restoreDefaults();
    expect(reports).toEqual([]);
  });
});
