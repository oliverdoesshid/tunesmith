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
import { buildServiceDependencyGraph, type ServiceDependencyAction, type ServiceRegistryEntry } from '../../shared/service-graph';
import { formatZodIssues, presetSchema, type Preset } from '../../shared/preset/schema';
import type {
  AppInfo,
  ApplyOutcome,
  EngineProgress,
  MemorySnapshot,
  PreflightReport,
  RollbackReport,
  SessionSummary,
} from '../../shared/session';
import type { HardwareSpec } from '../../shared/types';
import { describeActions } from '../../shared/game/describe';
import { evaluateGameProfile } from '../../shared/game/policy';
import { gameProfileSchema } from '../../shared/game/schema';
import type { ArtworkRequestItem, GameArtwork } from '../../shared/game/artwork';
import type { OsdStatus } from '../../shared/game/osd';
import type { GameLibraryScanResult, GameProfile, GameProfileSummary, GameStatus } from '../../shared/game/types';
import { attachProfileMatches, installedProfilePaths } from '../../shared/game/library';
import type { MarketStatus } from '../../shared/market/types';
import type { HealthFlushResult, HealthStatus } from '../../shared/health/types';
import { idlePostApplyStatus, type PostApplyStatus } from '../../shared/post-apply';

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

/** Synthetic SCM rows for the browser preview; the real graph is read from PowerShell. */
const MOCK_SERVICE_REGISTRY: ServiceRegistryEntry[] = [
  { name: 'DcomLaunch', displayName: 'DCOM Server Process Launcher', start: 'Auto', dependsOn: [], dependsOnGroups: [] },
  { name: 'RpcSs', displayName: 'Remote Procedure Call (RPC)', start: 'Auto', dependsOn: ['DcomLaunch'], dependsOnGroups: [] },
  { name: 'DiagTrack', displayName: 'Connected User Experiences and Telemetry', start: 'Manual', dependsOn: ['RpcSs'], dependsOnGroups: [] },
  { name: 'WpnService', displayName: 'Windows Push Notifications System Service', start: 'Auto', dependsOn: ['RpcSs'], dependsOnGroups: [] },
  { name: 'EventLog', displayName: 'Windows Event Log', start: 'Auto', dependsOn: ['RpcSs'], dependsOnGroups: [] },
  { name: 'SysMain', displayName: 'SysMain', start: 'Auto', dependsOn: ['RpcSs', 'FileInfo'], dependsOnGroups: [] },
  { name: 'FileInfo', displayName: 'FileInfo', start: 'Boot', dependsOn: [], dependsOnGroups: [] },
  { name: 'WSearch', displayName: 'Windows Search', start: 'Auto', dependsOn: ['RpcSs'], dependsOnGroups: [] },
];

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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function svgDataUrl(width: number, height: number, body: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}">${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Locally generated placeholder art, so the browser preview can exercise the real UI. */
function mockArtwork(key: string, title: string): GameArtwork {
  const hue = [...key].reduce((total, char) => total + char.charCodeAt(0), 0) % 360;
  const base = `hsl(${String(hue)} 60% 28%)`;
  const accent = `hsl(${String((hue + 55) % 360)} 78% 58%)`;
  const initials =
    title
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? '')
      .join('') || '?';
  const safeTitle = escapeXml(title.slice(0, 34));
  const safeInitials = escapeXml(initials);

  const grid = svgDataUrl(
    600,
    900,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${base}"/><stop offset="1" stop-color="#0b1015"/></linearGradient></defs>` +
      `<rect width="600" height="900" fill="url(#g)"/><circle cx="500" cy="160" r="190" fill="${accent}" opacity="0.22"/>` +
      `<text x="48" y="740" fill="#e8f0f7" font-family="Segoe UI, sans-serif" font-size="150" font-weight="700">${safeInitials}</text>` +
      `<text x="48" y="820" fill="#8fa3b3" font-family="Segoe UI, sans-serif" font-size="30">${safeTitle}</text>`,
  );
  const hero = svgDataUrl(
    1920,
    620,
    `<defs><linearGradient id="h" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#0b1015"/><stop offset="0.55" stop-color="${base}"/><stop offset="1" stop-color="${accent}"/></linearGradient></defs>` +
      `<rect width="1920" height="620" fill="url(#h)"/><circle cx="1560" cy="120" r="320" fill="#5eead4" opacity="0.16"/>` +
      `<text x="120" y="360" fill="#e8f0f7" font-family="Segoe UI, sans-serif" font-size="92" font-weight="700">${safeTitle}</text>`,
  );
  const logo = svgDataUrl(
    600,
    200,
    `<text x="4" y="140" fill="#e8f0f7" font-family="Segoe UI, sans-serif" font-size="88" font-weight="800">${safeTitle}</text>`,
  );

  return {
    key,
    title,
    status: 'ok',
    steamGridDbId: null,
    matchedTitle: title,
    grid: { url: grid, width: 600, height: 900 },
    hero: { url: hero, width: 1920, height: 620 },
    logo: { url: logo, width: 600, height: 200 },
    message: null,
  };
}

