/**
 * Domain types shared by the main process, the preload bridge and the renderer.
 *
 * Nothing in this file may import from `electron`: it is also consumed by the
 * standalone detection CLI and by unit tests that run in plain Node.
 */
import type { PowerPlanId, PowerSettingId } from './power';

export const DRIVE_TYPES = ['SSD', 'HDD', 'UNKNOWN'] as const;
export type DriveType = (typeof DRIVE_TYPES)[number];

export const CPU_VENDORS = ['Intel', 'AMD', 'ARM', 'Unknown'] as const;
export type CpuVendor = (typeof CPU_VENDORS)[number];

export const GPU_VENDORS = ['NVIDIA', 'AMD', 'Intel', 'Microsoft', 'Unknown'] as const;
export type GpuVendor = (typeof GPU_VENDORS)[number];

/** Virtual adapters are recorded but never used for the signature. */
export type GpuKind = 'discrete' | 'integrated' | 'virtual';

export interface CpuInfo {
  vendor: CpuVendor;
  /** Raw WMI name; display only. */
  rawName: string;
  /** Canonical short model, e.g. `i7-14700K` or `Ryzen5_5600X`. */
  model: string;
  /** `Intel_i7-14700K`. This is the CPU segment of the hardware signature. */
  token: string;
  cores: number;
  threads: number;
  maxClockMhz: number | null;
}

export interface GpuInfo {
  vendor: GpuVendor;
  rawName: string;
  model: string;
  /** Model only, e.g. `RTX4070Ti`. Deliberately vendor-free so it matches the documented signature format. */
  token: string;
  vramBytes: number | null;
  vramGb: number | null;
  driverVersion: string | null;
  kind: GpuKind;
  /** Where the VRAM figure came from; WMI's AdapterRAM is clamped at 4 GiB and is only a fallback. */
  vramSource: 'registry' | 'wmi' | 'none';
}

export interface MemoryInfo {
  totalBytes: number;
  totalGb: number;
  /** RAM segment of the signature: the nearest standard capacity tier. */
  bucketGb: number;
  speedMhz: number | null;
  moduleCount: number | null;
}

export interface StorageDevice {
  index: number;
  model: string;
  mediaType: DriveType;
  /** Human-readable bus, e.g. `NVMe`, `SATA`, `USB`. */
  bus: string;
  sizeGb: number;
  isSystem: boolean;
}

export interface StorageInfo {
  primary: StorageDevice | null;
  devices: StorageDevice[];
}

export interface OsInfo {
  caption: string;
  build: number;
  arch: string;
  isWindows11: boolean;
}

export interface HardwareSpec {
  schemaVersion: 1;
  /** Bumped whenever canonicalisation rules change, because presets key off the string. */
  signatureVersion: number;
  cpu: CpuInfo;
  primaryGpu: GpuInfo | null;
  gpus: GpuInfo[];
  memory: MemoryInfo;
  storage: StorageInfo;
  os: OsInfo;
  /** e.g. `AMD_Ryzen5_5600X_RTX3060_32GB_SSD` */
  signature: string;
  detectedAt: string;
  warnings: string[];
}

/* ------------------------------------------------------------------ *
 * Closed action vocabulary
 *
 * Presets are data, never code. Every mutation the engine can perform is
 * represented by one of these shapes, and each maps to a single, fixed,
 * parameterised system call. There is no "run this command" action, and no
 * raw GUIDs, hives or executable paths come from preset files.
 * ------------------------------------------------------------------ */

export const REGISTRY_HIVES = ['HKCU', 'HKLM'] as const;
export type RegistryHive = (typeof REGISTRY_HIVES)[number];

/**
 * REG_MULTI_SZ and REG_BINARY are intentionally not in the vocabulary: their
 * `reg.exe` encodings are ambiguous enough to be a footgun, and no mainstream
 * tuning tweak requires them.
 */
export const REGISTRY_VALUE_TYPES = ['REG_SZ', 'REG_EXPAND_SZ', 'REG_DWORD', 'REG_QWORD'] as const;
export type RegType = (typeof REGISTRY_VALUE_TYPES)[number];
export type RegData = string | number;

export const SERVICE_STARTUP_MODES = ['Automatic', 'Manual', 'Disabled'] as const;
export type ServiceStartupMode = (typeof SERVICE_STARTUP_MODES)[number];

/** `RealTime` is deliberately absent: it can starve input and audio threads. */
export const PRIORITY_CLASSES = ['Idle', 'BelowNormal', 'Normal', 'AboveNormal', 'High'] as const;
export type PriorityClass = (typeof PRIORITY_CLASSES)[number];

export const RISK_LEVELS = ['conservative', 'moderate', 'aggressive'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export type ActionGroupKind = 'registry' | 'service' | 'priority' | 'power';

/** Normalised, validated action as executed by the engine. */
export type PresetAction =
  | { kind: 'registry'; hive: RegistryHive; path: string; name: string; op: 'set'; type: RegType; data: RegData }
  | { kind: 'registry'; hive: RegistryHive; path: string; name: string; op: 'delete' }
  | { kind: 'service'; name: string; startup?: ServiceStartupMode; delayedStart?: boolean; stop?: boolean }
  | { kind: 'priority'; process: string; priority: PriorityClass }
  | { kind: 'power-plan'; plan: PowerPlanId }
  | { kind: 'power-setting'; setting: PowerSettingId; value: number }
  | { kind: 'device-interrupt'; deviceClass: 'gpu' | 'network'; messageLimit?: number }
  | { kind: 'irq-priority'; irq: number; priority: 'high' | 'normal' }
  | { kind: 'network'; tcpAckFrequency?: 0 | 1 | 2; tcpNoDelay?: 0 | 1 };
