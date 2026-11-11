import { describe, expect, it } from 'vitest';
import { GameController, type GameAdapter, type ProfilesSource, type SessionStore } from '../src/main/engine/game/controller';
import type { StoredGameSession } from '../src/main/engine/game/store';
import { adaptGameProfile, describeMachine } from '../src/shared/game/adapt';
import { gameProfileSchema } from '../src/shared/game/schema';
import type { CpuTopology, GameProfile } from '../src/shared/game/types';
import type { PriorityClass } from '../src/shared/types';
import { makeSpec } from './factories';

const TOPO4: CpuTopology = {
  logicalProcessors: 4,
  physicalCores: 2,
  hybrid: false,
  efficiencyClasses: [0, 0, 0, 0],
  coreIndices: [0, 0, 1, 1],
  source: 'synthetic',
  higherEfficiencyIsFaster: true,
};

const TOPO8: CpuTopology = {
  ...TOPO4,
  logicalProcessors: 8,
  physicalCores: 4,
  efficiencyClasses: new Array<number>(8).fill(0),
  coreIndices: [0, 0, 1, 1, 2, 2, 3, 3],
};

const TOPO16: CpuTopology = {
  ...TOPO4,
  logicalProcessors: 16,
  physicalCores: 8,
  efficiencyClasses: new Array<number>(16).fill(0),
  coreIndices: Array.from({ length: 16 }, (_, index) => Math.floor(index / 2)),
};

function lowSpec() {
  const base = makeSpec();
  return makeSpec({
    cpu: { ...base.cpu, cores: 2, threads: 4 },
    memory: { ...base.memory, bucketGb: 8, totalGb: 7.9 },
    primaryGpu: base.primaryGpu === null ? null : { ...base.primaryGpu, kind: 'integrated' },
  });
}

function highSpec() {
  const base = makeSpec();
  return makeSpec({
    cpu: { ...base.cpu, cores: 10, threads: 20 },
    memory: { ...base.memory, bucketGb: 64, totalGb: 63.9 },
    primaryGpu: base.primaryGpu === null ? null : { ...base.primaryGpu, kind: 'discrete' },
  });
}

function profile(overrides: Record<string, unknown> = {}): GameProfile {
  return gameProfileSchema.parse({
    schemaVersion: 1,
    id: 'adapt-game',
    name: 'Adaptive Game',
    version: '1.0.0',
    description: 'A profile used to exercise per-machine adaptation rules.',
    authors: [{ handle: 'tester' }],
    license: 'MIT',
    risk: 'moderate',
    trigger: { exe: 'game.exe' },
    actions: {
      affinity: { strategy: 'performance-cores' },
      priority: 'High',
      gpuPreference: 'high-performance',
      timerHold: true,
      backgroundRules: [
        { process: 'chrome.exe', action: 'suspend' },
        { process: 'msedge.exe', action: 'suspend' },
        { process: 'firefox.exe', action: 'suspend' },
        { process: 'opera.exe', action: 'lower-priority', priority: 'Idle' },
      ],
    },
    ...overrides,
  });
}

describe('machine description', () => {
  it('classifies a small integrated machine as low tier', () => {
    const machine = describeMachine(lowSpec(), TOPO4);
    expect(machine.tier).toBe('low');
    expect(machine.logicalProcessors).toBe(4);
    expect(machine.memoryGb).toBe(8);
    expect(machine.gpuKind).toBe('integrated');
  });

  it('classifies a large discrete machine as high tier', () => {
    const machine = describeMachine(highSpec(), TOPO16);
    expect(machine.tier).toBe('high');
    expect(machine.logicalProcessors).toBe(20);
    expect(machine.gpuKind).toBe('discrete');
  });

  it('falls back to topology when hardware detection is unavailable', () => {
    expect(describeMachine(null, TOPO4).tier).toBe('low');
    expect(describeMachine(null, TOPO8).tier).toBe('mid');
    expect(describeMachine(null, TOPO16).gpuKind).toBe('unknown');
  });

  it('does not invent facts for an unknown machine', () => {
    const machine = describeMachine(null, TOPO8);
    expect(machine.memoryGb).toBeNull();
    expect(machine.reasons.join(' ')).toContain('RAM tier unknown');
  });
});

describe('profile adaptation', () => {
  it('narrows an aggressive profile on a 4-thread, 8 GB machine', () => {
    const machine = describeMachine(lowSpec(), TOPO4);
    const { actions, changes } = adaptGameProfile(profile(), machine);

    expect(actions.affinity).toEqual({ strategy: 'all-cores' });
    expect(actions.timerHold).toBe(false);
    expect(actions.gpuPreference).toBeUndefined();
    expect(actions.backgroundRules?.filter((rule) => rule.action === 'suspend')).toHaveLength(2);
    // Non-suspend rules survive.
    expect(actions.backgroundRules?.some((rule) => rule.process === 'opera.exe')).toBe(true);
    expect(changes.map((change) => change.code).sort()).toEqual([
      'affinity-all-cores',
      'gpu-preference-skip',
      'suspend-cap',
      'timer-hold-off',
    ]);
  });

  it('leaves a mid-range machine alone apart from the suspend budget', () => {
    const machine = describeMachine(
      makeSpec({
        cpu: { ...makeSpec().cpu, cores: 4, threads: 8 },
        memory: { ...makeSpec().memory, bucketGb: 16 },
      }),
      TOPO8,
    );
    const { actions, changes } = adaptGameProfile(profile(), machine);

    expect(machine.tier).toBe('mid');
    expect(actions.affinity).toEqual({ strategy: 'performance-cores' });
    expect(actions.timerHold).toBe(true);
    expect(actions.gpuPreference).toBe('high-performance');
    expect(changes).toEqual([]);
  });

  it('keeps the profile intact on a high-tier machine', () => {
    const { actions, changes } = adaptGameProfile(profile(), describeMachine(highSpec(), TOPO16));
    expect(actions).toEqual(profile().actions);
    expect(changes).toEqual([]);
  });

  it('keeps a GPU preference when the GPU kind is unknown', () => {
    const machine = describeMachine(null, TOPO8);
    expect(adaptGameProfile(profile(), machine).actions.gpuPreference).toBe('high-performance');
  });
});

