/**
 * System health types.
 *
 * The watchdog is deliberately a separate domain from tuning sessions: it observes
 * whether the OS underneath an existing journal has moved, but it never replays or
 * rewrites a journal on its own. All renderer payloads are JSON-serialisable.
 */

export type HealthSignalKind = 'os-update' | 'servicing' | 'system-file';

export interface HealthOsInfo {
  build: string;
  revision: number | null;
  displayVersion: string | null;
}

export interface HealthServicingState {
  rebootPending: boolean;
  packagesPending: boolean;
  windowsUpdateReboot: boolean;
  pendingFileRename: boolean;
}

export interface HealthFileFingerprint {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

/** One read-only observation, persisted as the baseline after the first run. */
export interface HealthSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  os: HealthOsInfo;
  servicing: HealthServicingState;
  files: HealthFileFingerprint[];
  warnings: string[];
}

export interface HealthSignal {
  id: string;
  kind: HealthSignalKind;
  severity: 'warning';
  title: string;
  detail: string;
}

export interface PinnedPresetInfo {
  id: string;
  name: string;
  version: string;
}

export interface HealthJournalStatus {
  /** Finished, clean journals older than the cleanup threshold. */
  stale: number;
  /** Journals whose captured changes may still be on the machine. Never auto-flushed. */
  needingRollback: number;
  staleAfterDays: number;
}

export interface HealthStatus {
  watchdog: 'starting' | 'healthy' | 'error';
  lastCheckAt: string | null;
  baselineCapturedAt: string | null;
  os: HealthOsInfo | null;
  signals: HealthSignal[];
  /** Inputs that could not be read during the latest check; empty when complete. */
  warnings: string[];
  error: string | null;
  pinnedPresetId: string | null;
  pinnedPreset: PinnedPresetInfo | null;
  pinnedPresetMissing: boolean;
  journals: HealthJournalStatus;
}

export interface HealthFlushResult {
  flushed: string[];
  kept: { id: string; reason: string }[];
  message: string;
}
