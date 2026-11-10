/**
 * Hardware detection.
 *
 * One PowerShell/CIM round trip collects everything, then all interpretation happens in
 * TypeScript so it can be unit tested without Windows.
 *
 * Why the CIM queries look the way they do:
 *  - `MSFT_PhysicalDisk.MediaType` is the only reliable SSD/HDD signal. `Win32_DiskDrive`
 *    reports "Fixed hard disk media" for both, and `Get-PhysicalDisk` needs the Storage
 *    module to be present, whereas the CIM class does not.
 *  - `Win32_VideoController.AdapterRAM` is a 32-bit field, so it clamps at ~4 GiB
 *    (observed on the reference machine: a 12 GiB card reports 4,293,918,720 bytes).
 *    The driver key's `HardwareInformation.qwMemorySize` is authoritative; WMI is only
 *    a fallback and says so in `vramSource`.
 *  - `$ErrorActionPreference = 'Stop'` per section, wrapped in `TryGet`, so one broken
 *    provider cannot take the whole report down.
 */
import type { CpuInfo, DriveType, GpuInfo, HardwareSpec, MemoryInfo, StorageDevice, StorageInfo } from '../../shared/types';
import { canonicalizeCpu, canonicalizeGpu, bucketRamGb, buildSignature, SIGNATURE_VERSION } from '../../shared/signature';
import { TuneSmithError } from '../../shared/errors';
import { asArray, runPowerShellJson } from './powershell';
import { listDisplayAdapters } from './display-adapters';

interface RawCpu {
  Name?: string;
  Manufacturer?: string;
  NumberOfCores?: number;
  NumberOfLogicalProcessors?: number;
  MaxClockSpeed?: number;
}

interface RawOs {
  Caption?: string;
  BuildNumber?: string;
  OSArchitecture?: string;
}

interface RawGpu {
  Name?: string;
  AdapterRAM?: number;
  DriverVersion?: string;
  PNPDeviceID?: string;
}

interface RawModule {
  Capacity?: number | string;
  Speed?: number;
}

interface RawDisk {
  DeviceId?: string;
  FriendlyName?: string;
  MediaType?: number;
  BusType?: number;
  Size?: number | string;
}

interface RawPartition {
  DriveLetter?: string | null;
  DiskNumber?: number;
}

interface RawVram {
  description?: string;
  vramBytes?: number | string;
  matchingDeviceId?: string;
}

interface RawSnapshot {
  /** Populated by `detectHardware` when the driver-key VRAM read fails, so the reason
   *  survives into `warnings` instead of vanishing into a silent fallback. */
  vramReadError?: string;
  systemDrive?: string;
  cpu?: RawCpu | null;
  os?: RawOs | null;
  totalPhysicalMemory?: number | string | null;
  memoryModules?: RawModule[] | RawModule | null;
  gpus?: RawGpu[] | RawGpu | null;
  disks?: RawDisk[] | RawDisk | null;
  partitions?: RawPartition[] | RawPartition | null;
  vram?: RawVram[] | RawVram | null;
}

const SNAPSHOT_SCRIPT = String.raw`
function TryGet([scriptblock]$sb) { try { & $sb } catch { $null } }

$cpu = TryGet { Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Select-Object -First 1 -Property Name, Manufacturer, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed }
$os = TryGet { Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop | Select-Object -First 1 -Property Caption, BuildNumber, OSArchitecture }
$cs = TryGet { Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop | Select-Object -First 1 -Property TotalPhysicalMemory }
$modules = TryGet { @(Get-CimInstance -ClassName Win32_PhysicalMemory -ErrorAction Stop | Select-Object -Property Capacity, Speed) }
$gpus = TryGet { @(Get-CimInstance -ClassName Win32_VideoController -ErrorAction Stop | Select-Object -Property Name, AdapterRAM, DriverVersion, PNPDeviceID) }
$disks = TryGet { @(Get-CimInstance -Namespace 'root/microsoft/windows/storage' -ClassName MSFT_PhysicalDisk -ErrorAction Stop | Select-Object -Property DeviceId, FriendlyName, MediaType, BusType, Size) }
$partitions = TryGet { @(Get-CimInstance -Namespace 'root/microsoft/windows/storage' -ClassName MSFT_Partition -ErrorAction Stop | Select-Object -Property DriveLetter, DiskNumber) }
[pscustomobject]@{
  systemDrive         = ($env:SystemDrive -replace ':', '')
  cpu                 = $cpu
  os                  = $os
  totalPhysicalMemory = $cs.TotalPhysicalMemory
  memoryModules       = $modules
  gpus                = $gpus
  disks               = $disks
  partitions          = $partitions
} | ConvertTo-Json -Depth 5 -Compress
`;

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const BUS_TYPES: Record<number, string> = {
  3: 'ATA',
  7: 'USB',
  8: 'RAID',
  10: 'SAS',
  11: 'SATA',
  14: 'Virtual',
  16: 'Storage Spaces',
  17: 'NVMe',
  18: 'SCM',
  19: 'UFS',
};

