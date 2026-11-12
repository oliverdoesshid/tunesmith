/**
 * Auto-update status shared by the main process, preload and renderer.
 *
 * The status contains display data only. No update URL, token, downloaded path or
 * installer argument is ever exposed to the renderer.
 */

export type UpdaterPhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error';

export interface UpdaterStatus {
  schemaVersion: 1;
  phase: UpdaterPhase;
  /** Version currently running. */
  currentVersion: string;
  /** Version offered by the release feed, if one has been seen. */
  availableVersion: string | null;
  /** Download percentage in the range 0–100, or null when not downloading. */
  percent: number | null;
  /** Current download rate in bytes per second, when the updater reports it. */
  bytesPerSecond: number | null;
  /** Short, display-safe status line. */
  message: string | null;
  /** ISO timestamp of the last completed check or failure. */
  checkedAt: string | null;
  /** False in development builds, where update checks are deliberately disabled. */
  isPackaged: boolean;
}

export function initialUpdaterStatus(isPackaged: boolean, currentVersion: string): UpdaterStatus {
  return {
    schemaVersion: 1,
    phase: isPackaged ? 'idle' : 'disabled',
    currentVersion,
    availableVersion: null,
    percent: null,
    bytesPerSecond: null,
    message: isPackaged ? 'Automatic update checks are enabled.' : 'Updates are disabled in development builds.',
    checkedAt: null,
    isPackaged,
  };
}
