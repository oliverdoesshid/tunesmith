/**
 * Main-process entry point.
 *
 * Lifecycle: single instance -> harden the session -> create the window -> register IPC.
 * The engine is created before the window so a crashed session from a previous run is
 * visible to the UI as soon as it mounts.
 */
import path from 'node:path';
import { app, BrowserWindow, Menu } from 'electron';
import { createAppState } from './app-state';
import { registerIpcHandlers } from './ipc';
import { denyAllPermissions, hardenWindow, installContentSecurityPolicy } from './security/window-policy';
import { installArtworkProtocol, registerArtworkScheme } from './services/artwork-protocol';
import { GameOverlayController } from './overlay/controller';
import { readTelemetry } from './platform/game/telemetry';
import { initLogging, logger } from './logging';
import { UpdaterService } from './updater';
import { startCrashCollector } from './diagnostics/crash-collector';
import { DiagnosticsService } from './diagnostics/reports';
import { EVENT_CHANNELS } from '../shared/channels';

const devUrl = process.env.TS_DEV_SERVER_URL ?? null;

const logDirectory = initLogging({
  directory: path.join(app.getPath('userData'), 'logs'),
  meta: {
    appName: app.getName(),
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    execPath: process.execPath,
    cwd: process.cwd(),
    argv: process.argv,
    userData: app.getPath('userData'),
    devUrl,
  },
});
logger.info('app', 'boot', { logDirectory, devUrl });

// A privileged scheme must be declared before the app is ready. The handler itself is
// installed after `whenReady`, once the cache directory is known.
registerArtworkScheme();

let mainWindow: BrowserWindow | null = null;
let overlay: GameOverlayController | null = null;
let updater: UpdaterService | null = null;