const MEDIA_TYPES: Record<number, DriveType> = { 3: 'HDD', 4: 'SSD', 5: 'SSD' };

function mapBusType(busType: number | undefined): string {
  if (busType === undefined) return 'Unknown';
  return BUS_TYPES[busType] ?? `Bus ${busType}`;
}

function mapMediaType(mediaType: number | undefined, busType: number | undefined): DriveType {
  if (mediaType !== undefined && MEDIA_TYPES[mediaType] !== undefined) {
    return MEDIA_TYPES[mediaType] as DriveType;
  }
  // MediaType 0 = "Unspecified". NVMe is flash by definition, so we can still be certain.
  if (busType === 17) return 'SSD';
  return 'UNKNOWN';
}

/** Match a display driver registry key to a WMI adapter. */
function findVramBytes(gpu: RawGpu, vramEntries: RawVram[]): { bytes: number | null; source: 'registry' | 'none' } {
  const nameKey = normKey(gpu.Name ?? '');
  const pnp = normKey(gpu.PNPDeviceID ?? '');

  const candidates: { bytes: number; descKey: string; deviceKey: string }[] = [];
  for (const entry of vramEntries) {
    const bytes = num(entry.vramBytes);
    if (bytes === null || bytes <= 0) continue;
    candidates.push({
      bytes,
      descKey: normKey(entry.description ?? ''),
      deviceKey: normKey(entry.matchingDeviceId ?? ''),
    });
  }

  // Exact PNP id match is the strongest signal: the description is marketing text and
  // varies by driver version ("NVIDIA GeForce RTX 3060" vs "... 3060 (LHR)").
  if (pnp.length > 0) {
    const byPnp = candidates.find((c) => c.deviceKey.length > 4 && pnp.includes(c.deviceKey));
    if (byPnp) return { bytes: byPnp.bytes, source: 'registry' };
  }

  if (nameKey.length > 0) {
    const exact = candidates.find((c) => c.descKey === nameKey);
    if (exact) return { bytes: exact.bytes, source: 'registry' };

    // Containment fallback, longest description first so "RTX 3060" does not win over
    // "RTX 3060 Ti" when both keys exist for a multi-GPU machine.
    const scored = candidates
      .filter((c) => c.descKey.length >= 8 && (c.descKey.includes(nameKey) || nameKey.includes(c.descKey)))
      .sort((a, b) => b.descKey.length - a.descKey.length);
    if (scored[0]) return { bytes: scored[0].bytes, source: 'registry' };
  }

  return { bytes: null, source: 'none' };
}

export function buildCpu(raw: RawCpu, warnings: string[]): CpuInfo {
  const name = (raw.Name ?? '').trim();
  if (name.length === 0) {
    throw new TuneSmithError('not-supported', 'CPU information is unavailable (Win32_Processor returned nothing).');
  }
  const canonical = canonicalizeCpu(raw.Manufacturer ?? '', name);
  if (canonical.vendor === 'Unknown') warnings.push('Unrecognised CPU vendor; signature may not match community presets.');

  return {
    vendor: canonical.vendor,
    rawName: name,
    model: canonical.model,
    token: canonical.token,
    cores: num(raw.NumberOfCores) ?? 0,
    threads: num(raw.NumberOfLogicalProcessors) ?? 0,
    maxClockMhz: num(raw.MaxClockSpeed),
  };
}

