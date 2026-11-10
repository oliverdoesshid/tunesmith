/**
 * In-memory mock of the preload bridge.
 *
 * Deliberately compiled from the *real* preset files through the *real* compiler and
 * policy layer, so the browser preview shows exactly what the app would show for this
 * fixture machine. Only the side effects are simulated.
 */
import type { ApplyRequest, ElevationResult, PresetSummary, TuneSmithApi } from '../../shared/ipc';
import type { CompiledPlan } from '../../shared/preset/compiler';
import { compilePlan } from '../../shared/preset/compiler';
import { formatZodIssues, presetSchema, type Preset } from '../../shared/preset/schema';
import type {
  AppInfo,
  ApplyOutcome,
  EngineProgress,
  PreflightReport,
  RollbackReport,
  SessionSummary,
} from '../../shared/session';
import type { HardwareSpec } from '../../shared/types';
import { describeActions } from '../../shared/game/describe';
import { evaluateGameProfile } from '../../shared/game/policy';
import { gameProfileSchema } from '../../shared/game/schema';
import type { GameProfile, GameProfileSummary, GameStatus } from '../../shared/game/types';

import cyberpunkGame from '../../../presets/games/cyberpunk-2077.json';
import esportsGame from '../../../presets/games/esports-low-latency.json';
import ecoGame from '../../../presets/games/efficiency-eco.json';
import siegeGame from '../../../presets/games/rainbow-six-siege.json';
import competitiveFps from '../../../presets/community/competitive-fps-low-latency.json';
import ultraLowLatency from '../../../presets/community/ultra-low-latency-aggressive.json';
import workstation from '../../../presets/community/workstation-throughput.json';
import hddRelief from '../../../presets/community/hdd-latency-relief.json';

const MOCK_SPEC: HardwareSpec = {
  schemaVersion: 1,
  signatureVersion: 1,
  cpu: {
    vendor: 'AMD',
    rawName: 'AMD Ryzen 5 5600X 6-Core Processor',
    model: 'Ryzen5_5600X',
    token: 'AMD_Ryzen5_5600X',
    cores: 6,
    threads: 12,
    maxClockMhz: 3701,
  },
  primaryGpu: {
    vendor: 'NVIDIA',
    rawName: 'NVIDIA GeForce RTX 3060',
    model: 'RTX3060',
    token: 'RTX3060',
    vramBytes: 12_884_901_888,
    vramGb: 12,
    driverVersion: '32.0.16.2101',
    kind: 'discrete',
    vramSource: 'registry',
  },
  gpus: [
    {
      vendor: 'NVIDIA',
      rawName: 'NVIDIA GeForce RTX 3060',
      model: 'RTX3060',
      token: 'RTX3060',
      vramBytes: 12_884_901_888,
      vramGb: 12,
      driverVersion: '32.0.16.2101',
      kind: 'discrete',
      vramSource: 'registry',
    },
  ],
  memory: { totalBytes: 34_273_869_824, totalGb: 31.9, bucketGb: 32, speedMhz: 3200, moduleCount: 2 },
  storage: {
    primary: { index: 0, model: 'KINGSTON SNV2S1000G', mediaType: 'SSD', bus: 'NVMe', sizeGb: 931.5, isSystem: true },
    devices: [
      { index: 0, model: 'KINGSTON SNV2S1000G', mediaType: 'SSD', bus: 'NVMe', sizeGb: 931.5, isSystem: true },
      { index: 1, model: 'WD Elements 10B8', mediaType: 'HDD', bus: 'USB', sizeGb: 931.5, isSystem: false },
    ],
  },
  os: { caption: 'Microsoft Windows 11 Pro', build: 26300, arch: '64-bit', isWindows11: true },
  signature: 'AMD_Ryzen5_5600X_RTX3060_32GB_SSD',
  detectedAt: new Date().toISOString(),
  warnings: [],
};

function loadPresets(): Preset[] {
  const raw: unknown[] = [competitiveFps, workstation, hddRelief, ultraLowLatency];
  const out: Preset[] = [];
  for (const candidate of raw) {
    const parsed = presetSchema.safeParse(candidate);
    if (parsed.success) out.push(parsed.data);
    else console.warn('mock preset failed validation', formatZodIssues(parsed.error));
  }
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function summarize(preset: Preset, spec: HardwareSpec): PresetSummary {
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
    trust: 'bundled-verified',
    sha256: '0'.repeat(64),
  };
}

function loadGameProfiles(): GameProfile[] {
  const parsed = [cyberpunkGame, esportsGame, ecoGame, siegeGame].flatMap((candidate) => {
    const result = gameProfileSchema.safeParse(candidate);
    return result.success ? [result.data] : [];
  });
  return parsed;
}

