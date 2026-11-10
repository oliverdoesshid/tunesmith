/**
 * The execution and safety engine.
 *
 * Contract (enforced here, not by convention):
 *   1. A step is only applied after its prior state is durable in the journal.
 *   2. Any failure stops the run and rolls back everything already applied.
 *   3. Rollback is idempotent and safe to run twice.
 *   4. A crash mid-apply leaves an `applying` session whose un-finalised steps are
 *      rolled back conservatively on the next run.
 *
 * The executor never sees preset JSON: it receives a compiled plan of typed steps.
 */
import { randomUUID } from 'node:crypto';
import { describeError, TuneSmithError } from '../../shared/errors';
import type { CompiledPlan, PlannedStep } from '../../shared/preset/compiler';
import type {
  ApplyOutcome,
  EngineProgress,
  JournalEntry,
  JournalRecord,
  RestorePointInfo,
  RollbackReport,
} from '../../shared/session';
import type { StepAdapter } from './adapter';
import { isRestorable, JournalStore, newSessionManifest } from './journal';
import type { SessionLock } from './lock';

export interface ExecutorDeps {
  adapter: StepAdapter;
  journal: JournalStore;
  lock: SessionLock;
  appVersion: string;
  log?: (line: string) => void;
  createRestorePoint?: (description: string) => Promise<RestorePointInfo>;
}

export interface ApplyOptions {
  acknowledgeConsent: boolean;
  acknowledgeRisk: boolean;
}

