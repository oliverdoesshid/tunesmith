/**
 * Per-game performance profiles.
 *
 * Unlike tuning presets, these describe *runtime* behaviour: what to do while a
 * specific game is in the foreground, and what to undo when it leaves. Every field
 * is data; the engine maps it to a fixed, typed operation.
 */
import type { RiskLevel } from '../types';

/** 0-based logical processor indices, as reported by the OS. */
export type CpuMask = number[];

export type AffinityStrategy =
  | 'all-cores'
  | 'physical-cores'
  | 'performance-cores'
  | 'efficiency-cores'
  | 'custom';

export interface AffinityPlan {
  strategy: AffinityStrategy;
  /** Required for `custom`; ignored otherwise. */
  cores?: CpuMask;
  /**
   * Which `EfficiencyClass` value identifies a performance core. Windows documents the
   * field as "higher means more performant", which is the default. A CPU that reports it
   * inverted can be handled without a code change.
   */
  performanceClass?: 'highest' | 'lowest';
}

export type GamePriority = 'Normal' | 'AboveNormal' | 'High';

export type BackgroundAction = 'lower-priority' | 'suspend' | 'eco-mode';

export interface BackgroundRule {
  /** Image name only, e.g. `chrome.exe`. Paths are rejected. */
  process: string;
  action: BackgroundAction;
  /** Priority to apply for `lower-priority`. Never above `BelowNormal`. */
  priority?: 'Idle' | 'BelowNormal';
}

export interface GameProfileActions {
  affinity?: AffinityPlan;
  priority?: GamePriority;
  /** Windows Graphics Settings per-app preference for the game executable. */
  gpuPreference?: 'high-performance' | 'power-saving';
  /**
   * Per-interface TCP latency tuning for the interface carrying an established game
   * server connection. The engine discovers the route at activation and never accepts a
   * preset-supplied adapter or registry path.
   */
  network?: GameNetworkSettings;
  /**
   * Purge the standby list before the game starts. Off by default everywhere, because
   * discarding cached file pages can make a game load *slower*; see docs/GAME-ENGINE.md.
   */
  flushStandbyMemory?: boolean;
  /**
   * Hold the global Windows timer at its 0.5 ms floor while the game runs.
   * Implemented as a crashing-safe holder process (it exits when the app dies),
   * stopped on restore. Raises idle power draw; that is the documented trade.
   */
  timerHold?: boolean;
  backgroundRules?: BackgroundRule[];
}

export interface GameNetworkSettings {
  /** Microsoft's per-interface acknowledgement frequency; 1 disables delayed ACKs. */
  tcpAckFrequency?: 0 | 1 | 2;
  /** 1 disables Nagle-style delaying for the selected interface. */
  tcpNoDelay?: 0 | 1;
  /** Best-effort NIC advanced property; skipped when Windows exposes no such property. */
  interruptModeration?: 'enabled' | 'disabled';
}

export interface GameNetworkEndpoint {
  protocol: 'tcp' | 'udp';
  localAddress: string;
  localPort: number;
  remoteAddress: string | null;
  remotePort: number | null;
}

/** Read-only route discovery result for the game process. */
export interface GameNetworkTarget {
  interfaceGuid: string;
  adapterName: string;
  adapterDescription: string;
  endpoints: GameNetworkEndpoint[];
}

export interface GameNetworkInterfaceState extends GameNetworkTarget {
  tcpAckFrequency: number | null;
  tcpNoDelay: number | null;
}

export interface GameNetworkAdapterState {
  adapterName: string;
  registryKeyword: string;
  previousRegistryValue: string;
  displayName: string;
}

/** Durable game-session snapshot written before any network value is changed. */
export interface GameNetworkSnapshot {
  capturedAt: string;
  interfaces: GameNetworkInterfaceState[];
  interruptModeration?: GameNetworkAdapterState;
}

