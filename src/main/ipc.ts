/**
 * Privileged IPC surface.
 *
 * Every handler:
 *   - rejects messages that did not come from our own renderer
 *   - re-validates its payload with the shared zod schema (never trusts the renderer)
 *   - converts exceptions into `{ ok: false, error }` so a stack trace never crosses
 *     the bridge
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import {
  app,
  dialog,
  ipcMain,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from 'electron';
import { describeError, isTuneSmithError, TuneSmithError } from '../shared/errors';
import {
  applyRequestSchema,
  artworkRequestSchema,
  artworkResolveRequest,
  EVENT_CHANNELS,
  gameCryoFreezeRequest,
  gameFolderRequest,
  gameInterruptAffinityRequest,
  gameIdRequest,
  gameLaunchRequest,
  gameLibraryScanRequest,
  gamePathPickRequest,
  gameWatchingRequest,
  manualGameAddRequest,
  healthPinRequest,
  IPC_CHANNELS,
  marketInstallRequest,
  marketOpenPublishLinkRequest,
  marketPublishRequest,
  marketStatusRequest,
  diagnosticsExportRequestSchema,
  osdToggleRequest,
  presetIdRequest,
  sessionIdRequest,
  shaderCachePruneRequest,
  shaderCacheScanRequest,
  telemetryConsentRequest,
  type ElevationResult,
  type IpcEnvelope,
  type PresetSummary,
} from '../shared/ipc';
import type { InstallResult, MarketStatus } from '../shared/market/types';
import type { PublishCandidate, PublishConfig, PublishResult } from '../shared/market/publish';
import type { HealthFlushResult, HealthStatus } from '../shared/health/types';
import type { ShaderCachePruneResult, ShaderCacheStatus } from '../shared/shader-cache';
import { describeActions } from '../shared/game/describe';
import type {
  ArtworkRequestItem,
  GameArtworkBatch,
  ResolvedGameArtwork,
} from '../shared/game/artwork';
import type { OsdStatus } from '../shared/game/osd';
import type {
  DiscoveredGame,
  GameLaunchResult,
  GameLibraryScanResult,
  GamePathPickKind,
  GameProfileSummary,
  GameStatus,
  ManualGameAddRequest,
  PickedGamePath,
} from '../shared/game/types';
import { attachProfileMatches, installedProfilePaths } from '../shared/game/library';
import { compilePlan } from '../shared/preset/compiler';
import { buildServiceDependencyGraph, type ServiceDependencyAction, type ServiceDependencyGraph } from '../shared/service-graph';
import type { AppInfo, MemorySnapshot } from '../shared/session';
import type { PostApplyStatus } from '../shared/post-apply';
import { initialUpdaterStatus, type UpdaterStatus } from '../shared/updater';
import type {
  DiagnosticsExportRequest,
  DiagnosticsExportResult,
  DiagnosticsStatus,
} from '../shared/diagnostics/types';
import type { AppState } from './app-state-types';
import type { UpdaterService } from './updater';
import { diagnosticBundleName, type DiagnosticsService } from './diagnostics/reports';
import { runPreflight } from './engine/preflight';
import { probeSystemRestore } from './platform/restore-point';
import { readServiceRegistry } from './platform/service-registry';
import { isElevated, relaunchElevated } from './runtime';
import { findGameById, resolveGameFolder, resolveLaunchExecutable } from './services/game-files';
import type { OverlayController } from './overlay/controller';
import { logger } from './logging';

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  if (url.startsWith('file://')) return true;
  const devUrl = process.env.TS_DEV_SERVER_URL;
  return devUrl !== undefined && devUrl.length > 0 && url.startsWith(devUrl);
}

function parsePayload<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new TuneSmithError('invalid-request', 'Invalid request payload.');
  return parsed.data as T;
}

const OSD_UNAVAILABLE: OsdStatus = {
  enabled: false,
  visible: false,
  message: 'Performance OSD is unavailable in this build.',
};

/** A single read-only physical-memory sample. Node reports bytes for both values. */
function readMemorySnapshot(): MemorySnapshot {
  const totalBytes = totalmem();
  const availableBytes = freemem();
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const usedPercent = totalBytes > 0 ? Math.round(Math.min(100, (usedBytes / totalBytes) * 100) * 10) / 10 : 0;
  return {
    totalBytes,
    availableBytes,
    usedBytes,
    usedPercent,
    pressure: usedPercent >= 88 ? 'critical' : usedPercent >= 75 ? 'elevated' : 'optimal',
    sampledAt: new Date().toISOString(),
  };
}

