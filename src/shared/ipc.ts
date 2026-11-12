/**
 * The renderer <-> main contract.
 *
 * Types only (plus zod request schemas and channel names). The preload script imports
 * this to build the bridge, the renderer for typing, and the main process to validate
 * every inbound request. Channel payloads are validated in main even though the
 * renderer is ours: compromised renderer content must not be able to smuggle a
 * parameter into a privileged handler.
 */
import { z } from 'zod';
import { EVENT_CHANNELS, IPC_CHANNELS } from './channels';
import type { HardwareSpec, RiskLevel } from './types';
import type { CompiledPlan, StepGroup } from './preset/compiler';
import type { TrustLevel } from './preset/loader';
import type { ServiceDependencyGraph } from './service-graph';
import type {
  AppInfo,
  ApplyOutcome,
  EngineProgress,
  MemorySnapshot,
  PreflightReport,
  RollbackReport,
  SessionSummary,
} from './session';
import type {
  ArtworkRequestItem,
  GameArtworkBatch,
  ResolvedGameArtwork,
} from './game/artwork';
import type { OsdStatus } from './game/osd';
import type {
  DiscoveredGame,
  GameLaunchResult,
  GameLibraryScanResult,
  GamePathPickKind,
  GameProfileSummary,
  GameStatus,
  ManualGameAddRequest,
  PickedGamePath,
} from './game/types';
import type { InstallResult, MarketStatus } from './market/types';
import type { HealthFlushResult, HealthStatus } from './health/types';
import type {
  ShaderCachePruneRequest,
  ShaderCachePruneResult,
  ShaderCacheStatus,
} from './shader-cache';
import type { PostApplyStatus } from './post-apply';
import type { UpdaterStatus } from './updater';

// Re-exported so main-process code can import the contract from one place.
export { EVENT_CHANNELS, IPC_CHANNELS };

/* ---------------------------------------------------------------- *
 * Request schemas (validated in the main process)
 * ---------------------------------------------------------------- */

export const presetIdRequest = z.strictObject({
  presetId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
});

export const applyRequestSchema = z.strictObject({
  presetId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  /** The signature the user previewed against. Guards against hardware changing mid-flow. */
  expectedSignature: z.string().min(4).max(200),
  /** Must be true when the plan needs consent for restricted writes. */
  acknowledgeConsent: z.boolean(),
  /** Must be true for `aggressive` presets. */
  acknowledgeRisk: z.boolean(),
});

export const sessionIdRequest = z.strictObject({
  sessionId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
});

export const gameWatchingRequest = z.strictObject({
  enabled: z.boolean(),
});

export const gameCryoFreezeRequest = z.strictObject({
  enabled: z.boolean(),
});

export const gameInterruptAffinityRequest = z.strictObject({
  enabled: z.boolean(),
});

export const gameLibraryScanRequest = z.strictObject({
  refresh: z.boolean().optional(),
});

export const manualGameAddRequest = z.strictObject({
  name: z.string().trim().min(1).max(160),
  installDirToken: z.string().regex(/^[a-f0-9-]{36}$/),
  executableToken: z.string().regex(/^[a-f0-9-]{36}$/),
});

export const gameIdRequest = z.strictObject({
  gameId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/),
});

export const gamePathPickRequest = z.strictObject({
  kind: z.enum(['folder', 'executable']),
});

export const osdToggleRequest = z.strictObject({
  enabled: z.boolean(),
});

export const artworkRequestSchema = z.strictObject({
  games: z
    .array(
      z.strictObject({
        key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/),
        title: z.string().trim().min(1).max(160),
      }),
    )
    .min(1)
    .max(24),
});

/** A single Steam App ID for the zero-key artwork resolver. */
export const artworkResolveRequest = z.strictObject({
  appId: z.union([
    z.number().int().positive().max(4_294_967_295),
    z.string().trim().regex(/^[1-9][0-9]{0,9}$/),
  ]),
});

export const gameFolderRequest = z.strictObject({
  /** Must match a folder the library scanner discovered; validated again in main. */
  path: z.string().trim().min(3).max(32_767),
});

export const gameLaunchRequest = z.strictObject({
  gameId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/),
});

export const marketStatusRequest = z.strictObject({
  refresh: z.boolean().optional(),
});

export const marketInstallRequest = z.strictObject({
  presetId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
});

export const telemetryConsentRequest = z.strictObject({
  consent: z.boolean(),
});

export const healthPinRequest = z.strictObject({
  presetId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/).nullable(),
});

export const shaderCacheScanRequest = z.strictObject({
  refresh: z.boolean().optional(),
});

/** Only DirectX has metadata that can prove a cache file is orphaned. */
export const shaderCachePruneRequest = z.strictObject({
  cacheIds: z.array(z.literal('directx')).min(1).max(1),
  confirm: z.literal(true),
});

export type ApplyRequest = z.infer<typeof applyRequestSchema>;

/* ---------------------------------------------------------------- *
 * Response DTOs
 * ---------------------------------------------------------------- */

export interface PresetSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  risk: RiskLevel;
  tags: string[];
  authors: string[];
  license: string;
  applicable: boolean;
  /** 0..1 */
  matchScore: number;
  matchReasons: string[];
  stepCount: number;
  summary: Record<StepGroup, number>;
  blocked: boolean;
  needsConsent: boolean;
  blockers: string[];
  consents: string[];
  warnings: string[];
  trust: TrustLevel;
  sha256: string;
}

