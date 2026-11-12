/**
 * GitHub Releases auto-update service.
 *
 * `electron-updater` reads the GitHub provider from the `app-update.yml` that
 * electron-builder writes into the packaged resources directory. Development builds
 * deliberately never contact the feed: `app.isPackaged` gates both the scheduled
 * check and the renderer-facing check method.
 *
 * The renderer sees status only. It can request installation after a download has
 * completed, but it cannot supply a URL, a file path or installer arguments.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log/main';
import { TuneSmithError } from '../shared/errors';
import { initialUpdaterStatus, type UpdaterStatus } from '../shared/updater';

const DEFAULT_INITIAL_DELAY_MS = 5_000;
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 240;

export interface UpdaterAdapter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  fullChangelog: boolean;
  disableDifferentialDownload: boolean;
  logger: unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdaterServiceOptions {
  /** Defaults to `app.isPackaged`; injectable for tests. */
  isPackaged?: boolean;
  /** Defaults to `app.getVersion()`. */
  currentVersion?: string;
  /** Directory for the rotating `updater.log`. */
  logDirectory?: string;
  initialDelayMs?: number;
  checkIntervalMs?: number;
  updater?: UpdaterAdapter;
  now?: () => Date;
}

function clampPercent(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function readVersion(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('version' in value)) return null;
  const version = (value as { version?: unknown }).version;
  // The feed supplies this string; keep it to a version-shaped token so a compromised
  // payload cannot turn a version into a URL or a path in the renderer.
  return typeof version === 'string' && /^[0-9][0-9A-Za-z.+-]{0,79}$/.test(version)
    ? version
    : null;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS);
}

/**
 * Errors from electron-updater can contain a feed URL or an installer path. Keep those in
 * the log, never in the DTO that crosses the bridge.
 */
function publicErrorMessage(error: unknown): string {
  const raw = errorMessage(error).toLowerCase();
  if (raw.includes('checksum') || raw.includes('sha512') || raw.includes('integrity')) {
    return 'The downloaded update failed its integrity check.';
  }
  if (
    raw.includes('release feed') ||
    raw.includes('latest.yml') ||
    raw.includes('enotfound') ||
    raw.includes('eai_again') ||
    raw.includes('econn') ||
    raw.includes('etimedout') ||
    raw.includes('404')
  ) {
    return 'The release feed is unavailable.';
  }
  if (raw.includes('certificate') || raw.includes('ssl') || raw.includes('tls')) {
    return 'Could not establish a secure connection to the update feed.';
  }
  return 'The updater reported an error. See the updater log for details.';
}

