/**
 * Hardware signature: the canonicalisation rules and the string format.
 *
 * WHY THIS IS A VERSIONED CONTRACT
 * Community presets are keyed off this exact string, so the rules below are a wire
 * format, not a display detail. Any change to canonicalisation must bump
 * SIGNATURE_VERSION, or a preset authored against `RTX4070Ti` silently stops matching
 * a machine that now reports `RTX4070-Ti`.
 *
 * FORMAT
 *   <cpu token>_<gpu token>_<ram token>_<drive token>
 *   Intel_i7-14700K_RTX4070Ti_32GB_SSD
 *   AMD_Ryzen5_5600X_RTX3060_32GB_SSD
 *
 * The CPU token itself always contains an underscore (`Vendor_Model`), which is why
 * parsing works from the right-hand end rather than by splitting on every `_`.
 */
import type { CpuVendor, DriveType, GpuKind, GpuVendor } from './types';

export const SIGNATURE_VERSION = 1;

/** Standard capacity tiers. Signatures use these so `31.92 GB` becomes `32GB`. */
const RAM_TIERS = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256] as const;

/** Strip junk that vendors sprinkle into WMI names, and collapse whitespace. */
function tidy(raw: string): string {
  return raw
    .replace(/\((?:r|tm)\)/gi, ' ')
    .replace(/[\u00ae\u2122\u2013\u2014]/g, ' ')
    .replace(/@\s*[\d.]+\s*ghz/gi, ' ')
    .replace(/\b\d+\s*-\s*cores?\b/gi, ' ')
    .replace(/\b\d+\s*-\s*threads?\b/gi, ' ')
    .replace(/\bw\/\s*/gi, ' ')
    .replace(/\b(?:cpu|processor|corporation|inc\.?|technologies|family|series)\b/gi, ' ')
    .replace(/[^A-Za-z0-9 ._+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fallbackModel(cleaned: string): string {
  const parts = cleaned.split(' ').filter(Boolean).slice(0, 2).join('_');
  const safe = parts.replace(/[^A-Za-z0-9_-]/g, '');
  return safe.length > 0 ? safe : 'Unknown';
}

export function detectCpuVendor(vendorRaw: string, nameRaw: string): CpuVendor {
  const hay = `${vendorRaw} ${nameRaw}`;
  if (/genuineintel|intel/i.test(hay)) return 'Intel';
  if (/authenticamd|\bamd\b/i.test(hay)) return 'AMD';
  if (/\barm\b|snapdragon|qualcomm/i.test(hay)) return 'ARM';
  return 'Unknown';
}

/** `i7-14700K`, `Ultra7-155H`, `XeonW-2295` … */
function intelModel(cleaned: string): string | null {
  const ultra = /\bultra\s*([3579])\s+(\d{3}[a-z]{0,2})\b/i.exec(cleaned);
  if (ultra?.[1] && ultra[2]) return `Ultra${ultra[1]}-${ultra[2].toUpperCase()}`;

  const core = /\b(i[3579])\s*-?\s*(\d{3,5}[a-z]{0,3})\b/i.exec(cleaned);
  if (core?.[1] && core[2]) return `${core[1].toLowerCase()}-${core[2].toUpperCase()}`;

  const xeon = /\bxeon\s*([a-z]*)\s*-?\s*(\d{4}[a-z]{0,3})\b/i.exec(cleaned);
  if (xeon?.[2]) return `Xeon${(xeon[1] ?? '').toUpperCase()}-${xeon[2].toUpperCase()}`;

  return null;
}

/** `Ryzen5_5600X`, `Ryzen9_7950X3D`, `ThreadripperPRO_5995WX` … */
function amdModel(cleaned: string): string | null {
  const m = /\b(ryzen|threadripper|epyc|athlon)\b(?:\s+(pro))?\s+(?:([3579])\s+)?(\d{3,5}[a-z0-9]{0,4})\b/i.exec(cleaned);
  if (!m?.[1] || !m[4]) return null;
  const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  const pro = m[2] ? 'PRO' : '';
  const tier = m[3] ?? '';
  // Family + tier form one token segment; the model number is separated by `_`.
  return `${family}${pro}${tier}_${m[4].toUpperCase()}`;
}

export function canonicalizeCpu(vendorRaw: string, nameRaw: string): { vendor: CpuVendor; model: string; token: string } {
  const vendor = detectCpuVendor(vendorRaw, nameRaw);
  let cleaned = tidy(nameRaw);
  cleaned = cleaned.replace(/^(?:amd|intel)\s+/i, '').replace(/^core\s+/i, '').trim();

  const model =
    (vendor === 'Intel' ? intelModel(cleaned) : vendor === 'AMD' ? amdModel(cleaned) : null) ?? fallbackModel(cleaned);

  return { vendor, model, token: `${vendor}_${model}` };
}

export function detectGpuVendor(nameRaw: string): GpuVendor {
  if (/nvidia|geforce|quadro|tesla/i.test(nameRaw)) return 'NVIDIA';
  if (/\bamd\b|radeon|firepro|\batir/i.test(nameRaw)) return 'AMD';
  if (/\bintel\b|\barc\b|iris|\buhd\b/i.test(nameRaw)) return 'Intel';
  if (/microsoft|basic (render|display)/i.test(nameRaw)) return 'Microsoft';
  return 'Unknown';
}

export function detectGpuKind(nameRaw: string): GpuKind {
  // Vendors interleave marks with spaces (`AMD Radeon(TM) Graphics`), so strip the
  // marks before matching rather than trying to encode them into every pattern.
  const probe = nameRaw.replace(/\((?:r|tm)\)/gi, ' ').replace(/\s+/g, ' ');

  if (/virtual|remote|basic (render|display)|parsec|citrix|spacedesk|meta virtual|mirror|indirect display/i.test(probe)) {
    return 'virtual';
  }
  if (/\buhd\b|\bhd graphics\b|iris|\bvega\b|radeon\s+graphics|integrated|\bapu\b|intel\s+graphics/i.test(probe)) {
    return 'integrated';
  }
  return 'discrete';
}

/**
 * `NVIDIA GeForce RTX 4070 Ti` -> `RTX4070Ti`
 * `AMD Radeon RX 7900 XTX`    -> `RX7900XTX`
 * `Intel(R) UHD Graphics 770` -> `UHD770`
 */
export function canonicalizeGpu(rawName: string): { vendor: GpuVendor; model: string; token: string; kind: GpuKind } {
  const vendor = detectGpuVendor(rawName);
  const kind = detectGpuKind(rawName);

  let cleaned = tidy(rawName)
    .replace(/^(?:nvidia|amd|intel|microsoft)\s+/i, '')
    .replace(/\bgeforce\b/gi, ' ')
    // Drop the word "graphics" first: `Intel(R) UHD Graphics 770` must become
    // `UHD770`, not `UHDGraphics770`.
    .replace(/\bgraphics\b/gi, ' ')
    // Only drop "Radeon" when a model name follows; bare "Radeon" is a real APU token.
    .replace(/\bradeon\b(?=\s+[a-z0-9])/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length === 0) cleaned = tidy(rawName);

  const model = cleaned.split(' ').filter(Boolean).join('').replace(/[^A-Za-z0-9_-]/g, '');
  const token = model.length > 0 ? model : 'Unknown';
  return { vendor, model: token, token, kind };
}

/** Snap a measured capacity to the nearest standard tier; keep unusual sizes as-is. */
export function bucketRamGb(totalGb: number): number {
  if (!Number.isFinite(totalGb) || totalGb <= 0) return 4;
  const measured = Math.round(totalGb);
  let best = measured;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const tier of RAM_TIERS) {
    const delta = Math.abs(tier - measured);
    if (delta < bestDelta) {
      best = tier;
      bestDelta = delta;
    }
  }
  // Only snap when we are close, and never on a tie: a 6 GB machine is neither a
  // 4 GB nor an 8 GB machine, and misreporting it would mismatch the wrong presets.
  return bestDelta <= 1 ? best : measured;
}

export function ramToken(bucketGb: number): string {
  return `${bucketGb}GB`;
}

export function buildSignature(input: {
  cpuToken: string;
  gpuToken: string | null;
  ramBucketGb: number;
  driveType: DriveType;
}): string {
  return [input.cpuToken, input.gpuToken ?? 'NOGPU', ramToken(input.ramBucketGb), input.driveType].join('_');
}

export interface ParsedSignature {
  cpuToken: string;
  gpuToken: string;
  ramGb: number;
  driveType: string;
}

/**
 * Parse from the right: the CPU token owns every underscore before the GPU segment.
 * Returns null for anything that is not plausibly a signature.
 */
export function parseSignature(signature: string): ParsedSignature | null {
  const parts = signature.split('_');
  if (parts.length < 4) return null;

  const driveType = parts[parts.length - 1] ?? '';
  const ram = parts[parts.length - 2] ?? '';
  const gpuToken = parts[parts.length - 3] ?? '';
  const cpuToken = parts.slice(0, -3).join('_');

  if (cpuToken.length === 0 || gpuToken.length === 0) return null;
  const ramMatch = /^(\d{1,4})GB$/.exec(ram);
  if (!ramMatch?.[1]) return null;

  return { cpuToken, gpuToken, ramGb: Number(ramMatch[1]), driveType };
}

/**
 * Glob match supporting a single wildcard, `*`.
 *
 * Preset-supplied patterns are turned into regexes with every metacharacter escaped
 * first, so a preset cannot smuggle a regex (or a catastrophic backtracking pattern)
 * into the matcher.
 */
export function matchSegment(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try {
    return new RegExp(`^${escaped}$`, 'i').test(value);
  } catch {
    return false;
  }
}

export function matchAny(patterns: readonly string[], value: string): boolean {
  return patterns.some((p) => matchSegment(p, value));
}
