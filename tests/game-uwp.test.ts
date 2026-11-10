import { describe, expect, it } from 'vitest';
import { GameController, type GameAdapter } from '../src/main/engine/game/controller';
import type { StoredGameSession } from '../src/main/engine/game/store';
import type { WatcherOptions } from '../src/main/platform/game/watcher';
import { matchTrigger } from '../src/shared/game/matcher';
import { evaluateGameProfile, isBlocked, packageList } from '../src/shared/game/policy';
import { gameProfileSchema } from '../src/shared/game/schema';
import type { CpuTopology } from '../src/shared/game/types';

const PFN = 'Microsoft.SunriseBaseGame_8wekyb3d8bbwe';

const TOPOLOGY: CpuTopology = {
  logicalProcessors: 8,
  totalLogicalProcessors: 8,
  groups: [{ index: 0, count: 8, mask: '0xFF' }],
  physicalCores: 8,
  hybrid: false,
  efficiencyClasses: new Array<number>(8).fill(0),
  coreIndices: [0, 1, 2, 3, 4, 5, 6, 7],
  source: 'synthetic',
  higherEfficiencyIsFaster: true,
};

/** 128 logical processors split into two 64-processor groups. */
const DUAL_GROUP: CpuTopology = {
  ...TOPOLOGY,
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

function makeProfile(overrides: Record<string, unknown> = {}) {
  return gameProfileSchema.parse({
    schemaVersion: 1,
    id: 'store-title',
    name: 'Store Title',
    version: '1.0.0',
    description: 'A packaged title used by the unit tests to exercise UWP targeting.',
    authors: [{ handle: 'tester' }],
    license: 'MIT',
    risk: 'moderate',
    trigger: { packageFamilyName: PFN },
    actions: { priority: 'High' },
    ...overrides,
  });
}

describe('packaged (UWP) triggers', () => {
  it('accepts a package family name with no executable', () => {
    const profile = makeProfile();
    expect(profile.trigger.exe).toBeUndefined();
    expect(profile.trigger.packageFamilyName).toBe(PFN);
  });

  it('requires at least one identity', () => {
    expect(() => makeProfile({ trigger: {} })).toThrow(/executable name, a package family name/i);
  });

  it('rejects an install-path filter alongside a package identity', () => {
    expect(() => makeProfile({ trigger: { packageFamilyName: PFN, pathPrefix: 'C:\\Games' } })).toThrow(
      /install-path filter needs an executable/i,
    );
  });

  it('rejects a package family name that could be a path', () => {
    expect(() => makeProfile({ trigger: { packageFamilyName: '../../evil' } })).toThrow();
  });
});

describe('packaged trigger matching', () => {
  it('matches on package identity even when the image name differs', () => {
    const profile = makeProfile();
    const result = matchTrigger(profile, {
      pid: 10,
      exe: 'launcherchild.exe',
      packageFamilyName: PFN,
    });
    expect(result.matched).toBe(true);
    expect(result.reason).toContain(PFN);
  });

  it('refuses an unpackaged foreground process for a package-only profile', () => {
    const profile = makeProfile();
    const result = matchTrigger(profile, { pid: 10, exe: 'game.exe' });
    expect(result.matched).toBe(false);
    expect(result.reason).toMatch(/no package identity/i);
  });

  it('does not match an unrelated package', () => {
    const result = matchTrigger(makeProfile(), { pid: 10, exe: 'x.exe', packageFamilyName: 'Other.Game_abc' });
    expect(result.matched).toBe(false);
  });

  it('accepts either identity when a profile declares both', () => {
    const profile = makeProfile({ trigger: { exe: 'game.exe', packageFamilyName: PFN } });
    expect(matchTrigger(profile, { pid: 1, exe: 'game.exe' }).matched).toBe(true);
    expect(matchTrigger(profile, { pid: 1, exe: 'other.exe', packageFamilyName: PFN }).matched).toBe(true);
    expect(matchTrigger(profile, { pid: 1, exe: 'other.exe', packageFamilyName: 'X.Y_z' }).matched).toBe(false);
  });
});

describe('multi-group and packaged policy', () => {
  it('no longer refuses machines above 64 logical processors', () => {
    const findings = evaluateGameProfile(makeProfile({ actions: { affinity: { strategy: 'all-cores' } } }), DUAL_GROUP);
    expect(isBlocked(findings)).toBe(false);
    expect(findings.some((finding) => finding.code === 'game.processor-groups')).toBe(false);
  });

  it('accepts a custom affinity index that lives in the second group', () => {
    const findings = evaluateGameProfile(
      makeProfile({ actions: { affinity: { strategy: 'custom', cores: [0, 64] } } }),
      DUAL_GROUP,
    );
    expect(isBlocked(findings)).toBe(false);
  });

  it('warns that a GPU preference cannot be applied to a package', () => {
    const findings = evaluateGameProfile(makeProfile({ actions: { gpuPreference: 'high-performance' } }), TOPOLOGY);
    expect(findings.some((finding) => finding.code === 'game.packaged-gpu')).toBe(true);
  });

  it('lists package family names for the watcher', () => {
    expect(packageList([makeProfile()])).toEqual([PFN]);
  });
});

describe('controller package activation', () => {
  it('watches resolved executables and skips the GPU preference', async () => {
    const saved: StoredGameSession[] = [];
    const captured: { options: WatcherOptions | null } = { options: null };

    const adapter: GameAdapter = {
      topology: async () => TOPOLOGY,
      applyAffinityAndPriority: async () => undefined,
      readProcessPriority: async () => 'Normal',
      setProcessPriority: async () => undefined,
      suspendProcesses: async () => [],
      resumeProcesses: async () => [],
      purgeStandbyList: async () => false,
      readGpuPreference: async () => null,
      writeGpuPreference: async () => undefined,
      restoreGpuPreference: async () => undefined,
      resolvePackage: async (familyName) => ({
        familyName,
        installLocation: 'C:\\Program Files\\WindowsApps\\Game',
        executables: ['game.exe'],
        capabilities: ['internetClient'],
        signatureKind: 'Store',
      }),
    };

    const controller = new GameController({
      adapter,
      profiles: {
        load: async () => ({
          profiles: [makeProfile({ actions: { gpuPreference: 'high-performance' } })],
          errors: [],
        }),
      },
      sessions: {
        newSessionId: () => 'session-1',
        save: async (session) => {
          const index = saved.findIndex((entry) => entry.id === session.id);
          if (index >= 0) saved[index] = session;
          else saved.push(session);
        },
        pending: async () => [],
      },
      createWatcher: (options) => {
        captured.options = options;
        return { start: () => undefined, stop: () => undefined };
      },
    });

    await controller.setWatching(true);
    const options = captured.options;
    expect(options).not.toBeNull();
    if (options === null) throw new Error('watcher was not created');

    expect(options.watchNames).toContain('game.exe');

    options.onSnapshot({
      foreground: { pid: 4242, exe: 'game.exe', path: null, title: 'Store Title', packageFamilyName: PFN },
      running: [],
    });
    await controller.settle();

    const status = controller.status();
    expect(status.active?.profileId).toBe('store-title');
    expect(status.packages[0]?.capabilities).toEqual(['internetClient']);

    const gpu = status.active?.adjustments.find((entry) => entry.kind === 'gpu-preference');
    expect(gpu?.ok).toBe(false);
    expect(gpu?.error).toMatch(/no per-app GPU preference/i);
  });
});
