/**
 * Preset persistence contract.
 *
 * These types are the on-disk and on-the-wire shape of a tuning session. They live in
 * `shared/` because the renderer displays them, the main process writes them, and the
 * tests assert on them. Everything here must stay JSON-serialisable.
 */
import type { RegData, RegType } from './types';

export type SessionStatus = 'applying' | 'applied' | 'failed' | 'rolled-back' | 'rollback-failed';

export type ServiceStartType = 'Auto' | 'Manual' | 'Disabled' | 'Unknown';

/**
 * The exact prior state of one target, captured immediately before it is mutated.
 *
 * `exists: false` means "the value/service was not there", which is a real state and
 * must be restorable (delete the value again). An unreadable target is never recorded
 * as `exists: false`: capture throws instead, and the engine refuses to mutate a
 * target it could not read (fail closed).
 */
export type CapturedState =
  | { kind: 'registry'; target: string; exists: false }
  | { kind: 'registry'; target: string; exists: true; valueType: RegType; data: RegData }
  | { kind: 'service'; target: string; exists: false }
  | { kind: 'service'; target: string; exists: true; startType: ServiceStartType; running: boolean }
  | { kind: 'priority'; target: string; instances: { pid: number; priority: string }[] }
  | { kind: 'power-plan'; target: string; schemeGuid: string | null }
  | { kind: 'power-setting'; target: string; schemeGuid: string; value: number | null }
  | {
      kind: 'device-interrupt';
      target: string;
      devices: { path: string; msi: { existed: boolean; data?: number }; limit: { existed: boolean; data?: number } }[];
    }
  | { kind: 'irq-priority'; target: string; existed: boolean; value?: number }
  | {
      kind: 'network';
      target: string;
      interfaces: { guid: string; tcpAckFrequency: number | null; tcpNoDelay: number | null }[];
    };

export type JournalStepStatus = 'pending' | 'applied' | 'failed' | 'skipped';

export interface JournalEntry {
  seq: number;
  at: string;
  key: string;
  group: string;
  label: string;
  target: string;
  before: CapturedState;
  status: JournalStepStatus;
  error?: string;
  rolledBack?: boolean;
}

/**
 * Append-only journal records. A step is announced (with its captured prior state)
 * *before* the mutation, then an outcome record follows. Recovery replays the log;
 * an entry announced with no outcome is treated as "unknown, probably applied" and is
 * rolled back conservatively.
 */
export type JournalRecord =
  | { type: 'entry'; seq: number; at: string; entry: Omit<JournalEntry, 'status'> }
  | { type: 'outcome'; seq: number; status: Exclude<JournalStepStatus, 'pending'>; error?: string }
  | { type: 'rollback'; seq: number; ok: boolean; error?: string };

export interface RestorePointInfo {
  attempted: boolean;
  ok: boolean;
  detail: string;
}

export interface SessionManifest {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  presetId: string;
  presetName: string;
  presetVersion: string;
  presetRisk: string;
  signature: string;
  appVersion: string;
  status: SessionStatus;
  restorePoint: RestorePointInfo;
  stepCount: number;
  notes: string[];
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  finishedAt: string | null;
  presetId: string;
  presetName: string;
  presetVersion: string;
  presetRisk: string;
  signature: string;
  status: SessionStatus;
  restorePoint: RestorePointInfo;
  stepCount: number;
  /** Steps currently mutated on the machine (applied, not yet rolled back). */
  pendingRollback: number;
  /** Present when the app crashed mid-apply and the session was never finalised. */
  interrupted: boolean;
}

export interface ApplyOutcome {
  sessionId: string;
  presetId: string;
  status: 'applied' | 'failed';
  appliedSteps: number;
  skippedSteps: number;
  failedStep: { label: string; error: string } | null;
  autoRolledBack: boolean;
  restorePoint: RestorePointInfo;
  message: string;
}

export interface RollbackReport {
  sessionId: string;
  restored: number;
  failed: number;
  errors: string[];
  ok: boolean;
  message: string;
}

export interface PreflightCheck {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export interface PreflightReport {
  checks: PreflightCheck[];
  /** False when at least one check is `fail`. */
  ready: boolean;
  isElevated: boolean;
  signature: string;
  inFlightSession: string | null;
}

export interface AppInfo {
  appVersion: string;
  electronVersion: string;
  platform: string;
  isElevated: boolean;
  devMode: boolean;
  sessionsDir: string;
  presetCount: number;
}

export type EnginePhase = 'preflight' | 'restore-point' | 'apply' | 'rollback' | 'done' | 'error';

export interface EngineProgress {
  phase: EnginePhase;
  message: string;
  current?: number;
  total?: number;
  step?: { label: string; target: string; status: 'applied' | 'failed' | 'skipped' };
}
