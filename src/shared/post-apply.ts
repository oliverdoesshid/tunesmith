/**
 * Post-apply stability watchdog contract.
 *
 * This status is intentionally explicit about missing sensors: a machine without a
 * temperature provider is not reported as "safe", and DPC monitoring is identified by
 * its Windows data source rather than presented as a hardware latency measurement.
 */
import type { CpuTempSource, GpuTempSource } from './game/types';
import type { RollbackReport } from './session';

export type PostApplyPhase =
  | 'idle'
  | 'monitoring'
  | 'stable'
  | 'rolling-back'
  | 'rolled-back'
  | 'rollback-failed'
  | 'cancelled';

export interface PostApplyProbeSample {
  at: string;
  cpuTempC: number | null;
  gpuTempC: number | null;
  cpuTempSource: CpuTempSource;
  gpuTempSource: GpuTempSource;
  /** Windows `% DPC Time` for the processor total; null when unavailable. */
  dpcPercent: number | null;
  dpcSource: 'cim-perf-counter' | 'unavailable';
}

export interface PostApplyTrip {
  kind: 'cpu-temp' | 'gpu-temp' | 'dpc' | 'freeze';
  at: string;
  message: string;
}

export interface PostApplyStatus {
  phase: PostApplyPhase;
  active: boolean;
  sessionId: string | null;
  presetId: string | null;
  presetName: string | null;
  startedAt: string | null;
  endsAt: string | null;
  remainingMs: number;
  sampleCount: number;
  sample: PostApplyProbeSample | null;
  trip: PostApplyTrip | null;
  rollback: RollbackReport | null;
  message: string;
}

export function idlePostApplyStatus(): PostApplyStatus {
  return {
    phase: 'idle',
    active: false,
    sessionId: null,
    presetId: null,
    presetName: null,
    startedAt: null,
    endsAt: null,
    remainingMs: 0,
    sampleCount: 0,
    sample: null,
    trip: null,
    rollback: null,
    message: 'No post-apply stability window is active.',
  };
}
