/**
 * Process-wide singletons, created once at startup.
 *
 * Composition happens here so that every other module stays testable: nothing in
 * `engine/` or `platform/` reads `app.getPath()` or imports Electron.
 */
import path from 'node:path';
import { app } from 'electron';
import type { AppState as AppStateShape } from './app-state-types';
import { SystemAdapter } from './engine/adapter';
import { GameController } from './engine/game/controller';
import { GameProfileRepository, GameSessionStore } from './engine/game/store';
import { createSystemGameAdapter } from './platform/game/adapter';
import { Executor } from './engine/executor';
import { JournalStore } from './engine/journal';
import { SessionLock } from './engine/lock';
import { PresetRepository } from './engine/preset-repository';
import { detectHardware } from './platform/hardware';
import { createRestorePoint } from './platform/restore-point';
import type { HardwareSpec } from '../shared/types';

const SPEC_TTL_MS = 5 * 60 * 1000;

export function createAppState(): AppStateShape {
  const appPath = app.getAppPath();
  const presetsDir = path.join(appPath, 'presets', 'community');
  const gameProfilesDir = path.join(appPath, 'presets', 'games');
  const userData = app.getPath('userData');
  const sessionsDir = path.join(userData, 'sessions');
  const gameSessionsDir = path.join(userData, 'game-sessions');

  const journal = new JournalStore(sessionsDir);
  const lock = new SessionLock(userData);
  const repo = new PresetRepository(presetsDir);

  const executor = new Executor({
    adapter: new SystemAdapter(),
    journal,
    lock,
    appVersion: app.getVersion(),
    log: (line) => console.log(`[engine] ${line}`),
    createRestorePoint,
  });

  const game = new GameController({
    adapter: createSystemGameAdapter(),
    profiles: new GameProfileRepository(gameProfilesDir),
    sessions: new GameSessionStore(gameSessionsDir),
    pollMs: 2_000,
    log: (line) => console.log(`[game] ${line}`),
  });

  // Recover sessions a crash left behind before any window can ask for status.
  void game.start().catch((error: unknown) => console.error('[game] recovery failed', error));

  let specCache: { value: HardwareSpec; at: number } | null = null;

  const getSpec = async (force = false): Promise<HardwareSpec> => {
    const now = Date.now();
    if (!force && specCache !== null && now - specCache.at < SPEC_TTL_MS) return specCache.value;
    const value = await detectHardware();
    specCache = { value, at: now };
    console.log(`[hardware] ${value.signature}`);
    return value;
  };

  return {
    repo,
    journal,
    lock,
    executor,
    game,
    presetsDir,
    gameProfilesDir,
    sessionsDir,
    getSpec,
    invalidateSpec: () => {
      specCache = null;
    },
  };
}
