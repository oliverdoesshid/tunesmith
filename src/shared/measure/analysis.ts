/**
 * The verdict logic — pure, and deliberately conservative.
 *
 * A measurement subsystem that only ever reports wins is worse than none: it manufactures
 * confidence. So the rules here are built so that the *default* answer is "nothing
 * detectable", and a machine that is too noisy produces `inconclusive` rather than a
 * flattering number. All of it is pure functions, which is why it is testable without a
 * Windows host.
 */
import {
  METRIC_META,
  type MetricComparison,
  type MetricDirection,
  type MetricId,
  type MetricSummary,
  type Verdict,
} from './types';

/** Fewer samples than this in either window and no verdict is offered at all. */
export const MIN_SAMPLES = 10;

/** A difference smaller than this fraction of the baseline is never called a change… */
export const NOISE_RELATIVE_FLOOR = 0.05;

/** …and neither is one smaller than ~2σ of the baseline's own run-to-run spread. */
export const NOISE_SIGMA_MULTIPLIER = 2;

/** Above this coefficient of variation the baseline itself is too unstable to attribute a delta to. */
export const MAX_BASELINE_CV = 0.5;

/** Linear-interpolated percentile; `p` is a fraction in [0, 1]. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const clamped = Math.min(1, Math.max(0, p));
  const index = (sorted.length - 1) * clamped;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (index - lo);
}

/** Summarise one metric's samples. Returns null when there is nothing finite to describe. */
export function summarize(metric: MetricId, samples: readonly number[]): MetricSummary | null {
  const clean = samples.filter((value) => Number.isFinite(value));
  if (clean.length === 0) return null;

  let min = clean[0] ?? 0;
  let max = min;
  let sum = 0;
  for (const value of clean) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }

  const mean = sum / clean.length;
  const variance =
    clean.length > 1 ? clean.reduce((acc, value) => acc + (value - mean) ** 2, 0) / (clean.length - 1) : 0;
  const stdev = Math.sqrt(variance);

  return {
    metric,
    unit: METRIC_META[metric].unit,
    samples: clean.length,
    mean,
    median: percentile(clean, 0.5),
    p95: percentile(clean, 0.95),
    p99: percentile(clean, 0.99),
    min,
    max,
    stdev,
    cv: mean === 0 ? 0 : stdev / Math.abs(mean),
  };
}

function emptyComparison(
  metric: MetricId,
  baseline: MetricSummary | null,
  after: MetricSummary | null,
  verdict: Verdict,
  note: string,
): MetricComparison {
  const meta = METRIC_META[metric];
  return {
    metric,
    label: meta.label,
    unit: meta.unit,
    direction: meta.direction,
    statistic: meta.compareOn,
    baseline,
    after,
    delta: null,
    deltaPercent: null,
    noiseFloor: null,
    verdict,
    note,
  };
}

/**
 * Compare one metric across the two windows.
 *
 * Order of refusals matters: insufficient samples, then a noisy baseline, then the noise
 * floor. Only a difference that survives all three becomes `improved`/`regressed`.
 */
