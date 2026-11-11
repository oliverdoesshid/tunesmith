import { describe, expect, it } from 'vitest';
import { describeActions } from '../src/shared/game/describe';
import { evaluateGameProfile, isBlocked } from '../src/shared/game/policy';
import { gameProfileSchema } from '../src/shared/game/schema';
import type { CpuTopology, GameProfile } from '../src/shared/game/types';

const TOPOLOGY: CpuTopology = {
  logicalProcessors: 8,
  physicalCores: 4,
  hybrid: false,
  efficiencyClasses: new Array<number>(8).fill(0),
  coreIndices: [0, 0, 1, 1, 2, 2, 3, 3],
  source: 'synthetic',
  higherEfficiencyIsFaster: true,
};

function profile(risk: 'conservative' | 'moderate' | 'aggressive'): GameProfile {
  return gameProfileSchema.parse({
    schemaVersion: 1,
    id: 'network-test',
    name: 'Network Test',
    version: '1.0.0',
    description: 'A profile used by the unit tests to exercise game network policy.',
    authors: [{ handle: 'tester' }],
    license: 'MIT',
    risk,
    trigger: { exe: 'game.exe' },
    actions: { network: { tcpAckFrequency: 1, tcpNoDelay: 1, interruptModeration: 'disabled' } },
  });
}

describe('game network profile', () => {
  it('accepts typed TCP and adapter values only', () => {
    const parsed = profile('moderate');
    expect(parsed.actions.network).toEqual({
      tcpAckFrequency: 1,
      tcpNoDelay: 1,
      interruptModeration: 'disabled',
    });
  });

  it('rejects an empty network action', () => {
    const result = gameProfileSchema.safeParse({
      schemaVersion: 1,
      id: 'empty-network',
      name: 'Empty Network',
      version: '1.0.0',
      description: 'A profile with a network action that says nothing useful at all.',
      authors: [{ handle: 'tester' }],
      license: 'MIT',
      risk: 'moderate',
      trigger: { exe: 'game.exe' },
      actions: { network: {} },
    });
    expect(result.success).toBe(false);
  });

  it('warns about network tuning and blocks it in a conservative profile', () => {
    const moderateFindings = evaluateGameProfile(profile('moderate'), TOPOLOGY);
    expect(moderateFindings.map((finding) => finding.code)).toContain('game.network-tuning');
    expect(isBlocked(moderateFindings)).toBe(false);

    const conservativeFindings = evaluateGameProfile(profile('conservative'), TOPOLOGY);
    expect(conservativeFindings.map((finding) => finding.code)).toContain('game.conservative-network');
    expect(isBlocked(conservativeFindings)).toBe(true);
  });

  it('describes the values and the interface scope', () => {
    expect(describeActions(profile('moderate'))).toContain(
      'Network: TCP ACK 1, TCP no-delay 1, NIC moderation disabled (game interface only)',
    );
  });
});
