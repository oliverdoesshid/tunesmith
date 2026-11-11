/**
 * Performance OSD window controller.
 *
 * The overlay is an independent, transparent BrowserWindow, not an injected overlay:
 *  - focusable: false and setIgnoreMouseEvents(true), so it cannot take input;
 *  - skipTaskbar and no frame, so it does not behave like another app;
 *  - always-on-top without ever calling into the game process;
 *  - shown only while the active session's game owns the foreground window, and
 *    positioned from the rectangle the watcher read with GetWindowRect.
 *
 * ETW frame timing is read by a child helper. If ETW cannot start, the window remains
 * useful: it still shows the active profile and hardware temperatures, and the FPS
 * fields explicitly say why they are empty.
 */
import path from 'node:path';
import { BrowserWindow, screen } from 'electron';
import { EVENT_CHANNELS } from '../../shared/channels';
import type { FrameSample, FrameSource, OsdState, OsdStatus } from '../../shared/game/osd';
import type { GameStatus, TelemetrySample } from '../../shared/game/types';
import type { GameSnapshot } from '../platform/game/watcher';
import { startFrameMonitor, type FrameMonitorHandle, type FrameMonitorStatus } from '../platform/game/frame-monitor';
import { OSD_HEIGHT, OSD_WIDTH, placeOverlay } from './geometry';
import { buildOsdState } from './state';

export interface OverlayController {
  status(): OsdStatus;
  setEnabled(enabled: boolean): OsdStatus;
  updateStatus(status: GameStatus): void;
  updateSnapshot(snapshot: GameSnapshot): void;
  dispose(): void;
}

export interface GameOverlayControllerDeps {
  preloadPath: string;
  rendererDir: string;
  devUrl: string | null;
  readTelemetry?: () => Promise<TelemetrySample>;
  createFrameMonitor?: typeof startFrameMonitor;
  now?: () => number;
  log?: (line: string) => void;
}

const TELEMETRY_TTL_MS = 5_000;

export class GameOverlayController implements OverlayController {
  private readonly deps: GameOverlayControllerDeps;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  private win: BrowserWindow | null = null;
  private creating: Promise<BrowserWindow> | null = null;
  private disposed = false;

  private enabled = true;
  private statusValue: GameStatus | null = null;
  private snapshot: GameSnapshot | null = null;
  private sessionId: string | null = null;

  private frame: FrameSample | null = null;
  private frameStatus: FrameMonitorStatus = { state: 'starting', message: null };
  private monitor: FrameMonitorHandle | null = null;

  private telemetry: TelemetrySample | null = null;
  private telemetryAt = 0;
  private telemetryInFlight = false;

  constructor(deps: GameOverlayControllerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? (() => {});
  }

  status(): OsdStatus {
    const active = this.activeSession();
    const foreground = active !== null && this.snapshot?.foreground?.pid === active.pid;
    let message: string | null = null;

    if (!this.enabled) message = 'The performance OSD is off.';
    else if (active === null) message = 'The OSD appears when a game profile is active.';
    else if (!foreground || this.snapshot?.window == null) message = 'The OSD appears when the game is in the foreground.';

    return {
      enabled: this.enabled,
      visible: this.win !== null && !this.win.isDestroyed() && this.win.isVisible(),
      message,
    };
  }

  setEnabled(enabled: boolean): OsdStatus {
    this.enabled = enabled;
    if (!enabled) {
      this.hide();
      this.stopFrameMonitor();
    } else {
      this.evaluate();
    }
    return this.status();
  }

  updateStatus(status: GameStatus): void {
    const nextSession = status.phase === 'active' ? (status.active?.id ?? null) : null;
    if (nextSession !== this.sessionId) {
      this.sessionId = nextSession;
      this.telemetry = null;
      this.telemetryAt = 0;
      this.frame = null;
      this.frameStatus = { state: 'starting', message: null };
      this.stopFrameMonitor();
    }

    this.statusValue = status;
    if (status.telemetry !== null) {
      const at = Date.parse(status.telemetry.at);
      const sessionStart = status.active === null ? Number.NaN : Date.parse(status.active.startedAt);
      // A guard sample from the previous game must not appear as the new game's
      // temperature. The external sampler will fill this shortly after activation.
      if (
        Number.isFinite(at) &&
        Number.isFinite(sessionStart) &&
        at >= sessionStart &&
        at >= this.telemetryAt &&
        this.now() - at < 30_000
      ) {
        this.telemetry = status.telemetry;
        this.telemetryAt = at;
      }
    }
    this.evaluate();
  }

