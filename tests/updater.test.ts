import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { rm } from 'node:fs/promises';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: never[]) => void>();
  const fakeUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    fullChangelog: true,
    disableDifferentialDownload: false,
    logger: null as unknown,
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      handlers.set(event, listener);
      return fakeUpdater;
    }),
    checkForUpdates: vi.fn(async () => null),
    quitAndInstall: vi.fn(),
  };
  const fakeLog = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    transports: {
      file: {
        level: 'silly',
        maxSize: 0,
        fileName: '',
        resolvePathFn: (() => '') as () => string,
        sync: false,
      },
    },
  };
  return { handlers, fakeUpdater, fakeLog };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '1.0.0',
    getPath: () => os.tmpdir(),
  },
}));

vi.mock('electron-updater', () => ({ autoUpdater: mocks.fakeUpdater }));
vi.mock('electron-log/main', () => ({ default: mocks.fakeLog }));

import { UpdaterService, type UpdaterAdapter } from '../src/main/updater';

const LOG_DIR = path.join(os.tmpdir(), 'tunesmith-updater-test');

afterEach(async () => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  await rm(LOG_DIR, { recursive: true, force: true });
});

function createService(isPackaged = true, options: { initialDelayMs?: number; checkIntervalMs?: number } = {}): UpdaterService {
  return new UpdaterService({
    isPackaged,
    currentVersion: '1.0.0',
    logDirectory: LOG_DIR,
    updater: mocks.fakeUpdater as unknown as UpdaterAdapter,
    ...options,
  });
}

function emit(event: string, value: unknown): void {
  const handler = mocks.handlers.get(event);
  if (handler === undefined) throw new Error(`No updater handler for ${event}`);
  handler(value as never);
}

describe('UpdaterService', () => {
  it('configures electron-log rotation and enables downloads without auto-install', () => {
    const service = createService();
    expect(service.status().phase).toBe('idle');
    expect(mocks.fakeUpdater.autoDownload).toBe(true);
    expect(mocks.fakeUpdater.autoInstallOnAppQuit).toBe(false);
    expect(mocks.fakeUpdater.disableDifferentialDownload).toBe(true);
    expect(mocks.fakeLog.transports.file.maxSize).toBe(5 * 1024 * 1024);
    expect(mocks.fakeLog.transports.file.level).toBe('info');
    expect(mocks.fakeLog.transports.file.resolvePathFn()).toBe(path.join(LOG_DIR, 'updater.log'));
  });

  it('tracks checking, availability, download progress and completion', async () => {
    const service = createService();
    const phases: string[] = [];
    service.onStatus((status) => phases.push(status.phase));

    emit('checking-for-update', undefined);
    expect(service.status().phase).toBe('checking');

    emit('update-available', { version: '1.1.0' });
    expect(service.status()).toMatchObject({ phase: 'available', availableVersion: '1.1.0', percent: 0 });

    emit('download-progress', { percent: 42.55, bytesPerSecond: 2048.4 });
    expect(service.status()).toMatchObject({ phase: 'downloading', percent: 42.6, bytesPerSecond: 2048 });

    emit('update-downloaded', { version: '1.1.0' });
    expect(service.status()).toMatchObject({ phase: 'downloaded', percent: 100, availableVersion: '1.1.0' });
    expect(phases).toEqual(['checking', 'available', 'downloading', 'downloaded']);

    await service.check();
    expect(mocks.fakeUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(service.status().phase).toBe('downloaded');

    await service.install();
    expect(mocks.fakeUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('never checks or installs in a development build', async () => {
    const service = createService(false);
    expect(service.status().phase).toBe('disabled');

    await service.check();
    expect(mocks.fakeUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(service.status().phase).toBe('disabled');
    await expect(service.install()).rejects.toThrow(/development/i);
  });

  it('reports feed failures and refuses install before a download exists', async () => {
    mocks.fakeUpdater.checkForUpdates.mockRejectedValueOnce(new Error('release feed unavailable'));
    const service = createService();

    const status = await service.check();
    expect(status.phase).toBe('error');
    expect(status.message).toMatch(/release feed is unavailable/i);
    expect(status.message).not.toContain('C:\\');
    expect(service.status().checkedAt).not.toBeNull();

    // A path or URL in a transport error must stay in the updater log, not the DTO.
    mocks.fakeUpdater.checkForUpdates.mockRejectedValueOnce(
      new Error('cannot open C:\\Users\\olive\\AppData\\latest.yml from https://example.invalid/feed'),
    );
    const sanitized = await service.check();
    expect(sanitized.message).not.toMatch(/C:\\|https?:\/\//);

    await expect(service.install()).rejects.toThrow(/downloaded/i);
  });

  it('schedules automatic checks only after explicitly started', async () => {
    vi.useFakeTimers();
    try {
      const service = createService(true, { initialDelayMs: 25, checkIntervalMs: 100 });
      expect(mocks.fakeUpdater.checkForUpdates).not.toHaveBeenCalled();
      service.start();
      await vi.advanceTimersByTimeAsync(25);
      expect(mocks.fakeUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
      service.dispose();
      await vi.advanceTimersByTimeAsync(250);
      expect(mocks.fakeUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