export class Executor {
  private readonly deps: ExecutorDeps;
  /** Assigned by the IPC layer once a window exists. */
  onProgress: ((progress: EngineProgress) => void) | null = null;

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
  }

  private progress(progress: EngineProgress): void {
    try {
      this.onProgress?.(progress);
    } catch {
      // A dead renderer must never abort a rollback.
    }
  }

  private log(line: string): void {
    this.deps.log?.(line);
  }

  async apply(plan: CompiledPlan, options: ApplyOptions): Promise<ApplyOutcome> {
    this.assertApplicable(plan, options);

    await this.deps.lock.acquire(`apply:${plan.presetId}`);
    const sessionId = randomUUID();
    let appliedSteps = 0;

    try {
      await this.deps.journal.createSession(
        newSessionManifest({
          id: sessionId,
          presetId: plan.presetId,
          presetName: plan.presetName,
          presetVersion: plan.presetVersion,
          presetRisk: plan.risk,
          signature: plan.signature,
          appVersion: this.deps.appVersion,
          stepCount: plan.steps.length,
        }),
      );

      const restorePoint = await this.ensureRestorePoint(sessionId, plan);
      if (plan.restorePoint === 'required' && !restorePoint.ok) {
        await this.deps.journal.updateManifest(sessionId, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          notes: ['Aborted before any mutation: a restore point was required but could not be created.'],
        });
        return {
          sessionId,
          presetId: plan.presetId,
          status: 'failed',
          appliedSteps: 0,
          skippedSteps: plan.steps.length,
          failedStep: { label: 'System Restore', error: restorePoint.detail },
          autoRolledBack: false,
          restorePoint,
          message: 'Aborted before changing anything: this preset requires a restore point.',
        };
      }

      const failure = await this.applySteps(sessionId, plan, (count) => {
        appliedSteps = count;
      });

      if (failure !== null) {
        this.progress({ phase: 'error', message: `Step failed: ${failure.label}. Rolling back…` });
        const rollback = await this.rollbackInside(sessionId);
        await this.deps.journal.updateManifest(sessionId, {
          status: rollback.ok ? 'failed' : 'rollback-failed',
          finishedAt: new Date().toISOString(),
          notes: [
            `Failed at "${failure.label}": ${failure.error}`,
            rollback.ok
              ? `Auto-rollback restored ${rollback.restored} step(s).`
              : `Auto-rollback incomplete: ${rollback.errors.join('; ')}`,
          ],
        });

        return {
          sessionId,
          presetId: plan.presetId,
          status: 'failed',
          appliedSteps,
          skippedSteps: Math.max(0, plan.steps.length - appliedSteps - 1),
          failedStep: failure,
          autoRolledBack: rollback.restored > 0,
          restorePoint,
          message: rollback.ok
            ? `Preset failed at "${failure.label}" and every change was rolled back.`
            : `Preset failed at "${failure.label}" and rollback was incomplete. Review the session log before rebooting.`,
        };
      }

      await this.deps.journal.updateManifest(sessionId, {
        status: 'applied',
        finishedAt: new Date().toISOString(),
        notes: [`Applied ${appliedSteps} step(s).`],
      });
      this.progress({ phase: 'done', message: `${plan.presetName} applied.` });

      return {
        sessionId,
        presetId: plan.presetId,
        status: 'applied',
        appliedSteps,
        skippedSteps: Math.max(0, plan.steps.length - appliedSteps),
        failedStep: null,
        autoRolledBack: false,
        restorePoint,
        message: `${appliedSteps} change(s) applied. You can undo this from Sessions.`,
      };
    } finally {
      await this.deps.journal.close(sessionId);
      await this.deps.lock.release();
    }
  }

  private assertApplicable(plan: CompiledPlan, options: ApplyOptions): void {
    if (plan.blocked) {
      const reasons = plan.findings.filter((f) => f.severity === 'block').map((f) => f.message);
      throw new TuneSmithError('preset-invalid', 'This preset is blocked by policy.', reasons.join(' '));
    }
    if (!plan.compatibility.applicable) {
      throw new TuneSmithError('preset-invalid', 'This preset does not target the detected hardware.');
    }
    if (plan.steps.length === 0) {
      throw new TuneSmithError('preset-invalid', 'The preset produced no actions for this machine.');
    }
    if (plan.needsConsent && !options.acknowledgeConsent) {
      throw new TuneSmithError('invalid-request', 'This preset needs explicit acknowledgement of sensitive changes.');
    }
    if (plan.risk === 'aggressive' && !options.acknowledgeRisk) {
      throw new TuneSmithError('invalid-request', 'Aggressive presets require an explicit risk acknowledgement.');
    }
  }

  private async ensureRestorePoint(sessionId: string, plan: CompiledPlan): Promise<RestorePointInfo> {
    const skip: RestorePointInfo = { attempted: false, ok: false, detail: 'Not requested by this preset.' };
    if (plan.restorePoint === 'none') return skip;

    if (this.deps.createRestorePoint === undefined) {
      const unsupported: RestorePointInfo = {
        attempted: false,
        ok: false,
        detail: 'Restore points are unavailable in this build; rollback relies on the journal.',
      };
      await this.deps.journal.updateManifest(sessionId, { restorePoint: unsupported });
      return unsupported;
    }

    this.progress({ phase: 'restore-point', message: 'Creating a System Restore checkpoint…' });
    let info: RestorePointInfo;
    try {
      info = await this.deps.createRestorePoint(`TuneSmith ${plan.presetId} ${new Date().toISOString().slice(0, 16)}`);
    } catch (err) {
      info = { attempted: true, ok: false, detail: describeError(err) };
    }

    await this.deps.journal.updateManifest(sessionId, { restorePoint: info });
    if (info.attempted) this.log(`restore point: ${info.ok ? 'ok' : 'failed'} — ${info.detail}`);
    return info;
  }

  private async applySteps(
    sessionId: string,
    plan: CompiledPlan,
    onApplied: (count: number) => void,
  ): Promise<{ label: string; error: string } | null> {
    let applied = 0;
    let seq = 0;

    for (const step of plan.steps) {
      seq += 1;
      const total = plan.steps.length;
      this.progress({ phase: 'apply', message: step.label, current: seq, total });

      // Capture *immediately* before mutating: a separate pre-pass would widen the
      // window in which the machine can change underneath us.
      let before: JournalEntry['before'];
      try {
        before = await this.deps.adapter.capture(step);
      } catch (err) {
        return { label: step.label, error: `could not capture the current state: ${describeError(err)}` };
      }

      const at = new Date().toISOString();
      const record: JournalRecord = {
        type: 'entry',
        seq,
        at,
        entry: { seq, at, key: step.key, group: step.group, label: step.label, target: step.target, before },
      };

      try {
        await this.deps.journal.append(sessionId, record);
      } catch (err) {
        // No durable record means no permission to mutate.
        return { label: step.label, error: `journal write failed, refusing to continue: ${describeError(err)}` };
      }

      try {
        await this.deps.adapter.apply(step, before);
        await this.deps.journal.append(sessionId, { type: 'outcome', seq, status: 'applied' });
        applied += 1;
        onApplied(applied);
        this.progress({
          phase: 'apply',
          message: step.label,
          current: seq,
          total,
          step: { label: step.label, target: step.target, status: 'applied' },
        });
      } catch (err) {
        const message = describeError(err);
        await this.deps.journal.append(sessionId, { type: 'outcome', seq, status: 'failed', error: message });
        this.progress({
          phase: 'apply',
          message: step.label,
          current: seq,
          total,
          step: { label: step.label, target: step.target, status: 'failed' },
        });
        return { label: step.label, error: message };
      }
    }

    return null;
  }

  async rollback(sessionId: string): Promise<RollbackReport> {
    await this.deps.lock.acquire(`rollback:${sessionId}`);
    try {
      let manifest: Awaited<ReturnType<JournalStore['readManifest']>>;
      try {
        manifest = await this.deps.journal.readManifest(sessionId);
      } catch {
        throw new TuneSmithError('unavailable', `Session ${sessionId} was not found.`);
      }

      const report = await this.rollbackInside(sessionId);
      await this.deps.journal.updateManifest(sessionId, {
        status: report.ok ? 'rolled-back' : 'rollback-failed',
        finishedAt: new Date().toISOString(),
        notes: [
          ...manifest.notes,
          report.ok ? `Rolled back ${report.restored} step(s).` : `Rollback incomplete: ${report.errors.join('; ')}`,
        ],
      });
      return report;
    } finally {
      await this.deps.lock.release();
      await this.deps.journal.close(sessionId);
    }
  }

  /** Undo every applied or announced-but-unfinished step, newest first. */
  private async rollbackInside(sessionId: string): Promise<RollbackReport> {
    const entries = await this.deps.journal.entries(sessionId);

    // `pending` entries were announced but have no outcome: after a crash we cannot
    // know whether the mutation landed, so we restore them as if it did. `failed`
    // entries are included too, because an action may have failed after its first
    // system call already succeeded.
    const targets = entries.filter((e) => isRestorable(e) && e.rolledBack !== true).sort((a, b) => b.seq - a.seq);

    const total = targets.length;
    let restored = 0;
    const errors: string[] = [];

    for (const [index, entry] of targets.entries()) {
      this.progress({ phase: 'rollback', message: entry.label, current: index + 1, total });
      try {
        await this.deps.adapter.restore(entry.before);
        await this.deps.journal.append(sessionId, { type: 'rollback', seq: entry.seq, ok: true });
        restored += 1;
      } catch (err) {
        const message = describeError(err);
        await this.deps.journal.append(sessionId, { type: 'rollback', seq: entry.seq, ok: false, error: message });
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

  /** "Restore to Default": roll back every session that still has changes on the machine. */
  async restoreDefaults(): Promise<RollbackReport[]> {
    const sessions = await this.deps.journal.sessionsNeedingRollback();
    const reports: RollbackReport[] = [];

    for (const session of sessions) {
      try {
        reports.push(await this.rollback(session.id));
      } catch (err) {
        reports.push({
          sessionId: session.id,
          restored: 0,
          failed: 1,
          errors: [describeError(err)],
          ok: false,
          message: `Could not restore session ${session.id}: ${describeError(err)}`,
        });
      }
    }

    return reports;
  }

  /** Sessions that were cut off mid-apply and still hold unrolled changes. */
  async interruptedSessions(): Promise<{ id: string; presetName: string; createdAt: string }[]> {
    const sessions = await this.deps.journal.sessionsNeedingRollback();
    return sessions
      .filter((s) => s.status === 'applying')
      .map((s) => ({ id: s.id, presetName: s.presetName, createdAt: s.createdAt }));
  }
}

/** Exposed for tests: a plan with no steps must never reach the adapter. */
export function stepTargets(plan: CompiledPlan): string[] {
  return plan.steps.map((s: PlannedStep) => s.target);
}