export interface GameNetworkApplyResult {
  /** True when at least one requested value was applied. */
  ok: boolean;
  tcpInterfaces: number;
  adapter: 'applied' | 'unavailable' | 'not-requested' | 'failed';
  message: string;
}

export type InterruptAffinityDeviceKind = 'gpu' | 'nvme' | 'network';

/** A PCI device whose interrupt affinity the engine may pin. */
export interface GameInterruptAffinityDevice {
  /** Runtime PnP instance id, e.g. `PCI\VEN_10DE&DEV_2504\...`. */
  instanceId: string;
  kind: InterruptAffinityDeviceKind;
  /** Friendly device name for the session log; never used as a path. */
  label: string;
  /** PnP service, e.g. `stornvme`; informational. */
  service: string | null;
}

export type InterruptAffinityValueType = 'REG_DWORD' | 'REG_QWORD' | 'REG_BINARY';

/** Exact prior state of one registry value, captured before the policy is written. */
export interface InterruptAffinityValueState {
  existed: boolean;
  valueType?: InterruptAffinityValueType;
  /** Decimal for DWORD/QWORD, uppercase little-endian hex for BINARY. */
  data?: string;
}

export interface GameInterruptAffinityDeviceState {
  device: GameInterruptAffinityDevice;
  /** `Affinity Policy\DevicePolicy`; only a reported REG_DWORD is accepted. */
  policy: InterruptAffinityValueState;
  /** `Affinity Policy\AssignmentSetOverride`; the prior processor mask. */
  assignment: InterruptAffinityValueState;
}

/** Durable game-session snapshot written before any interrupt policy is changed. */
export interface GameInterruptAffinitySnapshot {
  capturedAt: string;
  /** Hex mask for the selected processors, for the UI/log. */
  mask: string;
  cores: number[];
  devices: GameInterruptAffinityDeviceState[];
}

export interface GameInterruptAffinityApplyResult {
  /** True when at least one device's policy was written. */
  ok: boolean;
  applied: number;
  skipped: number;
  message: string;
}

/**
 * Thermal / power safety guards. A trip ends the session (everything is restored) and
 * suppresses re-activation for `cooldownSeconds`, because re-applying aggressive tuning
 * onto a hot machine is exactly the failure this feature exists to prevent.
 *
 * Thresholds are integers in °C; the engine trips at `>=` the limit.
 */
export interface ThermalGuards {
  maxCpuTempC?: number;
  maxGpuTempC?: number;
  /** `restore` ends the session when the machine switches to battery. */
  onBattery?: 'restore' | 'ignore';
  /** Minimum time before the profile may auto-apply again after a trip. */
  cooldownSeconds?: number;
  /** How often telemetry is read while the session is active. */
  sampleSeconds?: number;
}

export type CpuTempSource =
  | 'libre-hardware-monitor'
  | 'open-hardware-monitor'
  | 'acpi-thermal-zone'
  | 'thermal-zone-counter'
  | 'none';

export type GpuTempSource =
  | 'libre-hardware-monitor'
  | 'open-hardware-monitor'
  | 'nvidia-smi'
  | 'none';

export type PowerSource =
  | 'libre-hardware-monitor'
  | 'open-hardware-monitor'
  | 'battery'
  | 'none';

/** One read-only hardware sample. Any field may be null when the machine cannot supply it. */
export interface TelemetrySample {
  at: string;
  cpuTempC: number | null;
  cpuTempSource: CpuTempSource;
  gpuTempC: number | null;
  gpuTempSource: GpuTempSource;
  powerDrawW: number | null;
  powerSource: PowerSource;
  onAc: boolean | null;
  batteryPercent: number | null;
}

export type GuardTripReason =
  | { kind: 'cpu-temp'; valueC: number; limitC: number }
  | { kind: 'gpu-temp'; valueC: number; limitC: number }
  | { kind: 'on-battery'; batteryPercent: number | null };

