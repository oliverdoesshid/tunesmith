/**
 * Post-apply stability and thermal watchdog.
 *
 * It runs only after a preset with `risk: aggressive` reports a successful apply. For
 * five minutes it samples temperature and Windows DPC time. A temperature above 90 °C,
 * sustained DPC pressure, or a main-process stall consistent with a system freeze calls
 * the existing journal rollback immediately — there is no exit grace period and no
 * separate mutation path.
 *
 * Limits are stated because they are not absolute safety guarantees:
 *  - Temperature needs a supported sensor provider. Missing sensors are reported as
 *    unavailable, not treated as cool.
 *  - DPC monitoring reads `% DPC Time`, not hardware interrupt latency.
 *  - The freeze detector observes this process's event-loop stall. A total machine
 *    freeze cannot be acted on until it ends; once it does, the watchdog rolls back.
 */
import { describeError } from '../../shared/errors';
import type {
  PostApplyPhase,
  PostApplyProbeSample,
  PostApplyStatus,
  PostApplyTrip,
} from '../../shared/post-apply';
import { idlePostApplyStatus } from '../../shared/post-apply';
import type { RollbackReport } from '../../shared/session';

export const POST_APPLY_LIMITS = {
  monitorMs: 5 * 60 * 1_000,
  sampleMs: 15_000,
  maxTemperatureC: 90,
  dpcPercent: 8,
  dpcConsecutiveSamples: 2,
  freezeStallMs: 15_000,
} as const;

export interface PostApplyWatchdogDeps {
  rollback(sessionId: string): Promise<RollbackReport>;
  probe(): Promise<PostApplyProbeSample>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  onStatus?: (status: PostApplyStatus) => void;
  log?: (line: string) => void;
  monitorMs?: number;
  sampleMs?: number;
}

export interface PostApplyStart {
  sessionId: string;
  presetId: string;
  presetName: string;
}

function rollbackFailure(sessionId: string, error: unknown): RollbackReport {
  return {
    sessionId,
    restored: 0,
    failed: 1,
    errors: [describeError(error)],
    ok: false,
    message: `Automatic rollback failed: ${describeError(error)}`,
  };
}

export class PostApplyWatchdog {
  private readonly rollback: (sessionId: string) => Promise<RollbackReport>;
  private readonly probe: () => Promise<PostApplyProbeSample>;
  private readonly clock: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly log: (line: string) => void;
  private readonly monitorMs: number;
  private readonly sampleMs: number;

  private state: PostApplyStatus = idlePostApplyStatus();
  private onStatus: ((status: PostApplyStatus) => void) | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private expectedAt = 0;
  private deadline = 0;
  private monitoring = false;
  private rollingBack = false;
  private dpcConsecutive = 0;

  constructor(deps: PostApplyWatchdogDeps) {
    this.rollback = deps.rollback;
    this.probe = deps.probe;
    this.clock = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
    this.log = deps.log ?? (() => {});
    this.monitorMs = deps.monitorMs ?? POST_APPLY_LIMITS.monitorMs;
    this.sampleMs = deps.sampleMs ?? POST_APPLY_LIMITS.sampleMs;
    this.onStatus = deps.onStatus ?? null;
  }

  setOnStatus(listener: (status: PostApplyStatus) => void): void {
    this.onStatus = listener;
  }

  status(): PostApplyStatus {
    return { ...this.state, remainingMs: this.remainingMs() };
  }

  /** Start monitoring a successfully applied aggressive preset. */
  start(input: PostApplyStart): PostApplyStatus {
    if (this.rollingBack) return this.status();
    this.stopTimer();
    this.monitoring = true;
    this.dpcConsecutive = 0;
    const started = this.clock();
    this.deadline = started + this.monitorMs;
    this.expectedAt = started;

    this.state = {
      phase: 'monitoring',
      active: true,
      sessionId: input.sessionId,
      presetId: input.presetId,
      presetName: input.presetName,
      startedAt: new Date(started).toISOString(),
      endsAt: new Date(this.deadline).toISOString(),
      remainingMs: this.monitorMs,
      sampleCount: 0,
      sample: null,
      trip: null,
      rollback: null,
      message: `Watching stability for 5 minutes after applying ${input.presetName}.`,
    };
    this.log(`watching ${input.presetId} for ${String(this.monitorMs / 1000)}s`);
    this.emit();
    this.schedule(0);
    return this.status();
  }

  /** Cancel monitoring for a user-initiated rollback or a new apply. */
  cancel(reason = 'Monitoring cancelled.'): PostApplyStatus {
    if (this.rollingBack) return this.status();
    this.stopTimer();
    this.monitoring = false;
    if (this.state.phase === 'monitoring') {
      this.state = {
        ...this.state,
        phase: 'cancelled',
        active: false,
        remainingMs: 0,
        message: reason,
      };
      this.emit();
    }
    return this.status();
  }

  reset(): PostApplyStatus {
    this.stopTimer();
    this.monitoring = false;
    this.rollingBack = false;
    this.dpcConsecutive = 0;
    this.state = idlePostApplyStatus();
    this.emit();
    return this.status();
  }

  dispose(): void {
    this.stopTimer();
    this.monitoring = false;
    this.state = idlePostApplyStatus();
  }

