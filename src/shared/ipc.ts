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
import type { ArtworkRequestItem, GameArtworkBatch } from './game/artwork';
import type { OsdStatus } from './game/osd';
import type { GameLaunchResult, GameLibraryScanResult, GameProfileSummary, GameStatus } from './game/types';
import type { InstallResult, MarketStatus } from './market/types';
import type { HealthFlushResult, HealthStatus } from './health/types';
import type { PostApplyStatus } from './post-apply';

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

export const gameLibraryScanRequest = z.strictObject({
  refresh: z.boolean().optional(),
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
  app: {
    info(): Promise<AppInfo>;
    /** Read-only physical-memory pressure sample for the live dashboard. */
    memory(): Promise<MemorySnapshot>;
    requestElevation(): Promise<ElevationResult>;
  };
  hardware: {
    get(forceRefresh?: boolean): Promise<HardwareSpec>;
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
    profiles(): Promise<GameProfileSummary[]>;
    /** Read-only scan of installed Steam, Epic, Xbox and GOG titles. */
    libraries(refresh?: boolean): Promise<GameLibraryScanResult>;
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