export interface ElevationResult {
  relaunching: boolean;
  detail: string;
}

/** Envelope used by every invoke channel, so failures survive the context bridge. */
export type IpcEnvelope<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

/* ---------------------------------------------------------------- *
 * The object exposed on `window.tunesmith`
 * ---------------------------------------------------------------- */

export interface TuneSmithApi {
  /** Bumped on breaking bridge changes so the renderer can refuse a stale preload. */
  readonly bridgeVersion: 1;
  /**
   * Zero-key Steam artwork: local Steam cache first, then Valve's public CDN, then a
   * placeholder. Safe to call for any library title; never throws for a missing title.
   */
  getArtwork(appId: string | number): Promise<ResolvedGameArtwork>;
  app: {
    info(): Promise<AppInfo>;
    /** Read-only physical-memory pressure sample for the live dashboard. */
    memory(): Promise<MemorySnapshot>;
    requestElevation(): Promise<ElevationResult>;
  };
  hardware: {
    get(forceRefresh?: boolean): Promise<HardwareSpec>;
  };
  updater: {
    status(): Promise<UpdaterStatus>;
    /** Request a feed check. Returns disabled status in development builds. */
    check(): Promise<UpdaterStatus>;
    /** Install a downloaded update; rejected before the download completes. */
    install(): Promise<void>;
    onStatus(listener: (status: UpdaterStatus) => void): () => void;
  };
  presets: {
    list(): Promise<PresetSummary[]>;
    plan(presetId: string): Promise<CompiledPlan>;
    /** Read-only SCM dependency map for the service actions in a preset plan. */
    serviceDependencies(presetId: string): Promise<ServiceDependencyGraph>;
    openFolder(): Promise<void>;
  };
  safety: {
    preflight(): Promise<PreflightReport>;
  };
  engine: {
    apply(request: ApplyRequest): Promise<ApplyOutcome>;
    sessions(): Promise<SessionSummary[]>;
    rollback(sessionId: string): Promise<RollbackReport>;
    restoreDefaults(): Promise<RollbackReport[]>;
    /** Five-minute post-apply stability status (aggressive presets only). */
    postApply(): Promise<PostApplyStatus>;
    onPostApply(listener: (status: PostApplyStatus) => void): () => void;
  };
  game: {
    status(): Promise<GameStatus>;
    setWatching(enabled: boolean): Promise<GameStatus>;
    /** Arm automatic suspension of a fixed allowlist of non-essential background processes. */
    setCryoFreeze(enabled: boolean): Promise<GameStatus>;
    /** Stage per-device GPU/NVMe/NIC interrupt affinity for the next game session. */
    setInterruptAffinity(enabled: boolean): Promise<GameStatus>;
    profiles(): Promise<GameProfileSummary[]>;
    /** Read-only scan of installed Steam, Epic, Xbox and GOG titles plus manual entries. */
    libraries(refresh?: boolean): Promise<GameLibraryScanResult>;
    /** Add a local title using paths the user selected in the native picker. */
    addManual(input: ManualGameAddRequest): Promise<DiscoveredGame>;
    removeManual(gameId: string): Promise<boolean>;
    /** Native folder/executable picker; returns null when the dialog is cancelled. */
    pickPath(kind: GamePathPickKind): Promise<PickedGamePath | null>;
    /**
     * SteamGridDB artwork for discovered titles. The renderer never sees a remote URL:
     * images are cached by the main process and served through `ts-art://`.
     */
    artwork(games: ArtworkRequestItem[]): Promise<GameArtworkBatch>;
    /** Open a detected install folder. Paths outside the scan are refused. */
    openFolder(path: string): Promise<void>;
    /** Start a detected executable and arm the profile watcher. */
    launch(gameId: string): Promise<GameLaunchResult>;
    /** Restore the active game session now. */
    stop(): Promise<GameStatus>;
    /** Availability of the separate, click-through performance overlay. */
    osd(): Promise<OsdStatus>;
    setOsd(enabled: boolean): Promise<OsdStatus>;
    onStatus(listener: (status: GameStatus) => void): () => void;
  };
  health: {
    status(): Promise<HealthStatus>;
    check(): Promise<HealthStatus>;
    acknowledge(): Promise<HealthStatus>;
    pin(presetId: string | null): Promise<HealthStatus>;
    flushJournals(): Promise<HealthFlushResult>;
    onStatus(listener: (status: HealthStatus) => void): () => void;
  };
  shaderCache: {
    status(): Promise<ShaderCacheStatus>;
    /** Read-only inventory; only fixed LocalAppData cache roots are inspected. */
    scan(refresh?: boolean): Promise<ShaderCacheStatus>;
    /** Explicitly confirmed deletion of whole, metadata-proven orphaned DirectX files. */
    prune(request: ShaderCachePruneRequest): Promise<ShaderCachePruneResult>;
  };
  market: {
    status(refresh?: boolean): Promise<MarketStatus>;
    /** Install a catalog entry after its signature and digest have been verified. */
    install(presetId: string): Promise<InstallResult>;
    setConsent(consent: boolean): Promise<MarketStatus>;
  };
  events: {
    onProgress(listener: (progress: EngineProgress) => void): () => void;
  };
  /** True when the renderer is running against the in-memory mock (browser preview). */
  readonly mock: boolean;
}
