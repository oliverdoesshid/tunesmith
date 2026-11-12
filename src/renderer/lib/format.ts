import type { HardwareSpec } from '../../shared/types';
import type { RiskLevel } from '../../shared/types';
import type { SessionStatus } from '../../shared/session';

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatGb(gb: number | null | undefined): string {
  if (gb === null || gb === undefined || !Number.isFinite(gb)) return 'unknown';
  return `${gb % 1 === 0 ? gb : gb.toFixed(1)} GB`;
}

export function formatClock(mhz: number | null): string {
  if (mhz === null || mhz <= 0) return 'unknown';
  return `${(mhz / 1000).toFixed(2)} GHz`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function riskLabel(risk: RiskLevel): string {
  switch (risk) {
    case 'conservative':
      return 'Conservative';
    case 'moderate':
      return 'Moderate';
    case 'aggressive':
      return 'Aggressive';
  }
}

export function statusLabel(status: SessionStatus): string {
  switch (status) {
    case 'applying':
      return 'Interrupted';
    case 'applied':
      return 'Applied';
    case 'failed':
      return 'Failed';
    case 'rolled-back':
      return 'Restored';
    case 'rollback-failed':
      return 'Restore incomplete';
  }
}

export function gpuSummary(spec: HardwareSpec): string {
  if (spec.primaryGpu === null) return 'No discrete GPU detected';
  return spec.primaryGpu.rawName;
}

export function storageSummary(spec: HardwareSpec): string {
  const primary = spec.storage.primary;
  if (primary === null) return 'Unknown system drive';
  return `${primary.mediaType} · ${primary.bus} · ${primary.model}`;
}
