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

const devUrl = process.env.TS_DEV_SERVER_URL ?? null;

let mainWindow: BrowserWindow | null = null;

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  const state = createAppState();

  app.setAppUserModelId('dev.tunesmith.app');

  app.on('second-instance', () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  async function createWindow(): Promise<void> {
    const win = new BrowserWindow({
      width: 1320,
      height: 900,
      minWidth: 1040,
      minHeight: 720,
      backgroundColor: '#0b1015',
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
    hardenWindow(win, devUrl);

    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      mainWindow = null;
    });

    if (devUrl !== null) {
      await win.loadURL(devUrl);
    } else {
      await win.loadFile(path.join(__dirname, '../renderer/index.html'));
    }
  }

  app
    .whenReady()
    .then(async () => {
      Menu.setApplicationMenu(null);
      installContentSecurityPolicy(devUrl);
      denyAllPermissions();
      // Registered once, before any window exists: a second registration would throw.
      registerIpcHandlers(state, () => mainWindow);
      await createWindow();

      // Surface a crashed session immediately rather than waiting for the user to
      // discover it in the Sessions list.
      const interrupted = await state.executor.interruptedSessions();
      if (interrupted.length > 0) {
        console.warn(`[engine] ${interrupted.length} interrupted session(s) need attention`);
      }
    })
    .catch((err) => {
      console.error('[main] startup failed', err);
      app.quit();
    });

  app.on('window-all-closed', () => {
    app.quit();
  });

  let quitting = false;

  // Quitting while a game session is active would leave suspended processes behind, so
  // the quit is deferred until the restore completes. `quitting` prevents the re-entrant
  // `app.quit()` below from deferring itself again.
  app.on('before-quit', (event) => {
    if (quitting) return;
    if (!state.game.hasActiveSession()) {
      void state.journal.closeAll();
      return;
    }

    event.preventDefault();
    quitting = true;
    void state.game
      .shutdown()
      .catch((err: unknown) => console.error('[game] shutdown restore failed', err))
      .finally(() => {
        void state.journal.closeAll();
        app.quit();
      });
  });
}