export function compareMetric(
  metric: MetricId,
  baseline: MetricSummary | null,
  after: MetricSummary | null,
): MetricComparison {
  const meta = METRIC_META[metric];

  if (baseline === null || after === null) {
    return emptyComparison(metric, baseline, after, 'unavailable', 'No samples were collected for this counter.');
  }

  if (baseline.samples < MIN_SAMPLES || after.samples < MIN_SAMPLES) {
    return emptyComparison(
      metric,
      baseline,
      after,
      'unavailable',
      `Needs at least ${MIN_SAMPLES} samples per window (baseline ${baseline.samples}, after ${after.samples}).`,
    );
  }

  const before = baseline[meta.compareOn];
  const now = after[meta.compareOn];

  if (baseline.cv > MAX_BASELINE_CV && Math.abs(before) > meta.absoluteFloor) {
    return emptyComparison(
      metric,
      baseline,
      after,
      'inconclusive',
      `The baseline varied too much to attribute a change (${(baseline.cv * 100).toFixed(0)}% spread). Re-measure on an idle desktop or a fixed game scene.`,
    );
  }

  const noiseFloor = Math.max(
    Math.abs(before) * NOISE_RELATIVE_FLOOR,
    baseline.stdev * NOISE_SIGMA_MULTIPLIER,
    meta.absoluteFloor,
  );

  const delta = now - before;
  const deltaPercent = before === 0 ? null : (delta / Math.abs(before)) * 100;
  const significant = Math.abs(delta) > noiseFloor;

  let verdict: Verdict;
  let note: string;

  if (!significant) {
    verdict = 'unchanged';
    note = 'Within run-to-run noise.';
  } else if (meta.direction === 'neutral') {
    // Informational counters have no better direction, so a real difference is still
    // not evidence of improvement.
    verdict = 'inconclusive';
    note = 'Changed, but this counter has no better direction — context only.';
  } else {
    const improved = meta.direction === 'lower-better' ? delta < 0 : delta > 0;
    verdict = improved ? 'improved' : 'regressed';
    note =
      meta.direction === 'lower-better'
        ? `Fell ${Math.abs(delta).toFixed(meta.decimals)} ${unitSuffix(meta.unit)} beyond the ${noiseFloor.toFixed(meta.decimals)} noise floor.`
        : `Rose ${Math.abs(delta).toFixed(meta.decimals)} ${unitSuffix(meta.unit)} beyond the ${noiseFloor.toFixed(meta.decimals)} noise floor.`;
  }

  return {
    metric,
    label: meta.label,
    unit: meta.unit,
    direction: meta.direction,
    statistic: meta.compareOn,
    baseline,
    after,
    delta,
    deltaPercent,
    noiseFloor,
    verdict,
    note,
  };
}

function unitSuffix(unit: MetricComparison['unit']): string {
  switch (unit) {
    case 'percent':
      return 'pp';
    case 'per-second':
      return '/s';
    case 'ms':
      return 'ms';
    case 'count':
      return '';
  }
}

/**
 * Fold per-metric verdicts into one. A regression anywhere wins, because claiming "this
 * preset helped" while one counter got worse would be a lie by omission.
 */
export function aggregateVerdict(comparisons: readonly MetricComparison[]): Verdict {
  if (comparisons.length === 0) return 'unavailable';

  const decisive = comparisons.filter((entry) => METRIC_META[entry.metric].direction !== 'neutral');
  const pool = decisive.length > 0 ? decisive : comparisons;

  if (pool.some((entry) => entry.verdict === 'regressed')) return 'regressed';
  if (pool.some((entry) => entry.verdict === 'improved')) return 'improved';
  if (pool.every((entry) => entry.verdict === 'unavailable')) return 'unavailable';
  if (pool.some((entry) => entry.verdict === 'inconclusive')) return 'inconclusive';
  return 'unchanged';
}

export function directionLabel(direction: MetricDirection): string {
  switch (direction) {
    case 'lower-better':
      return 'lower is better';
    case 'higher-better':
      return 'higher is better';
    case 'neutral':
      return 'context only';
  }
}

/** One sentence the UI shows verbatim. Never claims more than the data supports. */
export function describeVerdict(comparisons: readonly MetricComparison[], verdict: Verdict | null): string {
  if (verdict === null) return 'Baseline captured. Apply the change, then measure again to compare.';

  const improved = comparisons.filter((entry) => entry.verdict === 'improved').map((entry) => entry.label);
  const regressed = comparisons.filter((entry) => entry.verdict === 'regressed').map((entry) => entry.label);
  const unavailable = comparisons.filter((entry) => entry.verdict === 'unavailable').length;

  switch (verdict) {
    case 'improved':
      return `Measured improvement in ${improved.join(', ')}${regressed.length > 0 ? `; regression in ${regressed.join(', ')}` : ''}.`;
    case 'regressed':
      return `No net gain: ${regressed.join(', ')} got worse${improved.length > 0 ? `, despite ${improved.join(', ')} improving` : ''}.`;
    case 'unchanged':
      return 'No difference beyond run-to-run noise. This change is not doing anything measurable here.';
    case 'inconclusive':
      return 'The machine was too noisy, or the counters moved without a clear direction. Re-measure before trusting this preset.';
    case 'unavailable':
      return unavailable === comparisons.length
        ? 'No usable samples were collected, so no claim is made about this preset.'
        : 'Not enough evidence to judge this preset.';
  }
}
