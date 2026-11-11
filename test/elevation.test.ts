/**
 * Elevation handoff verification.
 *
 * A relaunched process must acquire the single-instance lock before the old process
 * quits. These tests pin the order that prevents the elevated instance from seeing the
 * old lock and exiting immediately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/main/app-state-types';
import type { ElevationResult, IpcEnvelope } from '../src/shared/ipc';
import { IPC_CHANNELS } from '../src/shared/channels';
import { TuneSmithError } from '../src/shared/errors';

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  app: {
    isPackaged: true,
    hasSingleInstanceLock: vi.fn(() => true),
    releaseSingleInstanceLock: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
  },
}));

const runtimeMock = vi.hoisted(() => ({
  isElevated: vi.fn(async () => false),
  relaunchElevated: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({
  app: electronMock.app,
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => Promise<unknown>,
    ): void => {
      electronMock.handlers.set(channel, handler);
    },
  },
  shell: { openPath: vi.fn() },
}));

vi.mock('../src/main/runtime', () => runtimeMock);

import { registerIpcHandlers } from '../src/main/ipc';

const TRUSTED_EVENT = { senderFrame: { url: 'file:///C:/Program%20Files/TuneSmith/index.html' } };

function makeState(activeSession = false): AppState {
  return {
    game: {
      setOnChange: vi.fn(),
      setOnSnapshot: vi.fn(),
      hasActiveSession: vi.fn(() => activeSession),
    },
    health: { onStatus: vi.fn() },
    postApply: { setOnStatus: vi.fn() },
  } as unknown as AppState;
}

async function callElevation(): Promise<IpcEnvelope<ElevationResult>> {
  const handler = electronMock.handlers.get(IPC_CHANNELS.appElevation);
  if (handler === undefined) throw new Error('Elevation handler was not registered');
  return (await handler(TRUSTED_EVENT)) as IpcEnvelope<ElevationResult>;
}

beforeEach(() => {
  vi.resetAllMocks();
  electronMock.handlers.clear();
  electronMock.app.hasSingleInstanceLock.mockReturnValue(true);
  electronMock.app.requestSingleInstanceLock.mockReturnValue(true);
  runtimeMock.relaunchElevated.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('administrator relaunch', () => {
  it('releases the single-instance lock before starting the elevated process', async () => {
    vi.useFakeTimers();
    registerIpcHandlers(makeState(), () => null);

    const response = await callElevation();

    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('elevation request failed');
    expect(response.value.relaunching).toBe(true);
    expect(electronMock.app.releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(runtimeMock.relaunchElevated).toHaveBeenCalledWith(process.execPath, []);
    expect(electronMock.app.releaseSingleInstanceLock.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeMock.relaunchElevated.mock.invocationCallOrder[0] ?? 0,
    );
    expect(electronMock.app.quit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);
    expect(electronMock.app.quit).toHaveBeenCalledTimes(1);
  });

  it('reacquires the lock when UAC is declined or the launch fails', async () => {
    electronMock.app.hasSingleInstanceLock
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    runtimeMock.relaunchElevated.mockRejectedValueOnce(
      new TuneSmithError('not-elevated', 'Elevation was declined.', 'canceled'),
    );
    registerIpcHandlers(makeState(), () => null);

    const response = await callElevation();

    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('elevation unexpectedly succeeded');
    expect(response.error.code).toBe('not-elevated');
    expect(electronMock.app.releaseSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(electronMock.app.requestSingleInstanceLock).toHaveBeenCalledTimes(1);
    expect(electronMock.app.quit).not.toHaveBeenCalled();
  });

  it('refuses to restart while a game session owns reversible changes', async () => {
    registerIpcHandlers(makeState(true), () => null);

    const response = await callElevation();

    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('elevation unexpectedly succeeded');
    expect(response.error.code).toBe('invalid-request');
    expect(response.error.message).toMatch(/active game session/i);
    expect(electronMock.app.releaseSingleInstanceLock).not.toHaveBeenCalled();
    expect(runtimeMock.relaunchElevated).not.toHaveBeenCalled();
  });
});