logger.info('app', 'requesting single-instance lock');
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  logger.warn('app', 'single-instance lock not acquired; quitting duplicate instance');
  app.quit();
} else {
  logger.info('app', 'single-instance lock acquired');
  const crashDir = path.join(app.getPath('userData'), 'crashes');
  const crashCollector = startCrashCollector({
    crashDir,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
    log: (line) => logger.info('diagnostics', line),
  });
  const state = createAppState();
  const diagnostics = new DiagnosticsService({
    crashDir,
    logDir: path.join(app.getPath('userData'), 'logs'),
    getJournal: () => state.journal.summaries(),
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
  });
  logger.info('app', 'application state created');

  app.setAppUserModelId('dev.tunesmith.app');

  app.on('second-instance', (_event, commandLine, workingDirectory) => {
    logger.info('app', 'second instance attempted', {
      commandLine,
      workingDirectory,
      hasMainWindow: mainWindow !== null,
    });
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  // Capture both the app window and the separate OSD window, including renderer crashes
  // and console errors that never reach the main process's own console.
  app.on('web-contents-created', (_event, contents) => {
    const webContentsId = contents.id;
    logger.debug('webcontents', 'created', { webContentsId, type: contents.getType() });

    contents.on('console-message', (_event, level, message, line, sourceId) => {
      const details = { webContentsId, source: sourceId, line };
      if (level >= 3) logger.error('renderer', message, details);
      else if (level === 2) logger.warn('renderer', message, details);
      else if (level === 0) logger.debug('renderer', message, details);
      else logger.info('renderer', message, details);
    });

    contents.on('did-finish-load', () => {
      logger.info('renderer', 'did-finish-load', { webContentsId, url: contents.getURL() });
    });

    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (errorCode === -3) return; // user-initiated navigation/reload
      logger.error('renderer', 'did-fail-load', {
        webContentsId,
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      });
    });

    contents.on('preload-error', (_event, preloadPath, error) => {
      logger.error('renderer', 'preload error', {
        webContentsId,
        preloadPath,
        error: error.stack ?? error.message,
      });
    });

    contents.on('render-process-gone', (_event, details) => {
      logger.error('renderer', 'render process gone', { webContentsId, ...details });
    });

    contents.on('unresponsive', () => {
      logger.warn('renderer', 'unresponsive', { webContentsId });
    });

    contents.on('responsive', () => {
      logger.info('renderer', 'responsive', { webContentsId });
    });

    contents.on('destroyed', () => {
      logger.debug('webcontents', 'destroyed', { webContentsId });
    });
  });

  async function createWindow(): Promise<void> {
    logger.info('window', 'creating main window', { width: 1320, height: 900 });
    const win = new BrowserWindow({
      width: 1320,
      height: 900,
      minWidth: 1040,
      minHeight: 720,
      backgroundColor: '#070809',
      title: 'TuneSmith',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });

    mainWindow = win;
    logger.info('window', 'main window constructed', { browserWindowId: win.id });
    hardenWindow(win, devUrl);

    win.once('ready-to-show', () => {
      logger.info('window', 'ready-to-show', { browserWindowId: win.id });
      win.show();
    });
    win.on('close', () => {
      logger.info('window', 'close requested', { browserWindowId: win.id });
    });
    win.on('closed', () => {
      logger.info('window', 'closed', { browserWindowId: win.id });
      mainWindow = null;
      // The OSD is a second window; without this, closing TuneSmith would leave it
      // alive and prevent `window-all-closed` from firing.
      overlay?.dispose();
    });

    if (devUrl !== null) {
      logger.info('window', 'loading development URL', { devUrl });
      await win.loadURL(devUrl);
      logger.info('window', 'development URL load returned');
    } else {
      const rendererFile = path.join(__dirname, '../renderer/index.html');
      logger.info('window', 'loading renderer file', { rendererFile });
      await win.loadFile(rendererFile);
      logger.info('window', 'renderer file load returned');
    }
  }

  app
    .whenReady()
    .then(async () => {
      logger.info('app', 'Electron ready');
      Menu.setApplicationMenu(null);
      installContentSecurityPolicy(devUrl);
      denyAllPermissions();
      installArtworkProtocol(state.artworkCacheDir);

      logger.info('app', 'creating performance OSD controller');
      overlay = new GameOverlayController({
        devUrl,
        preloadPath: path.join(__dirname, '../preload/overlay.cjs'),
        rendererDir: path.join(__dirname, '../renderer'),
        readTelemetry,
        log: (line) => console.log(`[osd] ${line}`),
      });
      overlay.updateStatus(state.game.status());

      updater = new UpdaterService({
        logDirectory: path.join(app.getPath('userData'), 'logs'),
      });
      updater.onStatus((status) => {
        mainWindow?.webContents.send(EVENT_CHANNELS.updateStatus, status);
      });

      // Registered once, before any window exists: a second registration would throw.
      logger.info('app', 'registering IPC handlers');
      registerIpcHandlers(state, () => mainWindow, overlay, updater, diagnostics);
      void diagnostics
        .materializeReports()
        .then((count) => {
          if (count > 0) logger.info('diagnostics', 'correlated local crash reports', { count });
        })
        .catch((error: unknown) => {
          logger.warn('diagnostics', 'could not materialize crash reports', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      await createWindow();
      updater.start();

      // Surface a crashed session immediately rather than waiting for the user to
      // discover it in the Sessions list.
      const interrupted = await state.executor.interruptedSessions();
      if (interrupted.length > 0) {
        logger.warn('engine', 'interrupted sessions need attention', { count: interrupted.length });
      }
      logger.info('app', 'startup complete', { interruptedSessions: interrupted.length });
    })
    .catch((err) => {
      logger.error('app', 'startup failed', {
        error: err instanceof Error ? err.stack ?? err.message : String(err),
      });
      app.quit();
    });

  app.on('window-all-closed', () => {
    logger.info('app', 'window-all-closed; quitting');
    app.quit();
  });

  let quitting = false;

  // Quitting while a game session is active would leave suspended processes behind, so
  // the quit is deferred until the restore completes. `quitting` prevents the re-entrant
  // `app.quit()` below from deferring itself again.
  app.on('before-quit', (event) => {
    const activeGameSession = state.game.hasActiveSession();
    logger.info('app', 'before-quit', { activeGameSession, quitting });
    overlay?.dispose();
    updater?.dispose();
    state.health.stop();
    state.postApply.dispose();
    if (quitting) {
      logger.debug('app', 'before-quit re-entry; allowing quit');
      return;
    }
    if (!activeGameSession) {
      logger.info('app', 'no active game session; closing journals');
      void state.journal.closeAll();
      return;
    }

    logger.warn('app', 'deferring quit until game session restore completes');
    event.preventDefault();
    quitting = true;
    void state.game
      .shutdown()
      .catch((err: unknown) => {
        logger.error('game', 'shutdown restore failed', {
          error: err instanceof Error ? err.stack ?? err.message : String(err),
        });
      })
      .finally(() => {
        logger.info('app', 'game restore finished; quitting');
        void state.journal.closeAll();
        app.quit();
      });
  });

  app.on('will-quit', () => {
    crashCollector.markCleanExit();
    logger.info('app', 'will-quit');
  });

  app.on('child-process-gone', (_event, details) => {
    logger.error('app', 'child process gone', details);
  });
}
