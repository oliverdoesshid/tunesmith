import { describe, expect, it } from 'vitest';
import {
  bucketRamGb,
  buildSignature,
  canonicalizeCpu,
  canonicalizeGpu,
  detectGpuKind,
  matchSegment,
  parseSignature,
} from '../src/shared/signature';

describe('CPU canonicalisation', () => {
  it('produces the documented Intel form', () => {
    const cpu = canonicalizeCpu('GenuineIntel', 'Intel(R) Core(TM) i7-14700K');
    expect(cpu.vendor).toBe('Intel');
    expect(cpu.token).toBe('Intel_i7-14700K');
  });

  it('handles a spaced model number', () => {
    expect(canonicalizeCpu('GenuineIntel', 'Intel(R) Core(TM) i7 9700K CPU @ 3.60GHz').token).toBe('Intel_i7-9700K');
  });

  it('produces the documented AMD form', () => {
    const cpu = canonicalizeCpu('AuthenticAMD', 'AMD Ryzen 5 5600X 6-Core Processor');
    expect(cpu.token).toBe('AMD_Ryzen5_5600X');
  });

  it('keeps the tier with multi-digit model numbers', () => {
    expect(canonicalizeCpu('AuthenticAMD', 'AMD Ryzen 9 7950X3D 16-Core Processor').token).toBe('AMD_Ryzen9_7950X3D');
    expect(canonicalizeCpu('AuthenticAMD', 'AMD Threadripper PRO 5995WX 64-Core Processor').token).toBe(
      'AMD_ThreadripperPRO_5995WX',
    );
  });

  it('handles Core Ultra', () => {
    expect(canonicalizeCpu('GenuineIntel', 'Intel(R) Core(TM) Ultra 7 155H').token).toBe('Intel_Ultra7-155H');
  });
});

describe('GPU canonicalisation', () => {
  it('matches the required signature vocabulary', () => {
    expect(canonicalizeGpu('NVIDIA GeForce RTX 4070 Ti').token).toBe('RTX4070Ti');
    expect(canonicalizeGpu('AMD Radeon RX 7900 XTX').token).toBe('RX7900XTX');
    expect(canonicalizeGpu('Intel(R) UHD Graphics 770').token).toBe('UHD770');
  });

  it('classifies virtual adapters', () => {
    expect(detectGpuKind('Virtual Desktop Monitor')).toBe('virtual');
    expect(detectGpuKind('Microsoft Basic Display Adapter')).toBe('virtual');
    expect(detectGpuKind('NVIDIA GeForce RTX 3060')).toBe('discrete');
    expect(detectGpuKind('AMD Radeon(TM) Graphics')).toBe('integrated');
  });

  it('never emits a lone vendor word', () => {
    expect(canonicalizeGpu('AMD Radeon(TM) Graphics').token).toBe('Radeon');
  });
});

describe('RAM bucketing', () => {
  it('snaps to standard tiers within tolerance', () => {
    expect(bucketRamGb(31.92)).toBe(32);
    expect(bucketRamGb(15.9)).toBe(16);
    expect(bucketRamGb(7.8)).toBe(8);
    expect(bucketRamGb(128)).toBe(128);
  });

  it('does not overstate an unusual capacity', () => {
    expect(bucketRamGb(6)).toBe(6);
    expect(bucketRamGb(20)).toBe(20);
  });
});

describe('signature assembly', () => {
  it('builds the documented format', () => {
    expect(
      buildSignature({ cpuToken: 'Intel_i7-14700K', gpuToken: 'RTX4070Ti', ramBucketGb: 32, driveType: 'SSD' }),
    ).toBe('Intel_i7-14700K_RTX4070Ti_32GB_SSD');
  });

  it('uses NOGPU when nothing was detected', () => {
    expect(buildSignature({ cpuToken: 'AMD_Ryzen5_5600X', gpuToken: null, ramBucketGb: 32, driveType: 'SSD' })).toBe(
      'AMD_Ryzen5_5600X_NOGPU_32GB_SSD',
    );
  });

  it('round-trips both vendors, even though the CPU token owns an underscore', () => {
    const intel = parseSignature('Intel_i7-14700K_RTX4070Ti_32GB_SSD');
    expect(intel).toEqual({ cpuToken: 'Intel_i7-14700K', gpuToken: 'RTX4070Ti', ramGb: 32, driveType: 'SSD' });

    const amd = parseSignature('AMD_Ryzen5_5600X_RTX3060_32GB_SSD');
    expect(amd).toEqual({ cpuToken: 'AMD_Ryzen5_5600X', gpuToken: 'RTX3060', ramGb: 32, driveType: 'SSD' });
  });

  it('rejects malformed signatures', () => {
    expect(parseSignature('nonsense')).toBeNull();
    expect(parseSignature('AMD_CPU_GPU_32GB')).toBeNull();
  });
});

describe('segment matching', () => {
  it('supports a single wildcard', () => {
    expect(matchSegment('Intel_i7-14*', 'Intel_i7-14700K')).toBe(true);
    expect(matchSegment('RTX4*', 'RTX4070Ti')).toBe(true);
    expect(matchSegment('rx79*', 'RX7900XTX')).toBe(true);
    expect(matchSegment('Intel_i7-14*', 'AMD_Ryzen5_5600X')).toBe(false);
  });

  it('treats regex metacharacters as literals', () => {
    // A hostile preset must not be able to inject a regex.
    expect(matchSegment('a.c', 'abc')).toBe(false);
    expect(matchSegment('a.c', 'a.c')).toBe(true);
    expect(matchSegment('.*', 'anything')).toBe(false);
  });
});
