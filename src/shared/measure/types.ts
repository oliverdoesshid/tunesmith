/**
 * Empirical performance verification: the data contract.
 *
 * The point of this subsystem is to be able to say *"no detectable difference"*.
 * Every type here therefore has an explicit "not enough evidence" path rather than
 * defaulting to a positive result.
 *
 * Nothing in this file imports Electron or node:fs — the renderer, the main process
 * and the unit tests all share it.
 */

/** Counters we can actually read on a stock Windows install, without extra tooling. */
export const METRIC_IDS = [
  'dpcPercent',
  'interruptPercent',
  'contextSwitchesPerSec',
  'processorQueueLength',
  'cpuUtilityPercent',
  'frameTimeMs',
] as const;

export type MetricId = (typeof METRIC_IDS)[number];

export type MetricUnit = 'percent' | 'per-second' | 'count' | 'ms';

/**
 * `lower-better` and `higher-better` are assertions we are willing to defend.
 * `neutral` metrics are recorded for context and can *never* produce an
 * "improved"/"regressed" verdict — context switches and CPU utility are workload
 * dependent, so claiming a direction for them would be dishonest.
 */
export type MetricDirection = 'lower-better' | 'higher-better' | 'neutral';

export interface MetricMeta {
  label: string;
  unit: MetricUnit;
  direction: MetricDirection;
  /** Which summary statistic the verdict is computed on. */
  compareOn: 'median' | 'p99';
  /** Below this, a difference is treated as noise even when the baseline is perfectly stable. */
  absoluteFloor: number;
  decimals: number;
  /** Shown in the UI under the metric name. */
  explanation: string;
}

export const METRIC_META: Record<MetricId, MetricMeta> = {
  dpcPercent: {
    label: 'DPC time',
    unit: 'percent',
    direction: 'lower-better',
    compareOn: 'median',
    absoluteFloor: 0.1,
    decimals: 2,
    explanation: 'Share of CPU time spent in deferred procedure calls. Driver work that pre-empts the game.',
  },
  interruptPercent: {
    label: 'Interrupt time',
    unit: 'percent',
    direction: 'lower-better',
    compareOn: 'median',
    absoluteFloor: 0.1,
    decimals: 2,
    explanation: 'Share of CPU time spent servicing hardware interrupts.',
  },
  contextSwitchesPerSec: {
    label: 'Context switches',
    unit: 'per-second',
    direction: 'neutral',
    compareOn: 'median',
    absoluteFloor: 50,
    decimals: 0,
    explanation: 'Scheduler activity. Informational: the right value depends on the workload.',
  },
  processorQueueLength: {
    label: 'Processor queue',
    unit: 'count',
    direction: 'lower-better',
    compareOn: 'median',
    absoluteFloor: 0.05,
    decimals: 2,
    explanation: 'Threads waiting for a core. A persistent queue means the CPU is the bottleneck.',
  },
  cpuUtilityPercent: {
    label: 'CPU utility',
    unit: 'percent',
    direction: 'neutral',
    compareOn: 'median',
    absoluteFloor: 0.5,
    decimals: 1,
    explanation: 'Informational: higher can mean more work is being done, not a faster machine.',
  },
  frameTimeMs: {
    label: 'Frame time (1% low)',
    unit: 'ms',
    direction: 'lower-better',
    // The 99th percentile frame time *is* the 1% low: the worst 1% of frames.
    compareOn: 'p99',
    absoluteFloor: 0.2,
    decimals: 2,
    explanation: 'Worst 1% of frames from an ETW trace. Stutter, not average frame rate.',
  },
};

export interface MetricSummary {
  metric: MetricId;
  unit: MetricUnit;
  samples: number;
  mean: number;
  median: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  stdev: number;
  /** Coefficient of variation: stdev / |mean|. Used to detect a too-noisy baseline. */
  cv: number;
}

export type Verdict = 'improved' | 'regressed' | 'unchanged' | 'inconclusive' | 'unavailable';

export interface MetricComparison {
  metric: MetricId;
  label: string;
  unit: MetricUnit;
  direction: MetricDirection;
  /** Statistic the delta was computed on. */
  statistic: 'median' | 'p99';
  baseline: MetricSummary | null;
  after: MetricSummary | null;
  /** after - baseline on `statistic`. Negative means the metric fell. */
  delta: number | null;
  deltaPercent: number | null;
  /** Minimum difference treated as real rather than run-to-run noise. */
  noiseFloor: number | null;
  verdict: Verdict;
  note: string;
}

/** How frame times were obtained, and why they might be missing. */
export interface FrameTraceInfo {
  mode: 'etw' | 'none';
  frames: number;
  /** Set whenever `frames` is 0, so the UI can explain the gap instead of showing a blank. */
  reason: string | null;
}

export interface MeasurementWindow {
  startedAt: string;
  durationMs: number;
  /** Counter samples collected (one per second). */
  samples: number;
  metrics: MetricSummary[];
  frames: FrameTraceInfo;
}

export type MeasurementStatus = 'baseline' | 'compared' | 'abandoned';

/**
 * One before/after pair. `baseline` is captured *before* a change is applied and
 * `after` once the machine has settled, so the two windows describe the same hardware
 * under the same (self-reported) workload.
 */
export interface MeasurementRecord {
  schemaVersion: 1;
  id: string;
  label: string;
  presetId: string | null;
  profileId: string | null;
  status: MeasurementStatus;
  signature: string;
  createdAt: string;
  finishedAt: string | null;
  baseline: MeasurementWindow;
  after: MeasurementWindow | null;
  comparisons: MetricComparison[];
  verdict: Verdict | null;
  /** Plain-language summary, shown verbatim in the UI. */
  verdictText: string;
  notes: string[];
}

export interface MeasurementProgress {
  phase: 'baseline' | 'after' | 'frames' | 'done';
  message: string;
  current?: number;
  total?: number;
}
