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
import type { AppInfo, ApplyOutcome, EngineProgress, PreflightReport, RollbackReport, SessionSummary } from './session';
import type { GameProfileSummary, GameStatus } from './game/types';

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
    requestElevation(): Promise<ElevationResult>;
  };
  hardware: {
    get(forceRefresh?: boolean): Promise<HardwareSpec>;
  };
  presets: {
    list(): Promise<PresetSummary[]>;
    plan(presetId: string): Promise<CompiledPlan>;
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
  };
  game: {
    status(): Promise<GameStatus>;
    setWatching(enabled: boolean): Promise<GameStatus>;
    profiles(): Promise<GameProfileSummary[]>;
    /** Restore the active game session now. */
    stop(): Promise<GameStatus>;
    onStatus(listener: (status: GameStatus) => void): () => void;
  };
  events: {
    onProgress(listener: (progress: EngineProgress) => void): () => void;
  };
  /** True when the renderer is running against the in-memory mock (browser preview). */
  readonly mock: boolean;
}
