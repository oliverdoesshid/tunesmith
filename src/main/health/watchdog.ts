/**
 * Passive system health watchdog.
 *
 * It observes a small, fixed surface (build/UBR, servicing flags, and hashes of four
 * core system images), compares it with a persisted baseline, and reports drift. It has
 * no mutation capability: recovery stays in the existing preview/apply path, and journal
 * cleanup is an explicit user action restricted to old, fully restored sessions.
 */
import { describeError, TuneSmithError } from '../../shared/errors';
import type {
  HealthFlushResult,
  HealthJournalStatus,
  HealthStatus,
  PinnedPresetInfo,
  HealthSnapshot,
} from '../../shared/health/types';
import type { JournalFlushResult } from '../engine/journal';
import { compareHealth } from './compare';
import type { HealthStore } from './store';

export const DEFAULT_HEALTH_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_STALE_JOURNAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface HealthJournalPort {
  journalHealth(nowMs: number, olderThanMs: number): Promise<{ stale: number; needingRollback: number }>;
  flushStale(nowMs: number, olderThanMs: number): Promise<JournalFlushResult>;
}

export interface HealthWatchdogOptions {
  store: HealthStore;
  probe: () => Promise<HealthSnapshot>;
  journal: HealthJournalPort;
  resolvePreset: (presetId: string) => Promise<PinnedPresetInfo | null>;
  now?: () => Date;
  intervalMs?: number;
  staleAfterMs?: number;
  log?: (line: string) => void;
}

function emptyJournals(staleAfterDays: number): HealthJournalStatus {
  return { stale: 0, needingRollback: 0, staleAfterDays };
}

export class HealthWatchdog {
  private readonly options: HealthWatchdogOptions;
  private readonly intervalMs: number;
  private readonly staleAfterMs: number;
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<HealthStatus> | null = null;
  private baseline: HealthSnapshot | null = null;
  private latest: HealthSnapshot | null = null;
  private pinnedPresetId: string | null = null;
  private readonly listeners = new Set<(status: HealthStatus) => void>();
  private status: HealthStatus;

  constructor(options: HealthWatchdogOptions) {
    this.options = options;
    this.intervalMs = options.intervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_JOURNAL_MS;
    this.status = {
      watchdog: 'starting',
      lastCheckAt: null,
      baselineCapturedAt: null,
      os: null,
      signals: [],
      warnings: [],
      error: null,
      pinnedPresetId: null,
      pinnedPreset: null,
      pinnedPresetMissing: false,
      journals: emptyJournals(Math.round(this.staleAfterMs / (24 * 60 * 60 * 1000))),
    };
  }

  onStatus(listener: (status: HealthStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  statusSnapshot(): HealthStatus {
    return this.status;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    try {
      [this.baseline, this.pinnedPresetId] = await Promise.all([
        this.options.store.loadBaseline(),
        this.options.store.loadSettings().then((settings) => settings.pinnedPresetId),
      ]);
    } catch (error) {
      this.log(`baseline load failed: ${describeError(error)}`);
    }

    await this.check();

    if (this.timer === null) {
      this.timer = setInterval(() => {
        void this.check().catch((error: unknown) => this.log(`periodic check failed: ${describeError(error)}`));
      }, this.intervalMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  async check(): Promise<HealthStatus> {
    if (this.inFlight !== null) return this.inFlight;
    const pending = this.runCheck();
    this.inFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.inFlight === pending) this.inFlight = null;
    }
  }

  private async runCheck(): Promise<HealthStatus> {
    const now = this.options.now?.() ?? new Date();
    const nowMs = now.getTime();

    try {
      const snapshot = await this.options.probe();
      this.latest = snapshot;

      if (this.baseline === null) {
        await this.options.store.saveBaseline(snapshot);
        this.baseline = snapshot;
      }

      const journal = await this.options.journal.journalHealth(nowMs, this.staleAfterMs);
      const pinned = await this.resolvePinned();

      this.status = {
        watchdog: 'healthy',
        lastCheckAt: now.toISOString(),
        baselineCapturedAt: this.baseline.capturedAt,
        os: snapshot.os,
        signals: this.baseline === snapshot ? [] : compareHealth(this.baseline, snapshot),
        warnings: snapshot.warnings,
        error: null,
        pinnedPresetId: this.pinnedPresetId,
        pinnedPreset: pinned.preset,
        pinnedPresetMissing: pinned.missing,
        journals: {
          stale: journal.stale,
          needingRollback: journal.needingRollback,
          staleAfterDays: Math.round(this.staleAfterMs / (24 * 60 * 60 * 1000)),
        },
      };
    } catch (error) {
      const message = describeError(error).replace(/\s+/g, ' ').slice(0, 300);
      this.status = {
        ...this.status,
        watchdog: 'error',
        lastCheckAt: now.toISOString(),
        error: message,
      };
      this.log(`check failed: ${message}`);
    }

    this.emit();
    return this.status;
  }

  async pin(presetId: string | null): Promise<HealthStatus> {
    this.pinnedPresetId = presetId;
    await this.options.store.saveSettings({ schemaVersion: 1, pinnedPresetId: presetId });
    const pinned = await this.resolvePinned();
    this.status = {
      ...this.status,
      pinnedPresetId: presetId,
      pinnedPreset: pinned.preset,
      pinnedPresetMissing: pinned.missing,
    };
    this.emit();
    return this.status;
  }

  /** Accept the latest observation as the new baseline and clear drift signals. */
  async acknowledge(): Promise<HealthStatus> {
    if (this.isFailed()) {
      throw new TuneSmithError('unavailable', 'Cannot accept a health baseline while checks are failing.');
    }
    if (this.latest === null) await this.check();
    if (this.isFailed()) {
      throw new TuneSmithError('unavailable', 'Cannot accept a health baseline while checks are failing.');
    }
    if (this.latest === null) return this.status;

    this.baseline = this.latest;
    await this.options.store.saveBaseline(this.latest);
    this.status = {
      ...this.status,
      signals: [],
      baselineCapturedAt: this.latest.capturedAt,
      error: null,
    };
    this.emit();
    return this.status;
  }

  /** Explicit action: remove only old, finished journals with no pending changes. */
  async flushJournals(): Promise<HealthFlushResult> {
    const now = this.options.now?.() ?? new Date();
    const result = await this.options.journal.flushStale(now.getTime(), this.staleAfterMs);
    const journals = await this.options.journal.journalHealth(now.getTime(), this.staleAfterMs);
    this.status = {
      ...this.status,
      journals: {
        stale: journals.stale,
        needingRollback: journals.needingRollback,
        staleAfterDays: Math.round(this.staleAfterMs / (24 * 60 * 60 * 1000)),
      },
    };
    this.emit();

    const message =
      result.flushed.length === 0
        ? 'No stale journals were old enough to remove.'
        : `Removed ${result.flushed.length} stale journal(s); ${result.kept.length} retained.`;
    return { ...result, message };
  }

  private isFailed(): boolean {
    return this.status.watchdog === 'error';
  }

  private async resolvePinned(): Promise<{ preset: PinnedPresetInfo | null; missing: boolean }> {
    if (this.pinnedPresetId === null) return { preset: null, missing: false };
    try {
      const preset = await this.options.resolvePreset(this.pinnedPresetId);
      return preset === null ? { preset: null, missing: true } : { preset, missing: false };
    } catch (error) {
      this.log(`pinned preset lookup failed: ${describeError(error)}`);
      return { preset: null, missing: true };
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.status);
      } catch {
        // A dead renderer must not stop the watchdog.
      }
    }
  }

  private log(line: string): void {
    this.options.log?.(line);
  }
}
