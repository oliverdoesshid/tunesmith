/**
 * Process-wide singletons, created once at startup.
 *
 * Composition happens here so that every other module stays testable: nothing in
 * `engine/` or `platform/` reads `app.getPath()` or imports Electron.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AppState as AppStateShape } from './app-state-types';
import { SystemAdapter } from './engine/adapter';
import { GameController } from './engine/game/controller';
import { GameProfileRepository, GameSessionStore } from './engine/game/store';
import { createSystemGameAdapter } from './platform/game/adapter';
import { GameLibraryService } from './platform/game/libraries';
import { Executor } from './engine/executor';
import { PostApplyWatchdog } from './engine/post-apply';
import { probePostApplyStability } from './platform/stability';
import { JournalStore } from './engine/journal';
import { SessionLock } from './engine/lock';
import { PresetRepository } from './engine/preset-repository';
import { loadMarketplaceSettings } from './market/config';
import { MarketplaceService } from './market/service';
import { detectHardware } from './platform/hardware';
import { createRestorePoint } from './platform/restore-point';
import { HealthStore } from './health/store';
import { HealthWatchdog } from './health/watchdog';
import { loadSteamGridDbApiKey, SteamGridDbService } from './services/steamgriddb';
import { probeHealthSnapshot } from './health/probes';
import type { HardwareSpec } from '../shared/types';

const SPEC_TTL_MS = 5 * 60 * 1000;

export function createAppState(): AppStateShape {
  const appPath = app.getAppPath();
  const presetsDir = path.join(appPath, 'presets', 'community');
  const gameProfilesDir = path.join(appPath, 'presets', 'games');
  const userData = app.getPath('userData');
  const sessionsDir = path.join(userData, 'sessions');
  const gameSessionsDir = path.join(userData, 'game-sessions');
  const artworkCacheDir = path.join(userData, 'artwork-cache');

  const marketSettings = loadMarketplaceSettings(app.getVersion(), userData, appPath);
  // The loader treats a missing directory as a failure; create it before the first read.
  mkdirSync(marketSettings.installDir, { recursive: true });
  const journal = new JournalStore(sessionsDir);
  const lock = new SessionLock(userData);

  let specCache: { value: HardwareSpec; at: number } | null = null;

  const getSpec = async (force = false): Promise<HardwareSpec> => {
    const now = Date.now();
    if (!force && specCache !== null && now - specCache.at < SPEC_TTL_MS) return specCache.value;
    const value = await detectHardware();
    specCache = { value, at: now };
    console.log(`[hardware] ${value.signature}`);
    return value;
  };

  const repo = new PresetRepository([
    { dir: presetsDir, requireSignatures: true },
    // Marketplace installs were Ed25519-verified against the signed catalog at install
    // time; re-checking them would require the curator's private key here.
    { dir: marketSettings.installDir },
  ]);

  const market = new MarketplaceService({
    ...marketSettings,
    listInstalled: async () => {
      const { presets } = await repo.load();
      return new Map(presets.map((loaded) => [loaded.preset.id, loaded.preset.version]));
    },
    // Invalidate and immediately rebuild the in-memory library so a freshly installed
    // preset is available to the next `presets:list` without a restart.
    onInstalled: async () => {
      repo.invalidate();
      try {
        await repo.load(true);
      } catch (error) {
        console.error('[market] immediate re-index failed', error);
      }
    },
    getSpec,
  });

  const health = new HealthWatchdog({
    store: new HealthStore(userData),
    probe: () => probeHealthSnapshot(),
    journal,
    resolvePreset: async (presetId) => {
      const loaded = await repo.get(presetId);
      return loaded === null
        ? null
        : { id: loaded.preset.id, name: loaded.preset.name, version: loaded.preset.version };
    },
    log: (line) => console.log(`[health] ${line}`),
  });

  const executor = new Executor({
    adapter: new SystemAdapter(),
    journal,
    lock,
    appVersion: app.getVersion(),
    log: (line) => console.log(`[engine] ${line}`),
    createRestorePoint,
  });

  const postApply = new PostApplyWatchdog({
    rollback: (sessionId) => executor.rollback(sessionId),
    probe: probePostApplyStability,
    log: (line) => console.log(`[stability] ${line}`),
  });

  const libraries = new GameLibraryService();

  const artwork = new SteamGridDbService({
    cacheDir: artworkCacheDir,
    apiKey: loadSteamGridDbApiKey(userData),
    log: (line) => console.log(`[artwork] ${line}`),
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

  // The watchdog is read-only and best-effort. It captures a baseline on first launch and
  // publishes drift through its status event; a probe failure never blocks startup.
  void health.start().catch((error: unknown) => console.error('[health] watchdog failed', error));

  // Warm the read-only library scan while the window loads, so the first profile render can
  // show detected titles without waiting for PowerShell. Failures are source-local and
  // surface in the UI rather than blocking startup.
  void libraries.scan().catch((error: unknown) => console.error('[game] library scan failed', error));

  // Feed the crash-rate statistics from the preset journal: an `applying` manifest left
  // behind at startup is exactly the crash the recovery handler exists for.
  void (async () => {
    try {
      const summaries = await journal.summaries();
      const interrupted = summaries.filter((summary) => summary.interrupted);
      if (interrupted.length > 0) {
        await market.recordInterrupted(
          interrupted.map((summary) => ({ presetId: summary.presetId, presetVersion: summary.presetVersion })),
        );
      }
    } catch (error) {
      console.error('[market] crash telemetry failed', error);
    }
  })();

  // Give game profiles the detected machine once it is known; until then the controller
  // falls back to topology-only facts, which still adapt on small CPUs.
  void getSpec()
    .then((spec) => game.setHardware(spec))
    .catch((error: unknown) => console.error('[game] hardware profile unavailable', error));

  return {
    repo,
    journal,
    lock,
    executor,
    postApply,
    game,
    libraries,
    artwork,
    artworkCacheDir,
    health,
    market,
    presetsDir,
    gameProfilesDir,
    sessionsDir,
    getSpec,
    invalidateSpec: () => {
      specCache = null;
    },
  };
}