export function registerIpcHandlers(
  state: AppState,
  getWindow: () => BrowserWindow | null,
  overlay?: OverlayController,
  updater?: UpdaterService,
  diagnostics?: DiagnosticsService,
): void {
  // Push game mode transitions to the window as they happen. The overlay is a second
  // listener here rather than owning a competing `setOnChange` registration.
  state.game.setOnChange((status: GameStatus) => {
    getWindow()?.webContents.send(EVENT_CHANNELS.gameStatus, status);
    overlay?.updateStatus(status);
  });
  state.game.setOnSnapshot?.((snapshot) => overlay?.updateSnapshot(snapshot));

  // Health checks are passive and can finish at any time; push the result so an open
  // window updates without polling.
  state.health.onStatus((status: HealthStatus) => {
    getWindow()?.webContents.send(EVENT_CHANNELS.healthStatus, status);
  });

  state.postApply.setOnStatus((status: PostApplyStatus) => {
    getWindow()?.webContents.send(EVENT_CHANNELS.postApplyStatus, status);
  });

  const refreshHealth = (): void => {
    void state.health.check().catch((error: unknown) => {
      console.error('[health] refresh after engine action failed', error);
    });
  };


  const handle = <T>(channel: string, fn: (...args: unknown[]) => Promise<T>): void => {
    ipcMain.handle(channel, async (event, ...args): Promise<IpcEnvelope<T>> => {
      const startedAt = Date.now();
      const sender = event.senderFrame?.url ?? 'unknown';
      logger.debug('ipc', 'request', { channel, sender });

      if (!isTrustedSender(event)) {
        logger.warn('ipc', 'blocked untrusted sender', { channel, sender });
        return { ok: false, error: { code: 'invalid-request', message: 'Untrusted IPC sender.' } };
      }

      try {
        const value = await fn(...args);
        logger.debug('ipc', 'response', { channel, ok: true, durationMs: Date.now() - startedAt });
        return { ok: true, value };
      } catch (err) {
        const code = isTuneSmithError(err) ? err.code : 'unexpected-exit';
        const message = describeError(err);
        logger.error('ipc', 'handler failed', {
          channel,
          code,
          message,
          durationMs: Date.now() - startedAt,
        });
        return { ok: false, error: { code, message } };
      }
    });
  };

  handle<AppInfo>(IPC_CHANNELS.appInfo, async () => {
    const loaded = await state.repo.load();
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      platform: process.platform,
      isElevated: await isElevated(),
      devMode: !app.isPackaged,
      sessionsDir: state.sessionsDir,
      presetCount: loaded.presets.length,
    };
  });

  handle<MemorySnapshot>(IPC_CHANNELS.appMemory, async () => readMemorySnapshot());

  const unavailableUpdaterStatus = (): UpdaterStatus => ({
    ...initialUpdaterStatus(app.isPackaged, app.getVersion()),
    phase: 'disabled',
    message: 'The updater is unavailable in this build.',
  });

  handle<UpdaterStatus>(IPC_CHANNELS.updateStatus, async () =>
    updater?.status() ?? unavailableUpdaterStatus(),
  );

  const unavailableDiagnostics = (): DiagnosticsStatus => ({
    crashDir: '',
    reportCount: 0,
    dumpCount: 0,
    totalDumpBytes: 0,
    reports: [],
    message: 'Local crash diagnostics are unavailable in this build.',
  });

  handle<DiagnosticsStatus>(IPC_CHANNELS.diagnosticsStatus, async () =>
    diagnostics?.status() ?? unavailableDiagnostics(),
  );

  handle<DiagnosticsExportResult>(IPC_CHANNELS.diagnosticsExport, async (raw) => {
    if (diagnostics === undefined) {
      throw new TuneSmithError('unavailable', 'Local crash diagnostics are unavailable in this build.');
    }
    const request = parsePayload<DiagnosticsExportRequest>(diagnosticsExportRequestSchema, raw);
    const parent = getWindow();
    const options: SaveDialogOptions = {
      title: 'Export TuneSmith diagnostics',
      defaultPath: path.join(app.getPath('downloads'), diagnosticBundleName()),
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    };
    const picked =
      parent === null || parent.isDestroyed()
        ? await dialog.showSaveDialog(options)
        : await dialog.showSaveDialog(parent, options);
    if (picked.canceled || picked.filePath === undefined) {
      return { saved: false, path: null, fileCount: 0, bytes: 0, message: 'Export cancelled.' };
    }
    return diagnostics.exportBundle(request, picked.filePath);
  });

  handle<void>(IPC_CHANNELS.diagnosticsOpenFolder, async () => {
    if (diagnostics === undefined) {
      throw new TuneSmithError('unavailable', 'Local crash diagnostics are unavailable in this build.');
    }
    const error = await shell.openPath(diagnostics.crashDir);
    if (error.length > 0) throw new TuneSmithError('unavailable', `Could not open the crash folder: ${error}`);
  });

  handle<UpdaterStatus>(IPC_CHANNELS.updateCheck, async () => {
    if (updater === undefined) return unavailableUpdaterStatus();
    return updater.check();
  });

  handle<void>(IPC_CHANNELS.installUpdate, async () => {
    if (updater === undefined) {
      throw new TuneSmithError('unavailable', 'The updater is unavailable in this build.');
    }
    if (state.game.hasActiveSession()) {
      throw new TuneSmithError(
        'invalid-request',
        'Restore the active game session before installing an update.',
      );
    }
    await updater.install();
  });

  handle<ElevationResult>(IPC_CHANNELS.appElevation, async () => {
    const activeGameSession = state.game.hasActiveSession();
    const hasSingleInstanceLock = app.hasSingleInstanceLock();
    const args = app.isPackaged ? [] : process.argv.slice(1);
    logger.info('elevation', 'request received', {
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      args,
      hasSingleInstanceLock,
      activeGameSession,
    });

    if (activeGameSession) {
      logger.warn('elevation', 'refused while a game session is active');
      throw new TuneSmithError('invalid-request', 'Restore the active game session before restarting as administrator.');
    }

    // The relaunched process must be able to acquire the single-instance lock. Holding it
    // until app.quit() causes the new elevated instance to see the old process, fire
    // second-instance, and exit immediately. Release it before ShellExecute runs, then
    // reacquire it if UAC is declined or the launch fails.
    if (!hasSingleInstanceLock) {
      logger.error('elevation', 'single-instance lock is not held');
      throw new TuneSmithError('not-elevated', 'The single-instance lock is not held by this process.');
    }
    app.releaseSingleInstanceLock();
    logger.info('elevation', 'single-instance lock released for handoff');

    try {
      const pid = await relaunchElevated(process.execPath, args);
      logger.info('elevation', 'elevated instance handed off', { pid });
    } catch (err) {
      const lockReacquired = app.hasSingleInstanceLock() || app.requestSingleInstanceLock();
      logger.error('elevation', 'handoff failed; original instance retained', {
        error: describeError(err),
        lockReacquired,
      });
      throw err;
    }

    setTimeout(() => {
      logger.info('elevation', 'quitting original instance');
      app.quit();
    }, 400);
    return { relaunching: true, detail: 'The elevated instance is starting…' };
  });

  handle(IPC_CHANNELS.hardwareGet, async (force) => state.getSpec(force === true));

  handle<PresetSummary[]>(IPC_CHANNELS.presetsList, async () => {
    const [{ presets }, spec] = await Promise.all([state.repo.load(), state.getSpec()]);

    return presets.map(({ preset, trust, sha256 }) => {
      const plan = compilePlan(preset, spec);
      return {
        id: preset.id,
        name: preset.name,
        version: preset.version,
        description: preset.description,
        risk: preset.risk,
        tags: preset.tags,
        authors: preset.authors.map((a) => a.handle),
        license: preset.license,
        applicable: plan.compatibility.applicable && plan.steps.length > 0,
        matchScore: plan.compatibility.score,
        matchReasons: plan.compatibility.reasons,
        stepCount: plan.steps.length,
        summary: plan.summary,
        blocked: plan.blocked,
        needsConsent: plan.needsConsent,
        blockers: plan.findings.filter((f) => f.severity === 'block').map((f) => f.message),
        consents: plan.findings.filter((f) => f.severity === 'consent').map((f) => f.message),
        warnings: plan.warnings,
        trust,
        sha256,
      };
    });
  });

  handle(IPC_CHANNELS.presetsPlan, async (raw) => {
    const { presetId } = parsePayload<{ presetId: string }>(presetIdRequest, raw);
    const loaded = await state.repo.get(presetId);
    if (loaded === null) throw new TuneSmithError('unavailable', `Preset "${presetId}" was not found.`);
    const spec = await state.getSpec();
    return compilePlan(loaded.preset, spec);
  });

  // Read-only: the renderer can request the dependency map for a preset it has
  // already previewed, but it cannot supply service names or a registry path.
  handle<ServiceDependencyGraph>(IPC_CHANNELS.presetsServiceDependencies, async (raw) => {
    const { presetId } = parsePayload<{ presetId: string }>(presetIdRequest, raw);
    const loaded = await state.repo.get(presetId);
    if (loaded === null) throw new TuneSmithError('unavailable', `Preset \"${presetId}\" was not found.`);
    const spec = await state.getSpec();
    const plan = compilePlan(loaded.preset, spec);
    const serviceActions: ServiceDependencyAction[] = [];
    for (const step of plan.steps) {
      if (step.action.kind === 'service') serviceActions.push(step.action);
    }
    if (serviceActions.length === 0) {
      return { targets: [], servicesRead: 0, missingTargets: [], truncated: false, warnings: [] };
    }
    return buildServiceDependencyGraph(await readServiceRegistry(), serviceActions);
  });

  handle<void>(IPC_CHANNELS.presetsOpenFolder, async () => {
    const error = await shell.openPath(state.presetsDir);
    if (error.length > 0) throw new TuneSmithError('unavailable', `Could not open the preset folder: ${error}`);
  });

  handle<MarketStatus>(IPC_CHANNELS.marketStatus, async (raw) => {
    const parsed =
      raw === undefined
        ? { refresh: false }
        : parsePayload<{ refresh?: boolean }>(marketStatusRequest, raw);
    return state.market.status(parsed.refresh === true);
  });

  handle<InstallResult>(IPC_CHANNELS.marketInstall, async (raw) => {
    const { presetId } = parsePayload<{ presetId: string }>(marketInstallRequest, raw);
    return state.market.install(presetId);
  });

  handle<MarketStatus>(IPC_CHANNELS.marketTelemetryConsent, async (raw) => {
    const { consent } = parsePayload<{ consent: boolean }>(telemetryConsentRequest, raw);
    return state.market.setConsent(consent);
  });

  handle<PublishConfig>(IPC_CHANNELS.marketPublishConfig, async () => state.marketPublisher.config());

  handle<PublishCandidate | null>(IPC_CHANNELS.marketPickPublishPreset, async () => {
    const parent = getWindow();
    const options: OpenDialogOptions = {
      title: 'Choose a preset to publish',
      properties: ['openFile'],
      filters: [{ name: 'TuneSmith preset', extensions: ['json'] }],
    };
    const picked =
      parent === null || parent.isDestroyed()
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(parent, options);
    if (picked.canceled) return null;
    const selected = picked.filePaths[0];
    return selected === undefined ? null : state.marketPublisher.prepare(selected);
  });

  handle<PublishResult>(IPC_CHANNELS.marketPublish, async (raw) => {
    const request = parsePayload<{
      token: string;
      virusTotalKey?: string;
      githubToken?: string;
    }>(marketPublishRequest, raw);
    return state.marketPublisher.publish(request);
  });

  handle<void>(IPC_CHANNELS.marketOpenPublishLink, async (raw) => {
    const { url } = parsePayload<{ url: string }>(marketOpenPublishLinkRequest, raw);
    await shell.openExternal(url);
  });

  handle(IPC_CHANNELS.safetyPreflight, async () =>
    runPreflight({
      journal: state.journal,
      getSpec: state.getSpec,
      isElevated: () => isElevated(),
      probeRestore: () => probeSystemRestore(),
      lockHolder: () => state.lock.currentHolder(),
    }),
  );

  handle(IPC_CHANNELS.engineApply, async (raw) => {
    // A game profile and a tuning preset must not touch the machine at the same time.
    if (state.game.hasActiveSession()) {
      throw new TuneSmithError('invalid-request', 'Stop the active game session before applying a preset.');
    }

    const request = parsePayload<{ presetId: string; expectedSignature: string; acknowledgeConsent: boolean; acknowledgeRisk: boolean }>(
      applyRequestSchema,
      raw,
    );

    const spec = await state.getSpec();
    if (spec.signature !== request.expectedSignature) {
      throw new TuneSmithError(
        'invalid-request',
        'Hardware changed since this preset was previewed. Re-open the preset and try again.',
      );
    }

    const loaded = await state.repo.get(request.presetId);
    if (loaded === null) throw new TuneSmithError('unavailable', `Preset "${request.presetId}" was not found.`);

    const plan = compilePlan(loaded.preset, spec);
    // A successful aggressive apply below starts a fresh five-minute window. Never
    // let a previous window silently cover a new session.
    state.postApply.reset();
    state.executor.onProgress = (progress) => {
      getWindow()?.webContents.send(EVENT_CHANNELS.progress, progress);
    };

    const outcome = await state.executor.apply(plan, {
      acknowledgeConsent: request.acknowledgeConsent,
      acknowledgeRisk: request.acknowledgeRisk,
    });

    // Local-only by default; an upload happens only when the user has opted in.
    void state.market.recordEvent(
      plan.presetId,
      plan.presetVersion,
      outcome.status === 'applied' ? 'apply-ok' : 'apply-failed',
    );
    refreshHealth();

    if (outcome.status === 'applied' && loaded.preset.risk === 'aggressive') {
      state.postApply.start({
        sessionId: outcome.sessionId,
        presetId: loaded.preset.id,
        presetName: loaded.preset.name,
      });
    }

    return outcome;
  });

  handle(IPC_CHANNELS.engineSessions, async () => state.journal.summaries());

  handle(IPC_CHANNELS.engineRollback, async (raw) => {
    const { sessionId } = parsePayload<{ sessionId: string }>(sessionIdRequest, raw);
    state.postApply.cancel('Stability monitoring stopped for a manual rollback.');
    const before = (await state.journal.summaries()).find((summary) => summary.id === sessionId);
    const report = await state.executor.rollback(sessionId);
    if (report.ok && before?.interrupted === true) {
      void state.market.recordEvent(before.presetId, before.presetVersion, 'session-recovered');
    }
    refreshHealth();
    return report;
  });

  handle(IPC_CHANNELS.engineRestoreDefaults, async () => {
    state.postApply.cancel('Stability monitoring stopped for Restore to Default.');
    const reports = await state.executor.restoreDefaults();
    refreshHealth();
    return reports;
  });

  handle<HealthStatus>(IPC_CHANNELS.healthStatus, async () => state.health.statusSnapshot());

  handle<HealthStatus>(IPC_CHANNELS.healthCheck, async () => state.health.check());

  handle<HealthStatus>(IPC_CHANNELS.healthAcknowledge, async () => state.health.acknowledge());

  handle<HealthStatus>(IPC_CHANNELS.healthPin, async (raw) => {
    const { presetId } = parsePayload<{ presetId: string | null }>(healthPinRequest, raw);
    if (presetId !== null) {
      const loaded = await state.repo.get(presetId);
      if (loaded === null) throw new TuneSmithError('unavailable', `Preset \"${presetId}\" was not found.`);
    }
    return state.health.pin(presetId);
  });

  handle<HealthFlushResult>(IPC_CHANNELS.healthFlushJournals, async () => state.health.flushJournals());

  handle<ShaderCacheStatus>(IPC_CHANNELS.shaderCacheStatus, async () => state.shaderCache.status());

  handle<ShaderCacheStatus>(IPC_CHANNELS.shaderCacheScan, async (raw) => {
    const parsed =
      raw === undefined
        ? { refresh: false }
        : parsePayload<{ refresh?: boolean }>(shaderCacheScanRequest, raw);
    return state.shaderCache.scan(parsed.refresh === true);
  });

  handle<ShaderCachePruneResult>(IPC_CHANNELS.shaderCachePrune, async (raw) => {
    const request = parsePayload<{ cacheIds: ['directx']; confirm: true }>(shaderCachePruneRequest, raw);
    if (state.game.hasActiveSession()) {
      throw new TuneSmithError('invalid-request', 'Restore the active game session before pruning shader caches.');
    }
    return state.shaderCache.prune(request.cacheIds);
  });

  handle<PostApplyStatus>(IPC_CHANNELS.enginePostApply, async () => state.postApply.status());

  handle<GameStatus>(IPC_CHANNELS.gameStatus, async () => state.game.status());

  handle<GameStatus>(IPC_CHANNELS.gameSetWatching, async (raw) => {
    const { enabled } = parsePayload<{ enabled: boolean }>(gameWatchingRequest, raw);
    return state.game.setWatching(enabled);
  });

  handle<GameStatus>(IPC_CHANNELS.gameSetCryoFreeze, async (raw) => {
    const { enabled } = parsePayload<{ enabled: boolean }>(gameCryoFreezeRequest, raw);
    return state.game.setCryoFreeze(enabled);
  });

  handle<GameStatus>(IPC_CHANNELS.gameSetInterruptAffinity, async (raw) => {
    const { enabled } = parsePayload<{ enabled: boolean }>(gameInterruptAffinityRequest, raw);
    return state.game.setInterruptAffinity(enabled);
  });

  handle<GameStatus>(IPC_CHANNELS.gameStop, async () => state.game.stopActive());

  handle<OsdStatus>(IPC_CHANNELS.gameOsd, async () => overlay?.status() ?? OSD_UNAVAILABLE);

  handle<OsdStatus>(IPC_CHANNELS.gameOsdSet, async (raw) => {
    const { enabled } = parsePayload<{ enabled: boolean }>(osdToggleRequest, raw);
    if (overlay === undefined) {
      throw new TuneSmithError('unavailable', 'Performance OSD is unavailable in this build.');
    }
    return overlay.setEnabled(enabled);
  });

  // Native-picker paths stay in main. The renderer receives a token, never a capability
  // to name an arbitrary executable in the add request. Tickets expire and the map is
  // bounded, so a compromised renderer cannot accumulate paths indefinitely.
  const pickedPaths = new Map<string, { path: string; kind: GamePathPickKind; expiresAt: number }>();
  const PICK_TTL_MS = 10 * 60 * 1000;
  const PICK_LIMIT = 50;

  const rememberPickedPath = (selectedPath: string, kind: GamePathPickKind): PickedGamePath => {
    const now = Date.now();
    for (const [token, entry] of pickedPaths) {
      if (entry.expiresAt <= now) pickedPaths.delete(token);
    }
    while (pickedPaths.size >= PICK_LIMIT) {
      const oldest = pickedPaths.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      pickedPaths.delete(oldest);
    }
    const token = randomUUID();
    pickedPaths.set(token, { path: selectedPath, kind, expiresAt: now + PICK_TTL_MS });
    return { token, path: selectedPath, kind };
  };

  const resolvePickedPath = (token: string, kind: GamePathPickKind): string => {
    const entry = pickedPaths.get(token);
    if (entry === undefined || entry.expiresAt <= Date.now() || entry.kind !== kind) {
      throw new TuneSmithError('invalid-request', 'Choose the install folder and executable again.');
    }
    return entry.path;
  };

  handle<GameLibraryScanResult>(IPC_CHANNELS.gameLibraries, async (raw) => {
    const parsed =
      raw === undefined
        ? { refresh: false }
        : parsePayload<{ refresh?: boolean }>(gameLibraryScanRequest, raw);
    const scan = await state.libraries.scan(parsed.refresh === true);
    return attachProfileMatches(scan, state.game.profileList());
  });

  handle<DiscoveredGame>(IPC_CHANNELS.gameAddManual, async (raw) => {
    const request = parsePayload<ManualGameAddRequest>(manualGameAddRequest, raw);
    const input = {
      name: request.name,
      installDir: resolvePickedPath(request.installDirToken, 'folder'),
      executablePath: resolvePickedPath(request.executableToken, 'executable'),
    };
    const game = await state.libraries.addManualGame(input);
    pickedPaths.delete(request.installDirToken);
    pickedPaths.delete(request.executableToken);
    void state.game.refreshGameCandidates();
    return game;
  });

  handle<boolean>(IPC_CHANNELS.gameRemoveManual, async (raw) => {
    const { gameId } = parsePayload<{ gameId: string }>(gameIdRequest, raw);
    const removed = await state.libraries.removeManualGame(gameId);
    if (removed) void state.game.refreshGameCandidates();
    return removed;
  });

  handle<PickedGamePath | null>(IPC_CHANNELS.gamePickPath, async (raw) => {
    const { kind } = parsePayload<{ kind: GamePathPickKind }>(gamePathPickRequest, raw);
    const options: OpenDialogOptions =
      kind === 'folder'
        ? { title: 'Choose the game install folder', properties: ['openDirectory'] }
        : {
            title: 'Choose the game executable',
            properties: ['openFile'],
            filters: [{ name: 'Executables', extensions: ['exe'] }],
          };
    const parent = getWindow();
    const result =
      parent === null || parent.isDestroyed()
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(parent, options);
    if (result.canceled) return null;
    const selected = result.filePaths[0];
    return selected === undefined ? null : rememberPickedPath(selected, kind);
  });

  handle<GameArtworkBatch>(IPC_CHANNELS.gameArtwork, async (raw) => {
    const { games } = parsePayload<{ games: ArtworkRequestItem[] }>(artworkRequestSchema, raw);
    // Per-title failures are returned inside the batch; an outage must not break the grid.
    return state.artwork.artworkForGames(games);
  });

  // Zero-key Steam artwork. The renderer supplies only an App ID; every URL is built
  // from the validated number in the resolver, never taken from the request.
  handle<ResolvedGameArtwork>(IPC_CHANNELS.gameResolveArtwork, async (raw) => {
    const { appId } = parsePayload<{ appId: string | number }>(artworkResolveRequest, raw);
    return state.artworkResolver.resolve(appId);
  });

  handle<void>(IPC_CHANNELS.gameOpenFolder, async (raw) => {
    const { path: requested } = parsePayload<{ path: string }>(gameFolderRequest, raw);
    const scan = await state.libraries.scan();
    // Both the request and the discovered install root go through the same validator.
    const game = resolveGameFolder(requested, scan.games);
    const info = await stat(game.installDir).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new TuneSmithError('unavailable', 'That game folder no longer exists. Rescan the libraries and try again.');
    }

    const error = await shell.openPath(game.installDir);
    if (error.length > 0) {
      throw new TuneSmithError('unavailable', `Windows could not open the game folder: ${error}`);
    }
  });

  handle<GameLaunchResult>(IPC_CHANNELS.gameLaunch, async (raw) => {
    const { gameId } = parsePayload<{ gameId: string }>(gameLaunchRequest, raw);
    if (state.game.hasActiveSession()) {
      throw new TuneSmithError('invalid-request', 'Restore the active game session before launching another title.');
    }

    const scan = await state.libraries.scan();
    const game = findGameById(scan.games, gameId);
    if (game === null) {
      throw new TuneSmithError('unavailable', 'That game is no longer in the detected libraries. Rescan and try again.');
    }

    // The launcher never accepts a path: it starts one of this title's detected
    // executables, inside its detected install root.
    const executable = resolveLaunchExecutable(game);
    const info = await stat(executable).catch(() => null);
    if (info === null || !info.isFile()) {
      throw new TuneSmithError('unavailable', 'The detected executable no longer exists. Rescan the libraries and try again.');
    }

    // Arm the watcher first: the process can appear before the launch call returns.
    const status = await state.game.setWatching(true);
    const error = await shell.openPath(executable);
    if (error.length > 0) {
      return {
        gameId,
        launched: false,
        watching: status.watching,
        executablePath: executable,
        message: `Windows could not start ${game.name}: ${error}`,
      };
    }

    return {
      gameId,
      launched: true,
      watching: status.watching,
      executablePath: executable,
      message: `Starting ${game.name}. Game mode will apply its profile when the process appears.`,
    };
  });

  handle<GameProfileSummary[]>(IPC_CHANNELS.gameProfiles, async () => {
    state.game.status();
    const profiles = state.game.profileList();
    const scan = await state.libraries.scan();
    const installed = installedProfilePaths(scan, profiles);
    return profiles.map((profile) => {
      const findings = state.game.evaluate(profile);
      return {
        id: profile.id,
        name: profile.name,
        version: profile.version,
        description: profile.description,
        risk: profile.risk,
        exe: profile.trigger.exe ?? '',
        packageFamilyName: profile.trigger.packageFamilyName ?? null,
        blocked: findings.some((finding) => finding.severity === 'block'),
        findings: findings.map((finding) => finding.message),
        actions: describeActions(profile),
        notes: profile.notes ?? [],
        installed: installed.has(profile.id),
        detectedPath: installed.get(profile.id) ?? null,
      };
    });
  });
}