/* ------------------------------------------------------------------ *
 * Controller integration
 * ------------------------------------------------------------------ */

const GAME_PATH = 'C:\\Games\\game.exe';

class FakeAdapter implements GameAdapter {
  affinityMasks: string[] = [];
  timerStarts = 0;
  gpuWrites = 0;
  suspended: number[] = [];

  async topology(): Promise<CpuTopology> {
    return TOPO4;
  }
  async applyAffinityAndPriority(pid: number, maskHex: string): Promise<void> {
    this.affinityMasks.push(`${pid}:${maskHex}`);
  }
  async readProcessPriority(): Promise<PriorityClass | null> {
    return 'Normal';
  }
  async setProcessPriority(): Promise<void> {}
  async suspendProcesses(pids: readonly number[]): Promise<{ pid: number; ok: boolean }[]> {
    this.suspended.push(...pids);
    return pids.map((pid) => ({ pid, ok: true }));
  }
  async resumeProcesses(pids: readonly number[]): Promise<{ pid: number; ok: boolean }[]> {
    return pids.map((pid) => ({ pid, ok: true }));
  }
  async startTimerHold(): Promise<{ stop(): Promise<void> }> {
    this.timerStarts += 1;
    return { stop: async () => undefined };
  }
  async purgeStandbyList(): Promise<boolean> {
    return true;
  }
  async readGpuPreference(): Promise<string | null> {
    return null;
  }
  async writeGpuPreference(): Promise<void> {
    this.gpuWrites += 1;
  }
  async restoreGpuPreference(): Promise<void> {}
}

class FakeSessions implements SessionStore {
  saved: StoredGameSession[] = [];
  private seq = 0;

  newSessionId(): string {
    this.seq += 1;
    return `adapted-${this.seq}`;
  }
  async save(session: StoredGameSession): Promise<void> {
    this.saved.push(structuredClone(session));
  }
  async pending(): Promise<StoredGameSession[]> {
    return [];
  }
}

const SNAPSHOT = {
  foreground: { pid: 100, exe: 'game.exe', path: GAME_PATH, title: 'Adaptive Game' },
  running: [
    { pid: 100, exe: 'game.exe' },
    { pid: 201, exe: 'chrome.exe' },
    { pid: 202, exe: 'msedge.exe' },
    { pid: 203, exe: 'firefox.exe' },
  ],
};

describe('controller activation uses the adapted actions', () => {
  it('applies all cores, skips the timer hold and caps suspensions on a low-tier machine', async () => {
    const adapter = new FakeAdapter();
    const sessions = new FakeSessions();
    const profiles: ProfilesSource = { load: async () => ({ profiles: [profile()], errors: [] }) };
    const controller = new GameController({
      adapter,
      profiles,
      sessions,
      hardware: lowSpec(),
      now: () => '2026-01-01T00:00:00.000Z',
      nowMs: () => 1_000,
      createWatcher: () => ({ start: () => {}, stop: () => {} }),
    });

    await controller.start();
    await controller.setWatching(true);
    controller.handleSnapshot(SNAPSHOT);
    await controller.settle();

    const status = controller.status();
    expect(status.active).not.toBeNull();
    expect(adapter.affinityMasks).toEqual(['100:0xF']);
    expect(adapter.timerStarts).toBe(0);
    expect(adapter.gpuWrites).toBe(0);
    expect(adapter.suspended).toHaveLength(2);

    const saved = sessions.saved[sessions.saved.length - 1];
    const adaptation = saved?.adjustments.filter((adjustment) => adjustment.kind === 'adaptation') ?? [];
    expect(adaptation.length).toBeGreaterThanOrEqual(3);
    expect(adaptation.some((adjustment) => adjustment.target === 'affinity')).toBe(true);
    expect(adaptation.some((adjustment) => adjustment.target === 'global timer')).toBe(true);
  });

  it('leaves an 8-thread machine on its authored affinity and timer settings', async () => {
    const adapter = new FakeAdapter();
    adapter.topology = async () => TOPO8;
    const sessions = new FakeSessions();
    const profiles: ProfilesSource = { load: async () => ({ profiles: [profile()], errors: [] }) };
    const controller = new GameController({
      adapter,
      profiles,
      sessions,
      hardware: makeSpec({
        cpu: { ...makeSpec().cpu, cores: 4, threads: 8 },
        memory: { ...makeSpec().memory, bucketGb: 16 },
      }),
      now: () => '2026-01-01T00:00:00.000Z',
      nowMs: () => 1_000,
      createWatcher: () => ({ start: () => {}, stop: () => {} }),
    });

    await controller.start();
    await controller.setWatching(true);
    controller.handleSnapshot(SNAPSHOT);
    await controller.settle();

    expect(adapter.affinityMasks).toHaveLength(1);
    expect(adapter.affinityMasks[0]?.endsWith(':0xF')).toBe(false);
    expect(adapter.timerStarts).toBe(1);
    const saved = sessions.saved[sessions.saved.length - 1];
    expect(saved?.adjustments.some((adjustment) => adjustment.kind === 'adaptation')).toBe(false);
  });
});