  updateSnapshot(snapshot: GameSnapshot): void {
    this.snapshot = snapshot;
    this.evaluate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopFrameMonitor();
    if (this.win !== null && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  private activeSession(): GameStatus['active'] {
    const status = this.statusValue;
    return status !== null && status.phase === 'active' ? status.active : null;
  }

  private evaluate(): void {
    if (this.disposed) return;
    const active = this.activeSession();
    if (!this.enabled || active === null || active.pid === null) {
      this.hide();
      if (!this.enabled || active === null) this.stopFrameMonitor();
      return;
    }

    // Start ETW as soon as the profile is active, even if the user alt-tabs briefly.
    this.ensureFrameMonitor(active.pid);

    if (this.snapshot?.foreground?.pid !== active.pid || this.snapshot.window == null) {
      this.hide();
      return;
    }

    void this.showFor(active.pid, this.snapshot.window);
  }

  private async showFor(
    pid: number,
    window: NonNullable<GameSnapshot['window']>,
  ): Promise<void> {
    let win: BrowserWindow;
    try {
      win = await this.ensureWindow();
    } catch (error) {
      this.log(`[osd] window creation failed: ${String(error)}`);
      return;
    }
    if (this.disposed) return;

    const active = this.activeSession();
    if (!this.enabled || active === null || active.pid !== pid) return;
    if (this.snapshot?.foreground?.pid !== pid || this.snapshot.window == null) return;

    try {
      // Win32 reports physical pixels after the watcher opts into per-monitor DPI
      // awareness; BrowserWindow bounds are DIPs. Passing null makes Electron scale
      // relative to the display nearest the game rect, which matters when the game is on
      // a monitor with a different scale factor than the monitor the OSD last used.
      const physical = { x: window.left, y: window.top, width: window.width, height: window.height };
      const dip = screen.screenToDipRect(null, physical);
      const display = screen.getDisplayMatching(dip);
      const target = placeOverlay(
        { left: dip.x, top: dip.y, width: dip.width, height: dip.height },
        display.bounds,
        OSD_WIDTH,
        OSD_HEIGHT,
      );

      win.setBounds(target, false);
      if (!win.isVisible()) win.showInactive();
      win.moveTop();
      this.pushState();
      void this.refreshTelemetry();
    } catch (error) {
      this.log(`[osd] positioning failed: ${String(error)}`);
    }
  }

  private hide(): void {
    if (this.win !== null && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
  }

  private async ensureWindow(): Promise<BrowserWindow> {
    if (this.win !== null && !this.win.isDestroyed()) return this.win;
    if (this.creating !== null) return this.creating;

    this.creating = this.createWindow();
    try {
      return await this.creating;
    } finally {
      this.creating = null;
    }
  }

  private async createWindow(): Promise<BrowserWindow> {
    const win = new BrowserWindow({
      width: OSD_WIDTH,
      height: OSD_HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      closable: false,
      focusable: false,
      // Keep Windows from adding a resize frame around the click-through window;
      // otherwise setBounds() reports a few pixels of invisible border and anchoring drifts.
      thickFrame: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      title: 'TuneSmith Performance OSD',
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        devTools: false,
      },
    });

    this.win = win;
    win.setMenuBarVisibility(false);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setFocusable(false);
    win.setIgnoreMouseEvents(true, { forward: false });
    win.webContents.setBackgroundThrottling(false);

    // The overlay has no links, forms, webviews or navigation targets. Deny all of it
    // rather than reusing the main window's file://-friendly navigation policy.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('will-redirect', (event) => event.preventDefault());
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());
    win.webContents.on('did-finish-load', () => this.pushState());

    win.on('closed', () => {
      if (this.win === win) this.win = null;
    });

    try {
      if (this.deps.devUrl !== null) {
        await win.loadURL(new URL('/overlay.html', this.deps.devUrl).toString());
      } else {
        await win.loadFile(path.join(this.deps.rendererDir, 'overlay.html'));
      }
    } catch (error) {
      if (!win.isDestroyed()) win.destroy();
      if (this.win === win) this.win = null;
      throw error;
    }

    return win;
  }

  private pushState(): void {
    const win = this.win;
    if (win === null || win.isDestroyed()) return;
    const state = this.state();
    if (state === null) return;
    win.webContents.send(EVENT_CHANNELS.osdState, state);
  }

  private state(): OsdState | null {
    if (this.statusValue === null) return null;
    const frameSource: FrameSource = this.frameStatus.state === 'unavailable' ? 'unavailable' : 'etw';
    const message =
      this.frameStatus.state === 'unavailable'
        ? (this.frameStatus.message ?? 'Frame telemetry is unavailable.')
        : this.frameStatus.state === 'starting'
          ? 'Starting frame telemetry…'
          : null;

    return buildOsdState({
      status: this.statusValue,
      frame: this.frame,
      frameSource,
      frameMessage: message,
      telemetry: this.telemetry,
      nowMs: this.now(),
    });
  }

  private ensureFrameMonitor(pid: number): void {
    if (this.monitor?.pid === pid) return;
    this.stopFrameMonitor();

    if (this.deps.createFrameMonitor === undefined) {
      this.frameStatus = { state: 'unavailable', message: 'Frame telemetry is unavailable in this build.' };
      return;
    }

    this.frameStatus = { state: 'starting', message: null };
    this.monitor = this.deps.createFrameMonitor({
      pid,
      intervalMs: 1_000,
      onSample: (sample) => {
        this.frame = sample;
        this.pushState();
      },
      onStatus: (status) => {
        this.frameStatus = status;
        if (status.state !== 'running') this.frame = null;
        this.pushState();
      },
      log: this.log,
    });
    this.pushState();
  }

  private stopFrameMonitor(): void {
    this.monitor?.stop();
    this.monitor = null;
    this.frame = null;
    this.frameStatus = { state: 'starting', message: null };
  }

  private async refreshTelemetry(): Promise<void> {
    if (this.deps.readTelemetry === undefined || this.telemetryInFlight) return;
    if (this.telemetry !== null && this.now() - this.telemetryAt < TELEMETRY_TTL_MS) return;

    this.telemetryInFlight = true;
    try {
      const sample = await this.deps.readTelemetry();
      if (this.disposed) return;
      this.telemetry = sample;
      const at = Date.parse(sample.at);
      this.telemetryAt = Number.isFinite(at) ? at : this.now();
      this.pushState();
    } catch (error) {
      // Back off after a failed PowerShell/WMI read so an unavailable sensor does not
      // spawn a new probe on every watcher tick.
      this.telemetryAt = this.now();
      this.log(`[osd] telemetry unavailable: ${String(error)}`);
    } finally {
      this.telemetryInFlight = false;
    }
  }
}
