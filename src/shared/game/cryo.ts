/**
 * Cryo-Freeze: automatic suspension of non-essential background processes while a
 * game session is active.
 *
 * This is deliberately an allowlist, not a pattern or a user-supplied process list.
 * The only names here are well-known sync clients, updaters and the Windows telemetry
 * runner. The shared policy deny/caution maps are applied again before use, so a future
 * edit cannot accidentally promote a shell or security process into this list.
 *
 * The controller keeps the mechanics (durable session record and NtSuspendProcess) in
 * `GameAdapter`; this module only owns the candidate vocabulary.
 */
import { SUSPEND_CAUTION, SUSPEND_DENYLIST } from './policy';
import type { GameProfile } from './types';

export type CryoFreezeCategory = 'cloud-sync' | 'updater' | 'telemetry';

export interface CryoFreezeCandidate {
  /** Bare image name. */
  process: string;
  /** Short human label for logs and future UI detail. */
  label: string;
  category: CryoFreezeCategory;
}

export const CRYO_FREEZE_PROFILE_ID = 'cryo-freeze';

/** Kept small: a game does not need dozens of suspension records to reclaim headroom. */
export const CRYO_FREEZE_MAX = 12;

export const CRYO_FREEZE_CANDIDATES: readonly CryoFreezeCandidate[] = [
  { process: 'OneDrive.exe', label: 'OneDrive', category: 'cloud-sync' },
  { process: 'OneDriveStandaloneUpdater.exe', label: 'OneDrive updater', category: 'updater' },
  { process: 'Dropbox.exe', label: 'Dropbox', category: 'cloud-sync' },
  { process: 'GoogleDriveFS.exe', label: 'Google Drive', category: 'cloud-sync' },
  { process: 'MegaSync.exe', label: 'MEGA sync', category: 'cloud-sync' },
  { process: 'pCloud.exe', label: 'pCloud', category: 'cloud-sync' },
  { process: 'Nextcloud.exe', label: 'Nextcloud', category: 'cloud-sync' },
  { process: 'SynologyDrive.exe', label: 'Synology Drive', category: 'cloud-sync' },
  { process: 'GoogleUpdate.exe', label: 'Google updater', category: 'updater' },
  { process: 'MicrosoftEdgeUpdate.exe', label: 'Edge updater', category: 'updater' },
  { process: 'AdobeARM.exe', label: 'Adobe updater', category: 'updater' },
  { process: 'CompatTelRunner.exe', label: 'Windows telemetry runner', category: 'telemetry' },
];

/** Image names the watcher must include when Cryo-Freeze is armed. */
export function cryoFreezeNames(): string[] {
  return CRYO_FREEZE_CANDIDATES.filter((candidate) => {
    const name = candidate.process.toLowerCase();
    return !SUSPEND_DENYLIST.has(name) && !SUSPEND_CAUTION.has(name);
  }).map((candidate) => candidate.process.toLowerCase());
}

/**
 * Smaller machines get a smaller freeze budget. This mirrors the profile suspension
 * cap: freezing most of a four-core machine's background work can starve the game's
 * own launcher, voice chat or audio path.
 */
export function cryoFreezeBudget(logicalProcessors: number): number {
  if (!Number.isFinite(logicalProcessors) || logicalProcessors <= 0) return 6;
  if (logicalProcessors <= 4) return 2;
  if (logicalProcessors <= 8) return 6;
  return CRYO_FREEZE_MAX;
}

/**
 * A synthetic profile for a detected library game that has no installed profile.
 * It grants no tuning actions; it only lets the controller start a session so the
 * automatic freeze list can be applied and restored through the normal journal.
 */
export function cryoFreezeProfile(exe: string): GameProfile {
  return {
    schemaVersion: 1,
    id: CRYO_FREEZE_PROFILE_ID,
    name: 'Cryo-Freeze',
    version: '1.0.0',
    description: 'Automatic background process suspension while a detected game is active.',
    authors: [{ handle: 'tunesmith' }],
    license: 'MIT',
    risk: 'conservative',
    trigger: { exe },
    actions: {},
  };
}