export function buildGpus(rawGpus: RawGpu[], vramEntries: RawVram[], warnings: string[]): GpuInfo[] {
  return rawGpus
    .filter((raw) => (raw.Name ?? '').trim().length > 0)
    .map((raw) => {
      const rawName = (raw.Name ?? '').trim();
      const canonical = canonicalizeGpu(rawName);
      const fromRegistry = findVramBytes(raw, vramEntries);
      const adapterRam = num(raw.AdapterRAM);

      let vramBytes: number | null = fromRegistry.bytes;
      let vramSource: GpuInfo['vramSource'] = fromRegistry.source;

      if (vramBytes === null && adapterRam !== null && adapterRam > 0 && canonical.kind !== 'virtual') {
        // AdapterRAM is uint32 and clamps at ~4 GiB. Good enough to distinguish
        // integrated from discrete, not good enough to report to the user as fact.
        vramBytes = adapterRam;
        vramSource = 'wmi';
        warnings.push(`VRAM for ${rawName} came from WMI, which clamps at 4 GiB; treat it as a lower bound.`);
      }

      return {
        vendor: canonical.vendor,
        rawName,
        model: canonical.model,
        token: canonical.token,
        vramBytes,
        vramGb: vramBytes === null ? null : Math.round((vramBytes / 1024 ** 3) * 10) / 10,
        driverVersion: (raw.DriverVersion ?? '').trim() || null,
        kind: canonical.kind,
        vramSource,
      };
    });
}

/** Prefer the most capable discrete adapter: virtual monitors and iGPUs sort below it. */
export function pickPrimaryGpu(gpus: GpuInfo[]): GpuInfo | null {
  const discrete = gpus.filter((g) => g.kind === 'discrete').sort((a, b) => (b.vramGb ?? 0) - (a.vramGb ?? 0));
  if (discrete[0]) return discrete[0];
  const integrated = gpus.filter((g) => g.kind === 'integrated').sort((a, b) => (b.vramGb ?? 0) - (a.vramGb ?? 0));
  return integrated[0] ?? null;
}

export function buildMemory(raw: RawSnapshot, warnings: string[]): MemoryInfo {
  const modules = asArray(raw.memoryModules);
  const moduleBytes = modules.reduce((sum, m) => sum + (num(m.Capacity) ?? 0), 0);
  const totalBytes = num(raw.totalPhysicalMemory) ?? moduleBytes;

  if (totalBytes <= 0) {
    warnings.push('Total physical memory could not be determined.');
  }

  const totalGb = Math.round((totalBytes / 1024 ** 3) * 10) / 10;
  const speeds = modules.map((m) => num(m.Speed)).filter((s): s is number => s !== null && s > 0);

  return {
    totalBytes,
    totalGb,
    bucketGb: bucketRamGb(totalGb),
    speedMhz: speeds.length > 0 ? Math.max(...speeds) : null,
    moduleCount: modules.length > 0 ? modules.length : null,
  };
}

export function buildStorage(raw: RawSnapshot, warnings: string[]): StorageInfo {
  const systemDriveLetter = (raw.systemDrive ?? 'C').toUpperCase();
  const partitions = asArray(raw.partitions);
  const rawDisks = asArray(raw.disks);

  const systemPartition = partitions.find((p) => (p.DriveLetter ?? '').toUpperCase() === systemDriveLetter);
  const systemDiskNumber = num(systemPartition?.DiskNumber);

  const devices: StorageDevice[] = rawDisks.map((disk) => {
    const index = num(disk.DeviceId) ?? -1;
    return {
      index,
      model: (disk.FriendlyName ?? '').trim() || `Disk ${index}`,
      mediaType: mapMediaType(disk.MediaType, disk.BusType),
      bus: mapBusType(disk.BusType),
      sizeGb: Math.round(((num(disk.Size) ?? 0) / 1024 ** 3) * 10) / 10,
      isSystem: systemDiskNumber !== null && index === systemDiskNumber,
    };
  });

  const primary = devices.find((d) => d.isSystem) ?? null;
  if (primary === null) {
    warnings.push(`Could not identify the physical disk hosting ${systemDriveLetter}:.`);
  } else if (primary.mediaType === 'UNKNOWN') {
    warnings.push('System drive media type is unspecified; the signature will read UNKNOWN.');
  }

  return { primary, devices };
}

