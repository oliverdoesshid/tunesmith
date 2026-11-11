/**
 * Read-only stability probes for the post-apply watchdog.
 *
 * Temperature comes from the same LibreHardwareMonitor/OpenHardwareMonitor/nvidia-smi
 * sources as game guards. DPC pressure comes from the locale-independent Windows CIM
 * performance class; `% DPC Time` is kernel DPC share, not a microsecond latency
 * measurement, and the UI labels it accordingly.
 */
import type { CpuTempSource, GpuTempSource, TelemetrySample } from '../../shared/game/types';
import type { PostApplyProbeSample } from '../../shared/post-apply';
import { asArray, runPowerShellJson } from './powershell';
import { readTelemetry } from './game/telemetry';

interface RawDpcResult {
  available?: boolean;
  dpcPercent?: unknown;
}

async function readDpcPercent(): Promise<number | null> {
  const script = [
    '$row = @(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -ErrorAction Stop | Where-Object { $_.Name -eq \'_Total\' } | Select-Object -First 1);',
    'if ($row.Count -eq 0) {',
    '  [pscustomobject]@{ available = $false } | ConvertTo-Json -Compress;',
    '  return;',
    '}',
    "[pscustomobject]@{ available = $true; dpcPercent = [double]$row[0].PercentDPCTime } | ConvertTo-Json -Compress;",
  ].join('\n');

  try {
    const result = await runPowerShellJson<RawDpcResult>(script, { timeoutMs: 15_000 });
    if (result.available !== true) return null;
    const value = Number(result.dpcPercent);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  } catch {
    return null;
  }
}

async function readTemperatures(): Promise<TelemetrySample | null> {
  try {
    return await readTelemetry();
  } catch {
    return null;
  }
}

/** One bounded sample. It never throws: a failed sensor becomes an explicit null. */
export async function probePostApplyStability(): Promise<PostApplyProbeSample> {
  const [telemetry, dpcPercent] = await Promise.all([readTemperatures(), readDpcPercent()]);
  const cpuTempC = telemetry?.cpuTempC ?? null;
  const gpuTempC = telemetry?.gpuTempC ?? null;
  const cpuTempSource: CpuTempSource = telemetry?.cpuTempSource ?? 'none';
  const gpuTempSource: GpuTempSource = telemetry?.gpuTempSource ?? 'none';

  return {
    at: new Date().toISOString(),
    cpuTempC,
    gpuTempC,
    cpuTempSource,
    gpuTempSource,
    dpcPercent,
    dpcSource: dpcPercent === null ? 'unavailable' : 'cim-perf-counter',
  };
}

/** Exported for tests and for a future probe palette. */
export function parseDpcResult(raw: unknown): { available: boolean; dpcPercent?: number } {
  const values = asArray(raw as RawDpcResult | RawDpcResult[] | null);
  const first = values[0];
  if (first === undefined || first.available !== true) return { available: false };
  const value = Number(first.dpcPercent);
  if (!Number.isFinite(value) || value < 0 || value > 100) return { available: false };
  return { available: true, dpcPercent: value };
}
