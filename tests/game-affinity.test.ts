import { describe, expect, it } from 'vitest';
import {
  computeAffinityMask,
  describeCores,
  isUsableMask,
  maskFromCores,
  maskToHex,
} from '../src/shared/game/affinity';
import type { CpuTopology } from '../src/shared/game/types';

/** 8 logical processors: 4 physical cores with SMT, no hybrid split (e.g. Ryzen). */
const SMT: CpuTopology = {
  logicalProcessors: 8,
  physicalCores: 4,
  hybrid: false,
  efficiencyClasses: [0, 0, 0, 0, 0, 0, 0, 0],
  coreIndices: [0, 0, 1, 1, 2, 2, 3, 3],
  source: 'synthetic',
  higherEfficiencyIsFaster: true,
};

/** 8 logical processors: 4 performance cores then 4 efficiency cores. */
const HYBRID: CpuTopology = {
  logicalProcessors: 8,
  physicalCores: 8,
  hybrid: true,
  efficiencyClasses: [1, 1, 1, 1, 0, 0, 0, 0],
  coreIndices: [0, 1, 2, 3, 4, 5, 6, 7],
  source: 'cpuset',
  higherEfficiencyIsFaster: true,
};

describe('affinity masks', () => {
  it('encodes logical processors as bits', () => {
    expect(maskFromCores([0, 2, 4, 6])).toBe(0x55n);
    expect(maskToHex(0x55n)).toBe('0x55');
    expect(maskFromCores([])).toBe(0n);
    expect(describeCores([0, 2, 4, 6])).toBe('0, 2, 4, 6');
  });

  it('keeps one thread per physical core and drops SMT siblings', () => {
    const selection = computeAffinityMask(SMT, { strategy: 'physical-cores' });
    expect(selection.cores).toEqual([0, 2, 4, 6]);
    expect(selection.mask).toBe(0x55n);
  });

  it('selects performance cores on a hybrid CPU', () => {
    const selection = computeAffinityMask(HYBRID, { strategy: 'performance-cores' });
    expect(selection.cores).toEqual([0, 1, 2, 3]);
    expect(selection.reason).toContain('Performance cores only');
  });

  it('selects efficiency cores for background work', () => {
    expect(computeAffinityMask(HYBRID, { strategy: 'efficiency-cores' }).cores).toEqual([4, 5, 6, 7]);
  });

  it('honours an inverted efficiency class reporting', () => {
    const selection = computeAffinityMask(HYBRID, { strategy: 'performance-cores', performanceClass: 'lowest' });
    expect(selection.cores).toEqual([4, 5, 6, 7]);
  });

  it('falls back to every core when the CPU is not hybrid', () => {
    const selection = computeAffinityMask(SMT, { strategy: 'performance-cores' });
    expect(selection.cores).toHaveLength(8);
    expect(selection.reason).toContain('not hybrid');
  });

  it('never returns an empty mask for a custom plan', () => {
    const selection = computeAffinityMask(SMT, { strategy: 'custom', cores: [99, 42] });
    expect(selection.mask).not.toBe(0n);
    expect(selection.cores).toHaveLength(8);
    expect(selection.reason).toContain('No valid logical processors');
  });

  it('deduplicates and bounds custom selections', () => {
    const selection = computeAffinityMask(SMT, { strategy: 'custom', cores: [1, 1, 2, 99] });
    expect(selection.cores).toEqual([1, 2]);
    expect(selection.mask).toBe(0x6n);
    expect(isUsableMask(selection, SMT)).toBe(true);
  });

  it('splits affinity across processor groups above 64 logical processors', () => {
    const dual: CpuTopology = {
      ...SMT,
      logicalProcessors: 128,
      totalLogicalProcessors: 128,
      physicalCores: 64,
      efficiencyClasses: new Array<number>(128).fill(0),
      coreIndices: Array.from({ length: 128 }, (_, index) => index % 64),
      groups: [
        { index: 0, count: 64, mask: '0xFFFFFFFFFFFFFFFF' },
        { index: 1, count: 64, mask: '0xFFFFFFFFFFFFFFFF' },
      ],
    };

    const all = computeAffinityMask(dual, { strategy: 'all-cores' });
    expect(all.groups).toEqual([
      { index: 0, mask: '0xFFFFFFFFFFFFFFFF' },
      { index: 1, mask: '0xFFFFFFFFFFFFFFFF' },
    ]);
    expect(all.cores).toHaveLength(128);
    expect(all.reason).toContain('2 processor groups');
    expect(isUsableMask(all, dual)).toBe(true);

    // A custom selection may cross groups; each index maps into its own mask.
    const crossGroup = computeAffinityMask(dual, { strategy: 'custom', cores: [0, 64] });
    expect(crossGroup.groups).toEqual([
      { index: 0, mask: '0x1' },
      { index: 1, mask: '0x1' },
    ]);
  });

  it('refuses more than the documented 256 logical processors', () => {
    const absurd: CpuTopology = { ...SMT, logicalProcessors: 512, totalLogicalProcessors: 512 };
    const selection = computeAffinityMask(absurd, { strategy: 'all-cores' });
    expect(selection.groups).toEqual([]);
    expect(isUsableMask(selection, absurd)).toBe(false);
  });
});