/** Pure interpretation step, exported for tests. */
export function interpretSnapshot(raw: RawSnapshot): HardwareSpec {
  const warnings: string[] = [];

  if (raw.cpu === null || raw.cpu === undefined) {
    throw new TuneSmithError('not-supported', 'CPU information is unavailable (Win32_Processor returned nothing).');
  }

  const cpu = buildCpu(raw.cpu, warnings);
  const gpus = buildGpus(asArray(raw.gpus), asArray(raw.vram), warnings);
  const primaryGpu = pickPrimaryGpu(gpus);

  if (primaryGpu === null) warnings.push('No usable GPU was detected; signature uses NOGPU.');
  const virtualCount = gpus.filter((g) => g.kind === 'virtual').length;
  if (virtualCount > 0) warnings.push(`${virtualCount} virtual display adapter(s) ignored for the signature.`);

  if (raw.vramReadError !== undefined) {
    const usedFallback = gpus.some((g) => g.vramSource === 'wmi');
    warnings.push(
      usedFallback
        ? `Driver-key VRAM read failed (${raw.vramReadError}); VRAM fell back to the clamped WMI value.`
        : `Driver-key VRAM read failed (${raw.vramReadError}).`,
    );
  }

  const memory = buildMemory(raw, warnings);
  const storage = buildStorage(raw, warnings);

  const buildNumber = Number.parseInt(String(raw.os?.BuildNumber ?? '0'), 10);
  const os = {
    caption: (raw.os?.Caption ?? 'Windows').trim(),
    build: Number.isFinite(buildNumber) ? buildNumber : 0,
    arch: (raw.os?.OSArchitecture ?? 'Unknown').trim(),
    isWindows11: buildNumber >= 22000,
  };

  const driveType: DriveType = storage.primary?.mediaType ?? 'UNKNOWN';
  const signature = buildSignature({
    cpuToken: cpu.token,
    gpuToken: primaryGpu?.token ?? null,
    ramBucketGb: memory.bucketGb,
    driveType,
  });

  return {
    schemaVersion: 1,
    signatureVersion: SIGNATURE_VERSION,
    cpu,
    primaryGpu,
    gpus,
    memory,
    storage,
    os,
    signature,
    detectedAt: new Date().toISOString(),
    warnings,
  };
}

export async function detectHardware(): Promise<HardwareSpec> {
  if (process.platform !== 'win32') {
    throw new TuneSmithError('not-supported', 'TuneSmith only supports Windows.');
  }
  const raw = await runPowerShellJson<RawSnapshot>(SNAPSHOT_SCRIPT, { timeoutMs: 45_000 });

  // VRAM comes from a dedicated reg.exe read: a broken PowerShell pipeline is silent,
  // whereas a failed `reg query` returns a code we can fall back from (to WMI, which
  // then records `vramSource: 'wmi'` and warns that the value is a lower bound).
  try {
    const adapters = await listDisplayAdapters();
    if (adapters.length > 0) {
      raw.vram = adapters.map((adapter) => ({
        description: adapter.description,
        vramBytes: adapter.vramBytes ?? undefined,
        matchingDeviceId: adapter.matchingDeviceId ?? undefined,
      }));
    }
  } catch (error) {
    // Keep the WMI fallback, but never lose the reason: a silent catch here is exactly
    // how a detector ends up reporting a clamped 4 GiB card as fact.
    raw.vramReadError = error instanceof Error ? error.message : String(error);
  }

  return interpretSnapshot(raw);
}