  private remainingMs(): number {
    if (!this.state.active) return 0;
    return Math.max(0, Math.min(this.monitorMs, this.deadline - this.clock()));
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private schedule(delay: number): void {
    if (!this.monitoring) return;
    this.expectedAt = this.clock() + delay;
    this.timer = this.setTimer(() => {
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (!this.monitoring) return;

    const lateness = this.clock() - this.expectedAt;
    if (lateness > POST_APPLY_LIMITS.freezeStallMs) {
      await this.trip({
        kind: 'freeze',
        at: new Date(this.clock()).toISOString(),
        message: `TuneSmith was unresponsive for ${Math.round(lateness / 1000)}s during the stability window. A system freeze is possible; rolling back before waiting further.`,
      });
      return;
    }

    await this.sample();
    if (!this.monitoring) return;

    if (this.clock() >= this.deadline) {
      this.finishStable();
      return;
    }
    this.schedule(Math.max(0, Math.min(this.sampleMs, this.deadline - this.clock())));
  }

  private async sample(): Promise<void> {
    let sample: PostApplyProbeSample;
    try {
      sample = await this.probe();
    } catch (error) {
      this.state = {
        ...this.state,
        message: `Stability probe unavailable: ${describeError(error)}. Monitoring continues, but no sensor verdict is possible.`,
      };
      this.emit();
      return;
    }
    if (!this.monitoring) return;

    this.state = {
      ...this.state,
      sample,
      sampleCount: this.state.sampleCount + 1,
    };

    if (sample.cpuTempC !== null && sample.cpuTempC > POST_APPLY_LIMITS.maxTemperatureC) {
      await this.trip({
        kind: 'cpu-temp',
        at: sample.at,
        message: `CPU temperature reached ${sample.cpuTempC}°C (limit ${POST_APPLY_LIMITS.maxTemperatureC}°C). Rolling back immediately.`,
      });
      return;
    }
    if (sample.gpuTempC !== null && sample.gpuTempC > POST_APPLY_LIMITS.maxTemperatureC) {
      await this.trip({
        kind: 'gpu-temp',
        at: sample.at,
        message: `GPU temperature reached ${sample.gpuTempC}°C (limit ${POST_APPLY_LIMITS.maxTemperatureC}°C). Rolling back immediately.`,
      });
      return;
    }

    if (sample.dpcPercent !== null && sample.dpcPercent >= POST_APPLY_LIMITS.dpcPercent) {
      this.dpcConsecutive += 1;
      this.state = {
        ...this.state,
        message: `DPC pressure is ${sample.dpcPercent.toFixed(1)}% (trip threshold ${POST_APPLY_LIMITS.dpcPercent}%, sample ${this.dpcConsecutive}/${POST_APPLY_LIMITS.dpcConsecutiveSamples}).`,
      };
      if (this.dpcConsecutive >= POST_APPLY_LIMITS.dpcConsecutiveSamples) {
        await this.trip({
          kind: 'dpc',
          at: sample.at,
          message: `Sustained DPC pressure at ${sample.dpcPercent.toFixed(1)}% of processor time. The preset is being rolled back because a driver-level stall can make the machine unresponsive.`,
        });
        return;
      }
    } else {
      this.dpcConsecutive = 0;
      this.state = {
        ...this.state,
        message:
          sample.cpuTempC === null && sample.gpuTempC === null && sample.dpcPercent === null
            ? 'Monitoring continues; this machine exposes no temperature or DPC data, so no sensor verdict is possible.'
            : 'Stability window in progress.',
      };
    }
    this.emit();
  }

  private async trip(trip: PostApplyTrip): Promise<void> {
    if (!this.monitoring && this.state.phase !== 'monitoring') return;
    this.stopTimer();
    this.monitoring = false;
    this.rollingBack = true;

    this.state = {
      ...this.state,
      phase: 'rolling-back',
      active: true,
      trip,
      message: `${trip.message} Automatic full rollback started.`,
    };
    this.log(`stability trip (${trip.kind}): ${trip.message}`);
    this.emit();

    const sessionId = this.state.sessionId;
    if (sessionId === null) {
      this.rollingBack = false;
      this.state = {
        ...this.state,
        phase: 'rollback-failed',
        active: false,
        rollback: {
          sessionId: '',
          restored: 0,
          failed: 1,
          errors: ['No session id was recorded.'],
          ok: false,
          message: 'Automatic rollback could not start: no session id.',
        },
        remainingMs: 0,
      };
      this.emit();
      return;
    }

    let report: RollbackReport;
    try {
      report = await this.rollback(sessionId);
    } catch (error) {
      report = rollbackFailure(sessionId, error);
    }

    this.rollingBack = false;
    const phase: PostApplyPhase = report.ok ? 'rolled-back' : 'rollback-failed';
    this.state = {
      ...this.state,
      phase,
      active: false,
      remainingMs: 0,
      rollback: report,
      message: report.ok
        ? `Stability trip: ${trip.message} All changes were rolled back.`
        : `Stability trip: ${trip.message} Rollback was incomplete — ${report.errors[0] ?? report.message}`,
    };
    this.log(`rollback ${report.ok ? 'ok' : 'incomplete'}: ${report.message}`);
    this.emit();
  }

  private finishStable(): void {
    this.stopTimer();
    this.monitoring = false;
    this.state = {
      ...this.state,
      phase: 'stable',
      active: false,
      remainingMs: 0,
      message: `Five-minute stability window completed without a trip. ${this.state.sampleCount} sample(s) taken.`,
    };
    this.log(`stability window stable after ${String(this.state.sampleCount)} sample(s)`);
    this.emit();
  }

  private emit(): void {
    try {
      this.onStatus?.(this.status());
    } catch {
      // A closed window must never break the watchdog or its rollback.
    }
  }
}
