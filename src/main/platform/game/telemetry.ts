/**
 * Hardware telemetry adapter.
 *
 * The PowerShell side returns every source it could read; selection happens here so the
 * preference order is unit-tested. Ordering is deliberate:
 *
 *   CPU:  LibreHardwareMonitor → OpenHardwareMonitor → ACPI zone → thermal-zone counter
 *   GPU:  LibreHardwareMonitor → OpenHardwareMonitor → nvidia-smi
 *   Power: LibreHardwareMonitor → OpenHardwareMonitor → battery discharge (on battery only)
 *
 * Hardware monitors win because they report a real package sensor; ACPI zones are a
 * chassis reading and many desktops have none. `nvidia-smi` is vendor-specific, so it is
 * the last GPU fallback rather than the only option.
 *
 * Everything is read-only and every number is treated as untrusted: a mis-reported thermal
 * zone must not be able to end a game session.
 */
import { describeError, TuneSmithError } from '../../../shared/errors';
import type { CpuTempSource, GpuTempSource, PowerSource, TelemetrySample } from '../../../shared/game/types';
import { runPowerShellJson } from '../powershell';
import { TELEMETRY_SCRIPT } from './scripts';

export interface RawMonitorSnapshot {
  cpuTempC?: number | string | null;
  gpuTempC?: number | string | null;
  powerDrawW?: number | string | null;
}

/** PowerShell's JSON is untrusted: numbers normally arrive as numbers, but strings are tolerated. */
export interface RawTelemetry {
  onAc?: boolean | null;
  batteryPercent?: number | string | null;
  lhm?: RawMonitorSnapshot | null;
  ohm?: RawMonitorSnapshot | null;
  acpiCpuTempC?: number | string | null;
  counterCpuTempC?: number | string | null;
  nvidiaGpuTempC?: number | string | null;
  batteryPowerW?: number | string | null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function temperature(value: unknown): number | null {
  const parsed = toNumber(value);
  if (parsed === null || parsed < -40 || parsed > 150) return null;
  return Math.round(parsed * 10) / 10;
}

function watts(value: unknown): number | null {
  const parsed = toNumber(value);
  if (parsed === null || parsed <= 0 || parsed > 1500) return null;
  return Math.round(parsed * 10) / 10;
}

function pick<T extends string>(
  candidates: readonly (readonly [T, unknown])[],
  parse: (value: unknown) => number | null,
): { source: T | 'none'; value: number | null } {
  for (const [source, raw] of candidates) {
    const value = parse(raw);
    if (value !== null) return { source, value };
  }
  return { source: 'none', value: null };
}

/** Exported for tests: merges every source and clamps the result. */
export function normaliseTelemetry(raw: RawTelemetry, at = new Date().toISOString()): TelemetrySample {
  const onAc = raw.onAc === true ? true : raw.onAc === false ? false : null;

  const cpu = pick<Exclude<CpuTempSource, 'none'>>([
    ['libre-hardware-monitor', raw.lhm?.cpuTempC],
    ['open-hardware-monitor', raw.ohm?.cpuTempC],
    ['acpi-thermal-zone', raw.acpiCpuTempC],
    ['thermal-zone-counter', raw.counterCpuTempC],
  ], temperature);

  const gpu = pick<Exclude<GpuTempSource, 'none'>>([
    ['libre-hardware-monitor', raw.lhm?.gpuTempC],
    ['open-hardware-monitor', raw.ohm?.gpuTempC],
    ['nvidia-smi', raw.nvidiaGpuTempC],
  ], temperature);

  const monitorPower = pick<Exclude<PowerSource, 'none' | 'battery'>>(
    [
      ['libre-hardware-monitor', raw.lhm?.powerDrawW],
      ['open-hardware-monitor', raw.ohm?.powerDrawW],
    ],
    watts,
  );
  let powerDrawW: number | null = monitorPower.value;
  let powerSource: PowerSource = monitorPower.source;
  if (powerSource === 'none' && onAc === false) {
    const batteryWatt = watts(raw.batteryPowerW);
    if (batteryWatt !== null) {
      powerDrawW = batteryWatt;
      powerSource = 'battery';
    }
  }

  const battery = toNumber(raw.batteryPercent);

  return {
    at,
    cpuTempC: cpu.value,
    cpuTempSource: cpu.source === 'none' ? 'none' : cpu.source,
    gpuTempC: gpu.value,
    gpuTempSource: gpu.source === 'none' ? 'none' : gpu.source,
    powerDrawW,
    powerSource,
    onAc,
    batteryPercent: battery !== null && battery >= 0 && battery <= 100 ? Math.round(battery) : null,
  };
}

export async function readTelemetry(): Promise<TelemetrySample> {
  let raw: RawTelemetry;
  try {
    raw = await runPowerShellJson<RawTelemetry>(TELEMETRY_SCRIPT, { timeoutMs: 30_000 });
  } catch (error) {
    throw new TuneSmithError(
      'capture-failed',
      'Could not read hardware telemetry',
      error instanceof TuneSmithError ? error.detail : describeError(error),
    );
  }
  return normaliseTelemetry(raw);
}