export type GuardOutcome =
  /** `missing` lists configured inputs that could not be read; the rest were enforced. */
  | { status: 'ok'; checked: string[]; missing: string[] }
  | { status: 'trip'; reason: GuardTripReason; message: string }
  /** The guard could not be enforced because a configured signal was unavailable. */
  | { status: 'unavailable'; missing: string[]; message: string };

export interface GameTrigger {
  /**
   * Image name, matched case-insensitively. Optional: a packaged title can be targeted
   * by `packageFamilyName` alone. At least one of the two is required (schema-enforced).
   */
  exe?: string;
  /**
   * Microsoft Store / UWP package family name, e.g.
   * `Microsoft.SunriseBaseGame_8wekyb3d8bbwe`. AppContainer install paths are virtualised,
   * but the family name reported by `GetPackageFamilyName` is not.
   */
  packageFamilyName?: string;
  /** Optional glob (single `*`) matched against the window title. */
  titlePattern?: string;
  /** Optional install root, e.g. `D:\SteamLibrary`. Compared case-insensitively. */
  pathPrefix?: string;
}

export interface GameProfile {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  authors: { handle: string }[];
  license: string;
  risk: RiskLevel;
  trigger: GameTrigger;
  actions: GameProfileActions;
  /** Optional thermal / AC-power safety limits for this title. */
  guards?: ThermalGuards;
  notes?: string[];
}

/**
 * One Windows processor group. A group holds at most 64 logical processors; systems
 * above that (Threadripper PRO, multi-socket) are split into several groups and a
 * process's threads must be pinned per group (`SetThreadGroupAffinity`).
 */
export interface ProcessorGroup {
  /** Windows group number, 0-based. */
  index: number;
  /** Logical processors in this group (<= 64). */
  count: number;
  /** Active processors in this group as a hex mask, e.g. `0xFFFFFFFFFFFFFFFF`. */
  mask: string;
}

/** Logical-processor topology, normalised so that a higher class means faster. */
export interface CpuTopology {
  /** Total across every group (not per group), so indices stay unambiguous. */
  logicalProcessors: number;
  physicalCores: number;
  hybrid: boolean;
  /** One entry per logical processor: higher = more performant. Indexed globally. */
  efficiencyClasses: number[];
  /** Physical core identity per logical processor; SMT siblings share a value. */
  coreIndices: number[];
  source: 'cpuset' | 'synthetic';
  /** True when the class ordering is the documented Windows one. */
  higherEfficiencyIsFaster: boolean;
  /** Processor groups present on the machine. Absent means a single implicit group. */
  groups?: ProcessorGroup[];
  /** Total logical processors across all groups; equals `logicalProcessors`. */
  totalLogicalProcessors?: number;
}

export interface AffinityGroupMask {
  /** Windows processor group number. */
  index: number;
  /** Hex mask of the selected processors *within that group*. */
  mask: string;
}

export interface AffinitySelection {
  /** Group-0 mask, kept for single-group callers and the journal. */
  mask: bigint;
  cores: number[];
  reason: string;
  /** One entry per touched group; length 1 on a normal desktop. */
  groups: AffinityGroupMask[];
}

/** A resolved Microsoft Store package (read-only; nothing here is mutated). */
export interface GamePackageInfo {
  familyName: string;
  installLocation: string | null;
  /** Image names the package launches, so the watcher can watch them. */
  executables: string[];
  /** AppContainer capabilities declared in the manifest (informational). */
  capabilities: string[];
  /** `Store`, `Developer`, `System`… when Windows reports it. */
  signatureKind: string | null;
}

export type GamePhase = 'idle' | 'launching' | 'active' | 'restoring' | 'error';

export type AdjustmentKind =
  | 'package'
  | 'thermal-guard'
  | 'adaptation'
  | 'affinity'
  | 'priority'
  | 'gpu-preference'
  | 'network'
  | 'interrupt-affinity'
  | 'memory-flush'
  | 'background-priority'
  | 'background-suspend'
  | 'background-eco'
  | 'timer-resolution';

export interface AppliedAdjustment {
  kind: AdjustmentKind;
  target: string;
  detail: string;
  ok: boolean;
  error?: string;
}

