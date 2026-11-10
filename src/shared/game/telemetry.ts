/**
 * Thermal guard evaluation. Pure, and deliberately fail-open but loud.
 *
 * A guard that cannot read the sensor it needs must not silently *pass* (that would claim
 * protection the machine does not have) and must not silently *trip* (that would end every
 * session on a laptop whose ACPI zone is missing). The third state — `unavailable` — is
 * surfaced once per session instead.
 *
 * Trips are `>=` the limit: 85 °C with a limit of 85 trips.
 */
import type { GuardOutcome, TelemetrySample, ThermalGuards } from './types';

export const GUARD_DEFAULTS = {
  cooldownSeconds: 120,
  sampleSeconds: 10,
} as const;

/** True when at least one condition is configured. */
export function hasGuards(guards: ThermalGuards | undefined): boolean {
  if (guards === undefined) return false;
  return (
    guards.maxCpuTempC !== undefined ||
    guards.maxGpuTempC !== undefined ||
    guards.onBattery === 'restore'
  );
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Evaluate every configured condition against one sample.
 *
 * Order of precedence: a real trip wins over a missing signal, so a machine that reports
 * a 95 °C CPU but no GPU sensor still gets restored rather than excused.
 */
export function evaluateGuards(guards: ThermalGuards | undefined, sample: TelemetrySample | null): GuardOutcome {
  if (!hasGuards(guards) || guards === undefined) {
    return { status: 'ok', checked: [], missing: [] };
  }
  if (sample === null) {
    return { status: 'unavailable', missing: ['telemetry'], message: 'No hardware telemetry sample was available.' };
  }

  const checked: string[] = [];
  const missing: string[] = [];

  if (guards.maxCpuTempC !== undefined) {
    if (sample.cpuTempC === null) missing.push('CPU temperature');
    else {
      checked.push(`CPU ${round1(sample.cpuTempC)}°C`);
      if (sample.cpuTempC >= guards.maxCpuTempC) {
        return {
          status: 'trip',
          reason: { kind: 'cpu-temp', valueC: round1(sample.cpuTempC), limitC: guards.maxCpuTempC },
          message: `CPU reached ${round1(sample.cpuTempC)}°C, at or above the ${guards.maxCpuTempC}°C guard.`,
        };
      }
    }
  }

  if (guards.maxGpuTempC !== undefined) {
    if (sample.gpuTempC === null) missing.push('GPU temperature');
    else {
      checked.push(`GPU ${round1(sample.gpuTempC)}°C`);
      if (sample.gpuTempC >= guards.maxGpuTempC) {
        return {
          status: 'trip',
          reason: { kind: 'gpu-temp', valueC: round1(sample.gpuTempC), limitC: guards.maxGpuTempC },
          message: `GPU reached ${round1(sample.gpuTempC)}°C, at or above the ${guards.maxGpuTempC}°C guard.`,
        };
      }
    }
  }

  if (guards.onBattery === 'restore') {
    if (sample.onAc === null) missing.push('AC power state');
    else {
      checked.push(sample.onAc ? 'AC power' : 'battery');
      if (!sample.onAc) {
        return {
          status: 'trip',
          reason: { kind: 'on-battery', batteryPercent: sample.batteryPercent },
          message:
            sample.batteryPercent === null
              ? 'The machine switched to battery; this profile only runs on AC power.'
              : `The machine switched to battery (${sample.batteryPercent}%); this profile only runs on AC power.`,
        };
      }
    }
  }

  // Nothing at all could be evaluated: the guard is unenforceable, which is different
  // from passing. A partially readable guard stays `ok` and reports what it missed.
  if (checked.length === 0 && missing.length > 0) {
    return {
      status: 'unavailable',
      missing,
      message: `Guard not enforced: ${missing.join(' and ')} unavailable on this machine.`,
    };
  }

  return { status: 'ok', checked, missing };
}

/** Human-readable one-liners for the profile list. */
export function describeGuards(guards: ThermalGuards): string[] {
  const parts: string[] = [];
  if (guards.maxCpuTempC !== undefined) parts.push(`restore above ${guards.maxCpuTempC}°C CPU`);
  if (guards.maxGpuTempC !== undefined) parts.push(`restore above ${guards.maxGpuTempC}°C GPU`);
  if (guards.onBattery === 'restore') parts.push('restore on battery');
  if (parts.length === 0) return [];
  return [parts.join(' · ')];
}