export function createMockBridge(): TuneSmithApi {
  const presets = loadPresets();
  const gameProfiles = loadGameProfiles();
  const listeners = new Set<(progress: EngineProgress) => void>();
  let sessions: SessionSummary[] = [];

  const gameListeners = new Set<(status: GameStatus) => void>();
  const healthListeners = new Set<(status: HealthStatus) => void>();
  const postApplyListeners = new Set<(status: PostApplyStatus) => void>();
  let postApplyStatus: PostApplyStatus = idlePostApplyStatus();
  let osdEnabled = true;

  const setPostApplyStatus = (next: PostApplyStatus): PostApplyStatus => {
    postApplyStatus = next;
    for (const listener of postApplyListeners) listener(next);
    return next;
  };

  const osdStatus = (): OsdStatus => ({
    enabled: osdEnabled,
    visible: false,
    message: osdEnabled
      ? 'Preview: the OSD appears over an active game session in the desktop app.'
      : 'Performance OSD is off.',
  });
  let marketStatus: MarketStatus = {
    configured: false,
    source: null,
    fetchedAt: null,
    error: null,
    rejected: [],
    entries: [],
    telemetry: {
      consent: false,
      pending: 0,
      uploadConfigured: false,
      lastUploadAt: null,
      lastUploadError: null,
    },
  };

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
    telemetry: null,
    guard: null,
    profiles: gameProfiles.length,
    pollMs: 2000,
  };

  const setGameStatus = (next: GameStatus): GameStatus => {
    gameStatus = next;
    for (const listener of gameListeners) listener(next);
    return next;
  };

  const libraryScan: GameLibraryScanResult = attachProfileMatches(
    {
      scannedAt: '2026-01-01T00:00:00.000Z',
      errors: [{ source: 'gog', message: 'GOG registry access is unavailable in the browser preview.' }],
      games: [
        {
          id: 'steam:1091500',
          name: 'Cyberpunk 2077',
          source: 'steam',
          appId: '1091500',
          installDir: 'D:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077',
          executables: [
            {
              name: 'Cyberpunk2077.exe',
              path: 'D:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077\\bin\\x64\\Cyberpunk2077.exe',
            },
          ],
          executablePath:
            'D:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077\\bin\\x64\\Cyberpunk2077.exe',
          packageFamilyName: null,
          profileIds: [],
        },
        {
          id: 'steam:730',
          name: 'Counter-Strike 2',
          source: 'steam',
          appId: '730',
          installDir: 'D:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive',
          executables: [
            {
              name: 'cs2.exe',
              path: 'D:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe',
            },
          ],
          executablePath:
            'D:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe',
          packageFamilyName: null,
          profileIds: [],
        },
        {
          id: 'epic:AlanWake2',
          name: 'Alan Wake 2',
          source: 'epic',
          appId: 'AlanWake2',
          installDir: 'C:\\Program Files\\Epic Games\\AlanWake2',
          executables: [
            {
              name: 'AlanWake2.exe',
              path: 'C:\\Program Files\\Epic Games\\AlanWake2\\AlanWake2.exe',
            },
          ],
          executablePath: 'C:\\Program Files\\Epic Games\\AlanWake2\\AlanWake2.exe',
          packageFamilyName: null,
          profileIds: [],
        },
      ],
    },
    gameProfiles,
  );
  const installedProfiles = installedProfilePaths(libraryScan, gameProfiles);

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
      installed: installedProfiles.has(profile.id),
      detectedPath: installedProfiles.get(profile.id) ?? null,
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

  const pinnedHealthPreset = presets.find((preset) => preset.id === 'competitive-fps-low-latency') ?? presets[0] ?? null;
  let healthStatus: HealthStatus = {
    watchdog: 'healthy',
    lastCheckAt: '2026-01-01T00:05:00.000Z',
    baselineCapturedAt: '2026-01-01T00:00:00.000Z',
    os: { build: '26100', revision: 1742, displayVersion: '24H2' },
    signals: [
      {
        id: 'servicing-rebootPending',
        kind: 'servicing',
        severity: 'warning',
        title: 'Windows servicing state changed',
        detail: 'New: component servicing restart pending. A cumulative update may overwrite tuning values.',
      },
    ],
    warnings: [],
    error: null,
    pinnedPresetId: pinnedHealthPreset?.id ?? null,
    pinnedPreset:
      pinnedHealthPreset === null
        ? null
        : { id: pinnedHealthPreset.id, name: pinnedHealthPreset.name, version: pinnedHealthPreset.version },
    pinnedPresetMissing: false,
    journals: { stale: 2, needingRollback: 0, staleAfterDays: 7 },
  };
  const setHealthStatus = (next: HealthStatus): HealthStatus => {
    healthStatus = next;
    for (const listener of healthListeners) listener(next);
    return next;
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
      memory: async (): Promise<MemorySnapshot> => ({
        totalBytes: MOCK_SPEC.memory.totalBytes,
        availableBytes: 14_400_000_000,
        usedBytes: MOCK_SPEC.memory.totalBytes - 14_400_000_000,
        usedPercent: 58,
        pressure: 'optimal',
        sampledAt: new Date().toISOString(),
      }),
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
      serviceDependencies: async (presetId: string) => {
        const plan = compile(presetId);
        const actions: ServiceDependencyAction[] = [];
        for (const step of plan.steps) {
          if (step.action.kind === 'service') actions.push(step.action);
        }
        return buildServiceDependencyGraph(MOCK_SERVICE_REGISTRY, actions);
      },
      openFolder: async () => undefined,
    },

    market: {
      status: async () => marketStatus,
      install: async () => {
        throw new Error('The marketplace is unavailable in the browser preview.');
      },
      setConsent: async (consent: boolean) => {
        marketStatus = { ...marketStatus, telemetry: { ...marketStatus.telemetry, consent } };
        return marketStatus;
      },
    },

    safety: {
      preflight: async () => preflight,
    },

    health: {
      status: async () => healthStatus,
      check: async () => setHealthStatus({ ...healthStatus, lastCheckAt: new Date().toISOString() }),
      acknowledge: async () =>
        setHealthStatus({
          ...healthStatus,
          signals: [],
          baselineCapturedAt: new Date().toISOString(),
          error: null,
        }),
      pin: async (presetId: string | null) => {
        if (presetId === null) {
          return setHealthStatus({ ...healthStatus, pinnedPresetId: null, pinnedPreset: null, pinnedPresetMissing: false });
        }
        const selected = presets.find((preset) => preset.id === presetId);
        if (selected === undefined) throw new Error(`Preset "${presetId}" is not installed.`);
        return setHealthStatus({
          ...healthStatus,
          pinnedPresetId: selected.id,
          pinnedPreset: { id: selected.id, name: selected.name, version: selected.version },
          pinnedPresetMissing: false,
        });
      },
      flushJournals: async (): Promise<HealthFlushResult> => {
        const flushed = healthStatus.journals.stale > 0 ? ['preview-stale-session'] : [];
        setHealthStatus({ ...healthStatus, journals: { ...healthStatus.journals, stale: 0 } });
        return {
          flushed,
          kept: [],
          message: flushed.length === 0 ? 'No stale journals were old enough to remove.' : 'Removed 1 stale journal(s) (preview only).',
        };
      },
      onStatus: (listener) => {
        healthListeners.add(listener);
        return () => {
          healthListeners.delete(listener);
        };
      },
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

        if (plan.risk === 'aggressive') {
          const started = Date.now();
          setPostApplyStatus({
            phase: 'monitoring',
            active: true,
            sessionId: session.id,
            presetId: plan.presetId,
            presetName: plan.presetName,
            startedAt: new Date(started).toISOString(),
            endsAt: new Date(started + 5 * 60_000).toISOString(),
            remainingMs: 5 * 60_000,
            sampleCount: 1,
            sample: {
              at: new Date(started).toISOString(),
              cpuTempC: 64,
              gpuTempC: 61,
              cpuTempSource: 'libre-hardware-monitor',
              gpuTempSource: 'nvidia-smi',
              dpcPercent: 0.9,
              dpcSource: 'cim-perf-counter',
            },
            trip: null,
            rollback: null,
            message: 'Preview only: stability monitoring is simulated and will not trip.',
          });
        } else {
          setPostApplyStatus(idlePostApplyStatus());
        }

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
        setPostApplyStatus(idlePostApplyStatus());
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
        setPostApplyStatus(idlePostApplyStatus());
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
      postApply: async () => postApplyStatus,
      onPostApply: (listener) => {
        postApplyListeners.add(listener);
        return () => {
          postApplyListeners.delete(listener);
        };
      },
    },

    game: {
      status: async () => gameStatus,
      setWatching: async (enabled: boolean) =>
        setGameStatus({ ...gameStatus, watching: enabled, watcherHealthy: false }),
      profiles: async () => gameSummaries,
      libraries: async () => libraryScan,
      artwork: async (items: ArtworkRequestItem[]) => ({
        configured: true,
        message: null,
        items: items.map((item) => mockArtwork(item.key, item.title)),
      }),
      openFolder: async () => undefined,
      launch: async (gameId: string) => {
        const target = libraryScan.games.find((entry) => entry.id === gameId);
        if (target === undefined) throw new Error('That game is not in the preview library.');
        if (target.executablePath === null) throw new Error('No executable was detected for this preview title.');
        setGameStatus({ ...gameStatus, watching: true });
        return {
          gameId,
          launched: true,
          watching: true,
          executablePath: target.executablePath,
          message: `Preview only: ${target.name} was not started. Game mode is armed.`,
        };
      },
      stop: async () => setGameStatus({ ...gameStatus, active: null, phase: 'idle' }),
      osd: async () => osdStatus(),
      setOsd: async (enabled: boolean) => {
        osdEnabled = enabled;
        return osdStatus();
      },
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
