/**
 * The context bridge.
 *
 * Runs with `sandbox: true` and `contextIsolation: true`, so it can reach `ipcRenderer`
 * but not Node, the filesystem, or the main process objects. It exposes exactly the
 * methods in `TuneSmithApi` and nothing else: no generic `invoke(channel, ...)` escape
 * hatch, which would hand the renderer the whole privileged IPC surface.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { EVENT_CHANNELS, IPC_CHANNELS } from '../shared/channels';
import type { ElevationResult, IpcEnvelope, PresetSummary, TuneSmithApi } from '../shared/ipc';
import type { CompiledPlan } from '../shared/preset/compiler';
import type { ServiceDependencyGraph } from '../shared/service-graph';
import type {
  AppInfo,
  ApplyOutcome,
  EngineProgress,
  MemorySnapshot,
  PreflightReport,
  RollbackReport,
  SessionSummary,
} from '../shared/session';
import type { HardwareSpec } from '../shared/types';
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
import type { InstallResult, MarketStatus } from '../shared/market/types';
import type { PublishCandidate, PublishConfig, PublishResult } from '../shared/market/publish';
import type { HealthFlushResult, HealthStatus } from '../shared/health/types';
import type { ShaderCachePruneResult, ShaderCacheStatus } from '../shared/shader-cache';
import type { PostApplyStatus } from '../shared/post-apply';
import type { UpdaterStatus } from '../shared/updater';
import type { DiagnosticsExportResult, DiagnosticsStatus } from '../shared/diagnostics/types';

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const response = (await ipcRenderer.invoke(channel, ...args)) as IpcEnvelope<T> | undefined;

  if (response === undefined || typeof response !== 'object') {
    throw new Error(`Malformed IPC response on ${channel}`);
  }
  if (!response.ok) {
    const error = new Error(response.error.message) as Error & { code?: string };
    error.code = response.error.code;
    throw error;
  }
  return response.value;
}

const api: TuneSmithApi = {
  bridgeVersion: 1,
  mock: false,

  getArtwork: (appId: string | number) =>
    invoke<ResolvedGameArtwork>(IPC_CHANNELS.gameResolveArtwork, { appId }),

  app: {
    info: () => invoke<AppInfo>(IPC_CHANNELS.appInfo),
    memory: () => invoke<MemorySnapshot>(IPC_CHANNELS.appMemory),
    requestElevation: () => invoke<ElevationResult>(IPC_CHANNELS.appElevation),
  },

  hardware: {
    get: (forceRefresh = false) => invoke<HardwareSpec>(IPC_CHANNELS.hardwareGet, forceRefresh),
  },

  updater: {
    status: () => invoke<UpdaterStatus>(IPC_CHANNELS.updateStatus),
    check: () => invoke<UpdaterStatus>(IPC_CHANNELS.updateCheck),
    install: () => invoke<void>(IPC_CHANNELS.installUpdate),
    onStatus: (listener: (status: UpdaterStatus) => void) => {
      const handler = (_event: unknown, payload: UpdaterStatus): void => listener(payload);
      ipcRenderer.on(EVENT_CHANNELS.updateStatus, handler);
      return () => {
        ipcRenderer.removeListener(EVENT_CHANNELS.updateStatus, handler);
      };
    },
  },

  presets: {
    list: () => invoke<PresetSummary[]>(IPC_CHANNELS.presetsList),
    plan: (presetId: string) => invoke<CompiledPlan>(IPC_CHANNELS.presetsPlan, { presetId }),
    serviceDependencies: (presetId: string) =>
      invoke<ServiceDependencyGraph>(IPC_CHANNELS.presetsServiceDependencies, { presetId }),
    openFolder: () => invoke<void>(IPC_CHANNELS.presetsOpenFolder),
  },

  safety: {
    preflight: () => invoke<PreflightReport>(IPC_CHANNELS.safetyPreflight),
  },

  engine: {
    apply: (request) => invoke<ApplyOutcome>(IPC_CHANNELS.engineApply, request),
    sessions: () => invoke<SessionSummary[]>(IPC_CHANNELS.engineSessions),
    rollback: (sessionId: string) => invoke<RollbackReport>(IPC_CHANNELS.engineRollback, { sessionId }),
    restoreDefaults: () => invoke<RollbackReport[]>(IPC_CHANNELS.engineRestoreDefaults),
    postApply: () => invoke<PostApplyStatus>(IPC_CHANNELS.enginePostApply),
    onPostApply: (listener: (status: PostApplyStatus) => void) => {
      const handler = (_event: unknown, payload: PostApplyStatus): void => listener(payload);
      ipcRenderer.on(EVENT_CHANNELS.postApplyStatus, handler);
      return () => {
        ipcRenderer.removeListener(EVENT_CHANNELS.postApplyStatus, handler);
      };
    },
  },

  game: {
    status: () => invoke<GameStatus>(IPC_CHANNELS.gameStatus),
    setWatching: (enabled: boolean) => invoke<GameStatus>(IPC_CHANNELS.gameSetWatching, { enabled }),
    setCryoFreeze: (enabled: boolean) =>
      invoke<GameStatus>(IPC_CHANNELS.gameSetCryoFreeze, { enabled }),
    setInterruptAffinity: (enabled: boolean) =>
      invoke<GameStatus>(IPC_CHANNELS.gameSetInterruptAffinity, { enabled }),
    profiles: () => invoke<GameProfileSummary[]>(IPC_CHANNELS.gameProfiles),
    libraries: (refresh = false) => invoke<GameLibraryScanResult>(IPC_CHANNELS.gameLibraries, { refresh }),
    addManual: (input: ManualGameAddRequest) => invoke<DiscoveredGame>(IPC_CHANNELS.gameAddManual, input),
    removeManual: (gameId: string) => invoke<boolean>(IPC_CHANNELS.gameRemoveManual, { gameId }),
    pickPath: (kind: GamePathPickKind) => invoke<PickedGamePath | null>(IPC_CHANNELS.gamePickPath, { kind }),
    artwork: (games: ArtworkRequestItem[]) =>
      invoke<GameArtworkBatch>(IPC_CHANNELS.gameArtwork, { games }),
    openFolder: (folderPath: string) => invoke<void>(IPC_CHANNELS.gameOpenFolder, { path: folderPath }),
    launch: (gameId: string) => invoke<GameLaunchResult>(IPC_CHANNELS.gameLaunch, { gameId }),
    stop: () => invoke<GameStatus>(IPC_CHANNELS.gameStop),
    osd: () => invoke<OsdStatus>(IPC_CHANNELS.gameOsd),
    setOsd: (enabled: boolean) => invoke<OsdStatus>(IPC_CHANNELS.gameOsdSet, { enabled }),
    onStatus: (listener: (status: GameStatus) => void) => {
      const handler = (_event: unknown, payload: GameStatus): void => listener(payload);
      ipcRenderer.on(EVENT_CHANNELS.gameStatus, handler);
      return () => {
        ipcRenderer.removeListener(EVENT_CHANNELS.gameStatus, handler);
      };
    },
  },

  health: {
    status: () => invoke<HealthStatus>(IPC_CHANNELS.healthStatus),
    check: () => invoke<HealthStatus>(IPC_CHANNELS.healthCheck),
    acknowledge: () => invoke<HealthStatus>(IPC_CHANNELS.healthAcknowledge),
    pin: (presetId: string | null) => invoke<HealthStatus>(IPC_CHANNELS.healthPin, { presetId }),
    flushJournals: () => invoke<HealthFlushResult>(IPC_CHANNELS.healthFlushJournals),
    onStatus: (listener: (status: HealthStatus) => void) => {
      const handler = (_event: unknown, payload: HealthStatus): void => listener(payload);
      ipcRenderer.on(EVENT_CHANNELS.healthStatus, handler);
      return () => {
        ipcRenderer.removeListener(EVENT_CHANNELS.healthStatus, handler);
      };
    },
  },

  shaderCache: {
    status: () => invoke<ShaderCacheStatus>(IPC_CHANNELS.shaderCacheStatus),
    scan: (refresh = false) => invoke<ShaderCacheStatus>(IPC_CHANNELS.shaderCacheScan, { refresh }),
    prune: (request) => invoke<ShaderCachePruneResult>(IPC_CHANNELS.shaderCachePrune, request),
  },

  market: {
    status: (refresh = false) => invoke<MarketStatus>(IPC_CHANNELS.marketStatus, { refresh }),
    install: (presetId: string) => invoke<InstallResult>(IPC_CHANNELS.marketInstall, { presetId }),
    setConsent: (consent: boolean) => invoke<MarketStatus>(IPC_CHANNELS.marketTelemetryConsent, { consent }),
    publishConfig: () => invoke<PublishConfig>(IPC_CHANNELS.marketPublishConfig),
    pickPublishPreset: () => invoke<PublishCandidate | null>(IPC_CHANNELS.marketPickPublishPreset),
    publish: (request) => invoke<PublishResult>(IPC_CHANNELS.marketPublish, request),
    openPublishLink: (url: string) => invoke<void>(IPC_CHANNELS.marketOpenPublishLink, { url }),
  },

  diagnostics: {
    status: () => invoke<DiagnosticsStatus>(IPC_CHANNELS.diagnosticsStatus),
    exportBundle: (request) => invoke<DiagnosticsExportResult>(IPC_CHANNELS.diagnosticsExport, request),
    openFolder: () => invoke<void>(IPC_CHANNELS.diagnosticsOpenFolder),
  },

  events: {
    onProgress: (listener: (progress: EngineProgress) => void) => {
      const handler = (_event: unknown, payload: EngineProgress): void => listener(payload);
      ipcRenderer.on(EVENT_CHANNELS.progress, handler);
      return () => {
        ipcRenderer.removeListener(EVENT_CHANNELS.progress, handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld('tunesmith', api);