export function createMockBridge(): TuneSmithApi {
  const presets = loadPresets();
  const gameProfiles = loadGameProfiles();
  const listeners = new Set<(progress: EngineProgress) => void>();
  let sessions: SessionSummary[] = [];

  const gameListeners = new Set<(status: GameStatus) => void>();
  let gameStatus: GameStatus = {
    watching: false,
    phase: 'idle',
    watcherHealthy: false,
    active: null,
    pendingRestore: null,
    lastError: null,
    topology: {
      logicalProcessors: 12,
      physicalCores: 6,
      hybrid: false,
      efficiencyClasses: new Array<number>(12).fill(0),
      coreIndices: [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5],
      source: 'synthetic',
      higherEfficiencyIsFaster: true,
    },
    packages: [],
    profiles: gameProfiles.length,
    pollMs: 2000,
  };

  const setGameStatus = (next: GameStatus): GameStatus => {
    gameStatus = next;
    for (const listener of gameListeners) listener(next);
    return next;
  };

  const gameSummaries: GameProfileSummary[] = gameProfiles.map((profile) => {
    const findings = evaluateGameProfile(profile, gameStatus.topology);
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
    };
  });

  const emit = (progress: EngineProgress): void => {
    for (const listener of listeners) listener(progress);
  };

  const findByKey = (id: string): Preset => {
    const found = presets.find((p) => p.id === id);
    if (found === undefined) throw new Error(`Preset "${id}" not found`);
    return found;
  };

  const compile = (id: string): CompiledPlan => compilePlan(findByKey(id), MOCK_SPEC);

  const info: AppInfo = {
    appVersion: '0.1.0-preview',
    electronVersion: 'n/a (browser preview)',
    platform: 'win32',
    isElevated: false,
    devMode: true,
    sessionsDir: 'C:\\Users\\you\\AppData\\Roaming\\TuneSmith\\sessions',
    presetCount: presets.length,
  };

  const preflight: PreflightReport = {
    checks: [
      { id: 'platform', label: 'Windows', status: 'ok', detail: 'Running on Windows.' },
      { id: 'os-build', label: 'Windows version', status: 'ok', detail: 'Microsoft Windows 11 Pro (build 26300).' },
      { id: 'signature', label: 'Hardware signature', status: 'ok', detail: MOCK_SPEC.signature },
      {
        id: 'elevation',
        label: 'Administrator rights',
        status: 'fail',
        detail: 'Browser preview only: signing in as administrator is required in the desktop app.',
      },
      { id: 'journal', label: 'Rollback journal', status: 'ok', detail: 'Preview journal (in memory).' },
      { id: 'system-restore', label: 'System Restore', status: 'ok', detail: 'System Protection is available.' },
      { id: 'engine-idle', label: 'Engine state', status: 'ok', detail: 'No other session is running.' },
    ],
    ready: false,
    isElevated: false,
    signature: MOCK_SPEC.signature,
    inFlightSession: null,
  };

  return {
    bridgeVersion: 1,
    mock: true,

    app: {
      info: async () => info,
      requestElevation: async (): Promise<ElevationResult> => ({
        relaunching: false,
        detail: 'Elevation is unavailable in the browser preview.',
      }),
    },

    hardware: {
      get: async () => MOCK_SPEC,
    },

    presets: {
      list: async () => presets.map((p) => summarize(p, MOCK_SPEC)),
      plan: async (presetId: string) => compile(presetId),
      openFolder: async () => undefined,
    },

    safety: {
      preflight: async () => preflight,
    },

    engine: {
      apply: async (request: ApplyRequest): Promise<ApplyOutcome> => {
        const plan = compile(request.presetId);

        emit({ phase: 'restore-point', message: 'Creating a System Restore checkpoint…' });
        await sleep(600);

        for (const [index, step] of plan.steps.entries()) {
          emit({
            phase: 'apply',
            message: step.label,
            current: index + 1,
            total: plan.steps.length,
            step: { label: step.label, target: step.target, status: 'applied' },
          });
          await sleep(320);
        }

        const session: SessionSummary = {
          id: `preview-${String(Date.now())}`,
          createdAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          presetId: plan.presetId,
          presetName: plan.presetName,
          presetVersion: plan.presetVersion,
          presetRisk: plan.risk,
          signature: plan.signature,
          status: 'applied',
          restorePoint: { attempted: true, ok: true, detail: 'Preview checkpoint (simulated).' },
          stepCount: plan.steps.length,
          pendingRollback: plan.steps.length,
          interrupted: false,
        };
        sessions = [session, ...sessions];

        emit({ phase: 'done', message: `${plan.presetName} applied.` });

        return {
          sessionId: session.id,
          presetId: plan.presetId,
          status: 'applied',
          appliedSteps: plan.steps.length,
          skippedSteps: 0,
          failedStep: null,
          autoRolledBack: false,
          restorePoint: session.restorePoint,
          message: `${plan.steps.length} change(s) applied (preview only).`,
        };
      },

      sessions: async () => sessions,

      rollback: async (sessionId: string): Promise<RollbackReport> => {
        const session = sessions.find((s) => s.id === sessionId);
        const restored = session?.pendingRollback ?? 0;
        sessions = sessions.map((s) =>
          s.id === sessionId ? { ...s, status: 'rolled-back', pendingRollback: 0 } : s,
        );
        emit({ phase: 'done', message: 'Restored to previous values.' });
        return {
          sessionId,
          restored,
          failed: 0,
          errors: [],
          ok: true,
          message: `Restored ${restored} change(s) (preview only).`,
        };
      },

      restoreDefaults: async (): Promise<RollbackReport[]> => {
        const pending = sessions.filter((s) => s.pendingRollback > 0);
        sessions = sessions.map((s) =>
          s.pendingRollback > 0 ? { ...s, status: 'rolled-back', pendingRollback: 0 } : s,
        );
        emit({ phase: 'done', message: 'All changes restored.' });
        return pending.map((s) => ({
          sessionId: s.id,
          restored: s.pendingRollback,
          failed: 0,
          errors: [],
          ok: true,
          message: `Restored ${s.pendingRollback} change(s).`,
        }));
      },
    },

    game: {
      status: async () => gameStatus,
      setWatching: async (enabled: boolean) =>
        setGameStatus({ ...gameStatus, watching: enabled, watcherHealthy: false }),
      profiles: async () => gameSummaries,
      stop: async () => setGameStatus({ ...gameStatus, active: null, phase: 'idle' }),
      onStatus: (listener) => {
        gameListeners.add(listener);
        return () => {
          gameListeners.delete(listener);
        };
      },
    },

    events: {
      onProgress: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
}

/** The fixture machine the browser preview renders against. */
export const MOCK_HARDWARE = MOCK_SPEC;
