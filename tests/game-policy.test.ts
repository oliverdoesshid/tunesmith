import { describe, expect, it } from 'vitest';
import { evaluateGameProfile, isBlocked, watchList } from '../src/shared/game/policy';
import { gameProfileSchema } from '../src/shared/game/schema';
import { describeActions } from '../src/shared/game/describe';
import type { CpuTopology, GameProfile } from '../src/shared/game/types';

const TOPOLOGY: CpuTopology = {
  logicalProcessors: 8,
  physicalCores: 8,
  hybrid: true,
  efficiencyClasses: [1, 1, 1, 1, 0, 0, 0, 0],
  coreIndices: [0, 1, 2, 3, 4, 5, 6, 7],
  source: 'cpuset',
  higherEfficiencyIsFaster: true,
};

function makeProfile(overrides: { exe?: string; actions?: Record<string, unknown>; risk?: string } = {}): GameProfile {
  return gameProfileSchema.parse({
    schemaVersion: 1,
    id: 'test-game',
    name: 'Test Game',
    version: '1.0.0',
    description: 'A profile used by the unit tests to exercise game policy rules.',
    authors: [{ handle: 'tester' }],
    license: 'MIT',
    risk: overrides.risk ?? 'moderate',
    trigger: { exe: overrides.exe ?? 'game.exe' },
    actions: overrides.actions ?? {},
  });
}

const codes = (findings: ReturnType<typeof evaluateGameProfile>): string[] => findings.map((finding) => finding.code);

describe('game profile policy', () => {
  it('blocks suspending the shell', () => {
    const findings = evaluateGameProfile(
      makeProfile({ actions: { backgroundRules: [{ process: 'explorer.exe', action: 'suspend' }] } }),
      TOPOLOGY,
    );
    expect(codes(findings)).toContain('game.protected-background');
    expect(isBlocked(findings)).toBe(true);
  });

  it('blocks a Windows system process as the game trigger', () => {
    const findings = evaluateGameProfile(makeProfile({ exe: 'csrss.exe' }), TOPOLOGY);
    expect(codes(findings)).toContain('game.protected-trigger');
    expect(isBlocked(findings)).toBe(true);
  });

  it('refuses suspension in a conservative profile', () => {
    const findings = evaluateGameProfile(
      makeProfile({ risk: 'conservative', actions: { backgroundRules: [{ process: 'chrome.exe', action: 'suspend' }] } }),
      TOPOLOGY,
    );
    expect(codes(findings)).toContain('game.conservative-suspend');
    expect(isBlocked(findings)).toBe(true);
  });

  it('warns instead of blocking when suspending a launcher', () => {
    const findings = evaluateGameProfile(
      makeProfile({ actions: { backgroundRules: [{ process: 'steam.exe', action: 'suspend' }] } }),
      TOPOLOGY,
    );
    expect(codes(findings)).toContain('game.caution-suspend');
    expect(isBlocked(findings)).toBe(false);
  });

  it('warns about memory flushing and a power-saving GPU choice', () => {
    const findings = evaluateGameProfile(
      makeProfile({ actions: { flushStandbyMemory: true, gpuPreference: 'power-saving' } }),
      TOPOLOGY,
    );
    expect(codes(findings)).toContain('game.memory-flush');
    expect(codes(findings)).toContain('game.power-saving-gpu');
    expect(isBlocked(findings)).toBe(false);
  });

  it('blocks affinity indices that do not exist on this machine', () => {
    const findings = evaluateGameProfile(
      makeProfile({ actions: { affinity: { strategy: 'custom', cores: [2, 20] } } }),
      TOPOLOGY,
    );
    expect(codes(findings)).toContain('game.invalid-affinity');
  });

  it('warns when performance cores are requested on a non-hybrid CPU', () => {
    const findings = evaluateGameProfile(makeProfile({ actions: { affinity: { strategy: 'performance-cores' } } }), {
      ...TOPOLOGY,
      hybrid: false,
      efficiencyClasses: new Array<number>(8).fill(0),
    });
    expect(codes(findings)).toContain('game.not-hybrid');
    expect(isBlocked(findings)).toBe(false);
  });

  it('collects every image name the watcher must report', () => {
    const profile = makeProfile({
      actions: { backgroundRules: [{ process: 'chrome.exe', action: 'lower-priority', priority: 'Idle' }] },
    });
    expect(watchList([profile])).toEqual(['chrome.exe', 'game.exe']);
  });

  it('describes actions for the UI', () => {
    const labels = describeActions(
      makeProfile({
        actions: {
          affinity: { strategy: 'performance-cores' },
          priority: 'High',
          gpuPreference: 'high-performance',
          backgroundRules: [
            { process: 'chrome.exe', action: 'suspend' },
            { process: 'steam.exe', action: 'lower-priority', priority: 'BelowNormal' },
          ],
        },
      }),
    );
    expect(labels).toContain('Affinity: Performance cores only');
    expect(labels).toContain('Priority: High');
    expect(labels).toContain('Background: 1 suspended, 1 lowered');
  });
});