export interface SuspendedProcess {
  pid: number;
  process: string;
  /** True when the automatic Cryo-Freeze layer, not a profile rule, suspended it. */
  cryoFreeze?: boolean;
}

export interface GameSessionView {
  id: string;
  profileId: string;
  profileName: string;
  exe: string;
  pid: number | null;
  startedAt: string;
  endedAt?: string;
  phase: GamePhase;
  adjustments: AppliedAdjustment[];
  suspended: SuspendedProcess[];
  restoredAt?: string;
  /** Set when restore could not complete before the app was closed. */
  interrupted?: boolean;
}

export interface GameStatus {
  watching: boolean;
  /** Automatic background suspension is armed for the next game session. */
  cryoFreeze: boolean;
  /** Device interrupt-affinity staging is armed for the next game session. */
  interruptAffinity: boolean;
  phase: GamePhase;
  watcherHealthy: boolean;
  active: GameSessionView | null;
  /** Present when the last session could not be fully restored. */
  pendingRestore: GameSessionView | null;
  lastError: string | null;
  topology: CpuTopology | null;
  /** Packages resolved from the loaded profiles (Store / UWP titles). */
  packages: GamePackageInfo[];
  /** Last telemetry sample read while a guarded session was active. */
  telemetry: TelemetrySample | null;
  /** Result of the most recent guard evaluation. */
  guard: GuardOutcome | null;
  profiles: number;
  pollMs: number;
}

export type GameLibrarySource = 'steam' | 'epic' | 'xbox' | 'gog' | 'manual';
export type GamePathPickKind = 'folder' | 'executable';

/** A native-picker result. The token is the only thing the renderer may submit back. */
export interface PickedGamePath {
  token: string;
  path: string;
  kind: GamePathPickKind;
}

/** A local title the automatic launcher scan could not discover. */
export interface ManualGameInput {
  name: string;
  installDir: string;
  executablePath: string;
}

/** Renderer request: paths are redeemed from short-lived native-picker tokens in main. */
export interface ManualGameAddRequest {
  name: string;
  installDirToken: string;
  executableToken: string;
}

export interface DiscoveredExecutable {
  /** Bare image name, e.g. `Cyberpunk2077.exe`. */
  name: string;
  /** Absolute path inside the install directory. */
  path: string;
}

/** One installed title found by the library scanner or added manually. */
export interface DiscoveredGame {
  /** Stable per-source key, e.g. `steam:1091500`. */
  id: string;
  name: string;
  source: GameLibrarySource;
  appId: string | null;
  installDir: string;
  /** Best candidates, ranked; may be empty when no executable could be identified. */
  executables: DiscoveredExecutable[];
  executablePath: string | null;
  packageFamilyName: string | null;
  /** Profiles installed locally whose trigger matches this title. */
  profileIds: string[];
}

export interface GameLibraryScanResult {
  scannedAt: string;
  games: DiscoveredGame[];
  errors: { source: GameLibrarySource | 'library'; message: string }[];
}

/** Outcome of a quick-launch request from the library grid. */
export interface GameLaunchResult {
  gameId: string;
  /** False when Windows refused to start the executable; `message` explains why. */
  launched: boolean;
  /** Whether the profile watcher is armed after the attempt. */
  watching: boolean;
  executablePath: string | null;
  message: string;
}

/** Renderer-facing summary of one game profile, already policy-evaluated. */
export interface GameProfileSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  risk: RiskLevel;
  /** Empty when the profile targets a package family name only. */
  exe: string;
  packageFamilyName: string | null;
  /** True when policy refuses to run it on this machine. */
  blocked: boolean;
  findings: string[];
  /** Human-readable list such as "Affinity: performance cores". */
  actions: string[];
  notes: string[];
  /** True when a matching title was found in a local game library. */
  installed: boolean;
  /** Executable or install directory that matched, when `installed` is true. */
  detectedPath: string | null;
}
