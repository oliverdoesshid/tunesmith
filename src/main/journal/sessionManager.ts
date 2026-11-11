/**
 * Crash-recovery session state machine.
 *
 * `Executor` owns applying a plan; this class owns the lifecycle of the journal itself:
 * beginning a durable session, appending records through one seam, and rolling a session
 * back in strict reverse order after a crash. Keeping the recovery logic here means the
 * startup scan and the UI's "Restore Previous State" action use exactly the same code as
 * an in-process auto-rollback.
 *
 * The journal is append-only. Recovery therefore does not try to infer what happened
 * from a rewritten file: every announced step (entry) is restored unless a durable
 * rollback record already says it was undone. A step with no outcome is treated as
 * "probably applied" and restored conservatively.
 */
import { TuneSmithError } from '../../shared/errors';
import type {
  JournalEntry,
  JournalRecord,
  RollbackReport,
  SessionManifest,
  SessionSummary,
} from '../../shared/session';
import type { StepAdapter } from '../engine/adapter';
import { isRestorable, JournalStore, newSessionManifest } from '../engine/journal';
import type { SessionLock } from '../engine/lock';

export interface BeginSessionInput {
  id: string;
  presetId: string;
  presetName: string;
  presetVersion: string;
  presetRisk: string;
  signature: string;
  appVersion: string;
  stepCount: number;
}

export interface SessionManagerDeps {
  journal: JournalStore;
  lock: SessionLock;
  adapter: StepAdapter;
  log?: (line: string) => void;
}

export class SessionManager {
  constructor(private readonly deps: SessionManagerDeps) {}

  /** Write `manifest.json` atomically before the executor is allowed to mutate anything. */
  async begin(input: BeginSessionInput): Promise<SessionManifest> {
    const manifest = newSessionManifest(input);
    await this.deps.journal.createSession(manifest);
    return manifest;
  }

  /** The only write seam for step records; the journal fsyncs every record. */
  async append(sessionId: string, record: JournalRecord): Promise<void> {
    await this.deps.journal.append(sessionId, record);
  }

  /** Unclosed manifests from a previous process: status `applying`, never finalised. */
  async scanInterrupted(): Promise<SessionSummary[]> {
    const sessions = await this.deps.journal.summaries();
    return sessions.filter((session) => session.interrupted);
  }

  /** Every session whose changes may still be on the machine, interrupted or not. */
  async scanNeedingRecovery(): Promise<SessionSummary[]> {
    return this.deps.journal.sessionsNeedingRollback();
  }

  /**
   * Restore one session inside the cross-process lock, then mark its manifest with the
   * outcome. Safe to call twice: already-rolled-back entries are skipped.
   */
  async restore(
    sessionId: string,
    onProgress?: (entry: JournalEntry, current: number, total: number) => void,
  ): Promise<RollbackReport> {
    await this.deps.lock.acquire(`rollback:${sessionId}`);
    try {
      let manifest: SessionManifest;
      try {
        manifest = await this.deps.journal.readManifest(sessionId);
      } catch {
        throw new TuneSmithError('unavailable', `Session ${sessionId} was not found.`);
      }

      const report = await this.restoreEntries(sessionId, onProgress);
      await this.deps.journal.updateManifest(sessionId, {
        status: report.ok ? 'rolled-back' : 'rollback-failed',
        finishedAt: new Date().toISOString(),
        notes: [
          ...manifest.notes,
          report.ok
            ? `Rolled back ${report.restored} step(s).`
            : `Rollback incomplete: ${report.errors.join('; ')}`,
        ],
      });
      return report;
    } finally {
      await this.deps.lock.release();
      await this.deps.journal.close(sessionId);
    }
  }

  /**
   * Restore journal entries newest-first without taking the lock.
   *
   * Used by the executor for an automatic rollback, where the apply lock is already
   * held; taking it again would self-deadlock.
   */
  async restoreEntries(
    sessionId: string,
    onProgress?: (entry: JournalEntry, current: number, total: number) => void,
  ): Promise<RollbackReport> {
    const entries = await this.deps.journal.entries(sessionId);

    // `pending` entries were announced but have no outcome: after a crash we cannot know
    // whether the mutation landed, so restore them as if it did. `failed` entries are
    // included too, because an action may have failed after its first system call
    // already succeeded. `isRestorable` encodes that conservative rule.
    const targets = entries
      .filter((entry) => isRestorable(entry) && entry.rolledBack !== true)
      .sort((a, b) => b.seq - a.seq);

    const total = targets.length;
    let restored = 0;
    const errors: string[] = [];

    for (const [index, entry] of targets.entries()) {
      onProgress?.(entry, index + 1, total);
      try {
        await this.deps.adapter.restore(entry.before);
        await this.deps.journal.append(sessionId, {
          type: 'rollback',
          seq: entry.seq,
          ok: true,
        });
        restored += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.deps.journal.append(sessionId, {
          type: 'rollback',
          seq: entry.seq,
          ok: false,
          error: message,
        });
        errors.push(`${entry.label}: ${message}`);
      }
    }

    return {
      sessionId,
      restored,
      failed: errors.length,
      errors,
      ok: errors.length === 0,
      message:
        errors.length === 0
          ? restored === 0
            ? 'Nothing needed restoring.'
            : `Restored ${restored} change(s) to their original values.`
          : `Restored ${restored} change(s), ${errors.length} failed. See the session log.`,
    };
  }
}
