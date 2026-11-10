/**
 * Compatibility matching between a preset's selectors and a detected machine.
 *
 * Matching is intentionally asymmetric: an unspecified dimension is a wildcard
 * (so a preset can target "any SSD" or "any NVIDIA GPU"), but a *specified*
 * dimension that does not match makes the preset inapplicable. That keeps a
 * gaming preset off a machine it was not designed for instead of guessing.
 */
import { matchAny } from '../signature';
import type { HardwareSpec } from '../types';
import type { PresetCompatibility, ProfileCondition } from './schema';

export interface CompatibilityResult {
  applicable: boolean;
  /** 0..1 fraction of specified dimensions that matched. */
  score: number;
  specified: number;
  matched: number;
  reasons: string[];
}

interface RangeCheck {
  min?: number | undefined;
  max?: number | undefined;
}

function rangeOk(range: RangeCheck, value: number): boolean {
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

/**
 * RAM is compared on the *bucketed* tier, never the raw reading.
 *
 * A 32 GB machine reports 31.9 GB, so comparing raw capacity rejects every preset that
 * asks for "32 GB" — and contradicts the signature, which already rounds to 32GB. The
 * bucket is the published contract; it is what presets are written against.
 */
function ramTierGb(spec: HardwareSpec): number {
  const bucket = spec.memory.bucketGb;
  return typeof bucket === 'number' && bucket > 0 ? bucket : spec.memory.totalGb;
}

function rangeText(range: RangeCheck, unit: string): string {
  if (range.min !== undefined && range.max !== undefined) return `${range.min}-${range.max}${unit}`;
  if (range.min !== undefined) return `>= ${range.min}${unit}`;
  if (range.max !== undefined) return `<= ${range.max}${unit}`;
  return `any ${unit}`;
}

export function evaluateCompatibility(selector: PresetCompatibility, spec: HardwareSpec): CompatibilityResult {
  const reasons: string[] = [];
  let specified = 0;
  let matched = 0;

  const gpuTokens = spec.gpus.map((g) => g.token);
  const primaryGpuToken = spec.primaryGpu?.token ?? 'NOGPU';
  const driveType = spec.storage.primary?.mediaType ?? 'UNKNOWN';

  if (selector.signature && selector.signature.length > 0) {
    specified += 1;
    if (matchAny(selector.signature, spec.signature)) {
      matched += 1;
    } else {
      reasons.push(`Signature ${spec.signature} matches none of: ${selector.signature.join(', ')}`);
    }
  }

  if (selector.cpu && selector.cpu.length > 0) {
    specified += 1;
    if (matchAny(selector.cpu, spec.cpu.token)) {
      matched += 1;
    } else {
      reasons.push(`CPU ${spec.cpu.token} matches none of: ${selector.cpu.join(', ')}`);
    }
  }

  if (selector.gpu && selector.gpu.length > 0) {
    specified += 1;
    // The signature uses the primary GPU, but a preset that names a discrete card
    // should still match a laptop whose iGPU is reported first.
    if (matchAny(selector.gpu, primaryGpuToken) || gpuTokens.some((t) => matchAny(selector.gpu!, t))) {
      matched += 1;
    } else {
      reasons.push(`GPU ${primaryGpuToken} matches none of: ${selector.gpu.join(', ')}`);
    }
  }

  if (selector.ramGb) {
    specified += 1;
    const ramGb = ramTierGb(spec);
    if (rangeOk(selector.ramGb, ramGb)) {
      matched += 1;
    } else {
      reasons.push(`RAM ${ramGb}GB is outside ${rangeText(selector.ramGb, 'GB')}`);
    }
  }

  if (selector.storage && selector.storage.length > 0) {
    specified += 1;
    if (selector.storage.includes(driveType)) {
      matched += 1;
    } else {
      reasons.push(`System drive is ${driveType}; preset requires ${selector.storage.join(' or ')}`);
    }
  }

  const applicable = specified === 0 || matched === specified;
  const score = specified === 0 ? 1 : matched / specified;

  if (specified === 0) reasons.push('Universal preset: no hardware constraints declared.');

  return { applicable, score, specified, matched, reasons };
}

/** Condition attached to one profile of a preset, evaluated against the same machine. */
export function evaluateCondition(condition: ProfileCondition, spec: HardwareSpec): { active: boolean; reasons: string[] } {
  const reasons: string[] = [];
  let active = true;

  if (condition.cpu && condition.cpu.length > 0 && !matchAny(condition.cpu, spec.cpu.token)) {
    active = false;
    reasons.push(`cpu ${spec.cpu.token} not in ${condition.cpu.join(', ')}`);
  }
  if (condition.gpu && condition.gpu.length > 0) {
    const tokens = spec.gpus.map((g) => g.token);
    const primary = spec.primaryGpu?.token ?? 'NOGPU';
    if (!matchAny(condition.gpu, primary) && !tokens.some((t) => matchAny(condition.gpu!, t))) {
      active = false;
      reasons.push(`gpu ${primary} not in ${condition.gpu.join(', ')}`);
    }
  }
  if (condition.ramGb) {
    const ramGb = ramTierGb(spec);
    if (!rangeOk(condition.ramGb, ramGb)) {
      active = false;
      reasons.push(`ram ${ramGb}GB outside ${rangeText(condition.ramGb, 'GB')}`);
    }
  }
  if (condition.storage && condition.storage.length > 0) {
    const driveType = spec.storage.primary?.mediaType ?? 'UNKNOWN';
    if (!condition.storage.includes(driveType)) {
      active = false;
      reasons.push(`storage ${driveType} not in ${condition.storage.join(', ')}`);
    }
  }
  if (condition.gpuVramGb) {
    const vram = spec.primaryGpu?.vramGb ?? 0;
    if (!rangeOk(condition.gpuVramGb, vram)) {
      active = false;
      reasons.push(`vram ${vram}GB outside ${rangeText(condition.gpuVramGb, 'GB')}`);
    }
  }
  if (condition.cpuThreads && !rangeOk(condition.cpuThreads, spec.cpu.threads)) {
    active = false;
    reasons.push(`threads ${spec.cpu.threads} outside ${rangeText(condition.cpuThreads, '')}`);
  }

  return { active, reasons };
}