function configureLogging(logDirectory: string | undefined): void {
  const directory = logDirectory ?? path.join(app.getPath('userData'), 'logs');
  try {
    mkdirSync(directory, { recursive: true });
    log.transports.file.level = 'info';
    log.transports.file.maxSize = LOG_MAX_BYTES;
    log.transports.file.fileName = 'updater.log';
    log.transports.file.resolvePathFn = () => path.join(directory, 'updater.log');
    log.transports.file.sync = true;
  } catch (error) {
    // The app's own logger is already active; an unwritable updater log must not
    // prevent the application from starting.
    log.warn('updater', 'could not configure the rotating updater log', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export class UpdaterService {
  private readonly isPackaged: boolean;
  private readonly initialDelayMs: number;
  private readonly checkIntervalMs: number;
  private readonly now: () => Date;
  private readonly updater: UpdaterAdapter;
  private readonly listeners = new Set<(status: UpdaterStatus) => void>();
  private statusValue: UpdaterStatus;
  private started = false;
  private checking = false;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: UpdaterServiceOptions = {}) {
    this.isPackaged = options.isPackaged ?? app.isPackaged;
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    this.updater = options.updater ?? (autoUpdater as unknown as UpdaterAdapter);
    this.statusValue = initialUpdaterStatus(this.isPackaged, options.currentVersion ?? app.getVersion());

    configureLogging(options.logDirectory);
    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.allowPrerelease = false;
    this.updater.allowDowngrade = false;
    this.updater.fullChangelog = false;
    // The NSIS target disables differential packages in package.json, so asking for
    // a differential download would only add a failed request before the full file.
    this.updater.disableDifferentialDownload = true;
    this.updater.logger = log;
    this.bindEvents();
  }

  status(): UpdaterStatus {
    return { ...this.statusValue };
  }

  onStatus(listener: (status: UpdaterStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Begin the delayed startup check and the six-hour interval. Packaged builds only. */
  start(): void {
    if (!this.isPackaged) {
      this.setStatus({
        phase: 'disabled',
        message: 'Updates are disabled in development builds.',
      });
      return;
    }
    if (this.started) return;
    this.started = true;

    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      void this.check();
    }, this.initialDelayMs);
    this.intervalTimer = setInterval(() => {
      void this.check();
    }, this.checkIntervalMs);
    this.initialTimer.unref?.();
    this.intervalTimer.unref?.();
    log.info('updater', 'scheduled automatic update checks', {
      initialDelayMs: this.initialDelayMs,
      checkIntervalMs: this.checkIntervalMs,
    });
  }

  /** Stop timers. Event listeners remain attached for the rest of this process. */
  dispose(): void {
    if (this.initialTimer !== null) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.intervalTimer !== null) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.started = false;
  }

  /** Check the release feed. Development builds return a disabled status without a request. */
  async check(): Promise<UpdaterStatus> {
    if (!this.isPackaged) {
      this.setStatus({
        phase: 'disabled',
        message: 'Updates are disabled in development builds.',
      });
      return this.status();
    }
    // Do not lose a ready-to-install update because an automatic interval fired
    // while the download or installer handoff is still in progress.
    if (
      this.checking ||
      this.statusValue.phase === 'available' ||
      this.statusValue.phase === 'downloading' ||
      this.statusValue.phase === 'downloaded'
    ) {
      return this.status();
    }

    this.checking = true;
    this.setStatus({
      phase: 'checking',
      percent: null,
      bytesPerSecond: null,
      message: 'Checking for updates…',
    });
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.handleError(error);
    } finally {
      this.checking = false;
    }
    return this.status();
  }

  /** Install the already-downloaded update. No renderer input is accepted. */
  async install(): Promise<void> {
    if (!this.isPackaged) {
      throw new TuneSmithError('unavailable', 'Updates are unavailable in development builds.');
    }
    if (this.statusValue.phase !== 'downloaded') {
      throw new TuneSmithError('unavailable', 'No update has been downloaded yet.');
    }

    log.info('updater', 'install requested', {
      from: this.statusValue.currentVersion,
      to: this.statusValue.availableVersion,
    });
    this.updater.quitAndInstall(false, true);
  }

  private bindEvents(): void {
    this.updater.on('checking-for-update', () => {
      this.setStatus({
        phase: 'checking',
        percent: null,
        bytesPerSecond: null,
        message: 'Checking for updates…',
      });
      log.info('updater', 'checking for updates');
    });

    this.updater.on('update-available', (info: unknown) => {
      const version = readVersion(info);
      this.setStatus({
        phase: 'available',
        availableVersion: version,
        percent: 0,
        bytesPerSecond: null,
        message: version === null ? 'An update is available; downloading…' : `Update ${version} is downloading…`,
      });
      log.info('updater', 'update available', { version });
    });

    this.updater.on('download-progress', (info: unknown) => {
      const percent = clampPercent(
        typeof info === 'object' && info !== null && 'percent' in info
          ? (info as { percent?: unknown }).percent
          : null,
      );
      const bytesPerSecond =
        typeof info === 'object' && info !== null && 'bytesPerSecond' in info
          ? (info as { bytesPerSecond?: unknown }).bytesPerSecond
          : null;
      const version = this.statusValue.availableVersion;
      this.setStatus({
        phase: 'downloading',
        percent,
        bytesPerSecond:
          typeof bytesPerSecond === 'number' && Number.isFinite(bytesPerSecond) && bytesPerSecond >= 0
            ? Math.round(bytesPerSecond)
            : null,
        message: `${version === null ? 'Update' : `Update ${version}`} downloading… ${percent.toFixed(1)}%`,
      });
    });

    this.updater.on('update-downloaded', (info: unknown) => {
      const version = readVersion(info) ?? this.statusValue.availableVersion;
      this.setStatus({
        phase: 'downloaded',
        availableVersion: version,
        percent: 100,
        bytesPerSecond: null,
        checkedAt: this.now().toISOString(),
        message: version === null ? 'Update downloaded and ready to install.' : `Update ${version} is ready to install.`,
      });
      log.info('updater', 'update downloaded', { version });
    });

    this.updater.on('update-not-available', () => {
      this.setStatus({
        phase: 'up-to-date',
        availableVersion: null,
        percent: null,
        bytesPerSecond: null,
        checkedAt: this.now().toISOString(),
        message: 'TuneSmith is up to date.',
      });
      log.info('updater', 'no update available');
    });

    this.updater.on('update-cancelled', (info: unknown) => {
      const version = readVersion(info) ?? this.statusValue.availableVersion;
      this.setStatus({
        phase: 'available',
        availableVersion: version,
        percent: null,
        bytesPerSecond: null,
        message: 'Update download was cancelled.',
      });
      log.warn('updater', 'update download cancelled', { version });
    });

    this.updater.on('error', (error: unknown) => {
      this.handleError(error);
    });
  }

  private handleError(error: unknown): void {
    const detail = errorMessage(error);
    this.setStatus({
      phase: 'error',
      percent: null,
      bytesPerSecond: null,
      checkedAt: this.now().toISOString(),
      message: `Update check failed: ${publicErrorMessage(error)}`,
    });
    log.error('updater', 'update error', { error: detail });
  }

  private setStatus(patch: Partial<UpdaterStatus>): void {
    this.statusValue = { ...this.statusValue, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.status());
      } catch (error) {
        log.warn('updater', 'status listener failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
