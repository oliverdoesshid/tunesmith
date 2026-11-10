import { describe, expect, it } from 'vitest';
import { evaluateCompatibility, evaluateCondition } from '../src/shared/preset/matcher';
import { makeSpec } from './factories';

// The reference spec is a real 32 GB machine: raw capacity reads 31.9 GB, the signature
// says 32GB. Presets are written against the signature, so matching must use the tier.
const withRam = (totalGb: number, bucketGb: number) =>
  makeSpec({
    memory: {
      totalBytes: Math.round(totalGb * 1024 ** 3),
      totalGb,
      bucketGb,
      speedMhz: 3200,
      moduleCount: 2,
    },
  });

describe('RAM matching', () => {
  it('compares the bucketed tier, not the raw reading', () => {
    const result = evaluateCompatibility({ ramGb: { min: 32 } }, withRam(31.9, 32));
    expect(result.applicable).toBe(true);
    expect(result.score).toBe(1);
    expect(result.reasons.join(' ')).not.toContain('outside');
  });

  it('still rejects a machine genuinely below the tier', () => {
    const result = evaluateCompatibility({ ramGb: { min: 32 } }, withRam(15.9, 16));
    expect(result.applicable).toBe(false);
    expect(result.reasons[0]).toContain('RAM 16GB');
  });

  it('applies the same rule to profile conditions', () => {
    const spec = withRam(31.9, 32);
    expect(evaluateCondition({ ramGb: { min: 32 } }, spec).active).toBe(true);
    expect(evaluateCondition({ ramGb: { max: 16 } }, spec).active).toBe(false);
  });

  it('falls back to the raw reading when a spec has no usable bucket', () => {
    expect(evaluateCompatibility({ ramGb: { min: 32 } }, withRam(15.9, 0)).applicable).toBe(false);
  });

  it('reports the reason in tier units so the UI matches the signature chip', () => {
    const result = evaluateCompatibility({ ramGb: { min: 64 } }, withRam(31.9, 32));
    expect(result.reasons[0]).toBe('RAM 32GB is outside >= 64GB');
  });
});
