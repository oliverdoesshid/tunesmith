import { describe, expect, it } from 'vitest';
import {
  GameController,
  type GameAdapter,
  type ProcessOutcome,
  type ProfilesSource,
  type SessionStore,
} from '../src/main/engine/game/controller';
import type { StoredGameSession } from '../src/main/engine/game/store';
import { planInterruptAffinity, interruptMaskBytes } from '../src/shared/game/interrupt-affinity';
import { gameProfileSchema } from '../src/shared/game/schema';
import type {
  CpuTopology,
  GameInterruptAffinityDevice,
  GameInterruptAffinitySnapshot,
  GameProfile,
} from '../src/shared/game/types';
import type { PriorityClass } from '../src/shared/types';

const HYBRID: CpuTopology = {
  logicalProcessors: 8,
  physicalCores: 4,
  hybrid: true,
  efficiencyClasses: [1, 0, 1, 0, 1, 0, 1, 0],
  coreIndices: [0, 0, 1, 1, 2, 2, 3, 3],
  source: 'synthetic',
  higherEfficiencyIsFaster: true,
};

const SMT: CpuTopology = {
  ...HYBRID,
  hybrid: false,
  efficiencyClasses: new Array<number>(8).fill(0),
};

const DEVICE: GameInterruptAffinityDevice = {
  instanceId: 'PCI\\VEN_10DE&DEV_2504\\4&12345678&0&0008',
  kind: 'gpu',
  label: 'Test GPU',
  service: 'nvlddmkm',
};

function snapshot(mask = '0x55'): GameInterruptAffinitySnapshot {
  return {
    capturedAt: '2026-01-01T00:00:00.000Z',
    mask,
    cores: [0, 2, 4, 6],
    devices: [
      {
        device: DEVICE,
        policy: { existed: false },
        assignment: { existed: false },
      },
    ],
  };
}

class FakeAdapter implements GameAdapter {
  calls: string[] = [];
  applied: GameInterruptAffinitySnapshot | null = null;
  restored: GameInterruptAffinitySnapshot | null = null;

  async topology(): Promise<CpuTopology> {
    return HYBRID;
  }
  async applyAffinityAndPriority(): Promise<void> {}
  async readProcessPriority(): Promise<PriorityClass | null> {
    return 'Normal';
  }
  async setProcessPriority(): Promise<void> {}
  async suspendProcesses(pids: readonly number[]): Promise<ProcessOutcome[]> {
    return pids.map((pid) => ({ pid, ok: true }));
  }
  async resumeProcesses(pids: readonly number[]): Promise<ProcessOutcome[]> {
    return pids.map((pid) => ({ pid, ok: true }));
  }
  async purgeStandbyList(): Promise<boolean> {
    return true;
  }
  async readGpuPreference(): Promise<string | null> {
    return null;
  }
  async writeGpuPreference(): Promise<void> {}
  async restoreGpuPreference(): Promise<void> {}
  async inspectInterruptAffinity(): Promise<GameInterruptAffinityDevice[]> {
    this.calls.push('inspect');
    return [DEVICE];
  }
  async captureInterruptAffinity(
    _devices: readonly GameInterruptAffinityDevice[],
    plan: { mask: string },
  ): Promise<GameInterruptAffinitySnapshot> {
    this.calls.push(`capture:${plan.mask}`);
    return snapshot(plan.mask);
  }
  async applyInterruptAffinity(value: GameInterruptAffinitySnapshot) {
    this.calls.push(`apply:${value.mask}`);
    this.applied = value;
    return { ok: true, applied: 1, skipped: 0, message: 'staged' };
  }
  async restoreInterruptAffinity(value: GameInterruptAffinitySnapshot): Promise<string[]> {
    this.calls.push(`restore:${value.mask}`);
    this.restored = value;
    return [];
  }
}

class FakeSessions implements SessionStore {
  saved: StoredGameSession[] = [];
  private seq = 0;

  newSessionId(): string {
    this.seq += 1;
    return `irq-session-${this.seq}`;
  }
  async save(session: StoredGameSession): Promise<void> {
    this.saved.push(structuredClone(session));
  }
  async pending(): Promise<StoredGameSession[]> {
    return [];
  }
  latest(): StoredGameSession {
    const last = this.saved[this.saved.length - 1];
    if (last === undefined) throw new Error('nothing saved');
    return last;
  }
}

function profile(): GameProfile {
  return gameProfileSchema.parse({
    schemaVersion: 1,
    id: 'irq-test',
    name: 'IRQ Test',
    version: '1.0.0',
    description: 'A profile used by the unit tests to exercise interrupt-affinity staging.',
    authors: [{ handle: 'tester' }],
    license: 'MIT',
    risk: 'moderate',
    trigger: { exe: 'game.exe' },
    actions: {},
  });
}

function makeController() {
  const adapter = new FakeAdapter();
  const sessions = new FakeSessions();
  const profiles: ProfilesSource = { load: async () => ({ profiles: [profile()], errors: [] }) };
  const controller = new GameController({
    adapter,
    profiles,
    sessions,
    now: () => '2026-01-01T00:00:00.000Z',
    createWatcher: () => ({ start: () => {}, stop: () => {} }),
  });
  return { adapter, sessions, controller };
}

const game = { pid: 100, exe: 'game.exe' };

describe('interrupt-affinity planning', () => {
  it('selects one logical processor per physical performance core', () => {
    const result = planInterruptAffinity(HYBRID);
    expect(result.plan).not.toBeNull();
    expect(result.plan?.cores).toEqual([0, 2, 4, 6]);
    expect(result.plan?.mask).toBe('0x55');
    expect(result.plan?.maskBytes).toEqual([0x55, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('uses one thread per physical core on a non-hybrid CPU', () => {
    expect(planInterruptAffinity(SMT).plan?.cores).toEqual([0, 2, 4, 6]);
  });

  it('refuses multi-group machines instead of guessing a group', () => {
    const dual = {
      ...SMT,
      groups: [
        { index: 0, count: 4, mask: '0xF' },
        { index: 1, count: 4, mask: '0xF' },
      ],
      totalLogicalProcessors: 8,
    };
    expect(planInterruptAffinity(dual).plan).toBeNull();
    expect(planInterruptAffinity(dual).reason).toMatch(/multiple processor groups/i);
  });

  it('builds a little-endian 64-bit mask', () => {
    expect(interruptMaskBytes([0, 8, 15, 63])).toEqual([0x01, 0x81, 0, 0, 0, 0, 0, 0x80]);
  });
});

describe('interrupt-affinity sessions', () => {
  it('captures, persists and stages the policy, then restores it on exit', async () => {
    const { adapter, sessions, controller } = makeController();
    await controller.setInterruptAffinity(true);
    await controller.setWatching(true);

    controller.handleSnapshot({ foreground: game, running: [game] });
    await controller.settle();

    expect(adapter.calls.slice(0, 3)).toEqual(['inspect', 'capture:0x55', 'apply:0x55']);
    expect(sessions.latest().interruptAffinity).toEqual(snapshot('0x55'));
    expect(controller.status().active?.adjustments.some((entry) => entry.kind === 'interrupt-affinity')).toBe(true);

    controller.handleSnapshot({ foreground: null, running: [] });
    await controller.settle();
    controller.handleSnapshot({ foreground: null, running: [] });
    await controller.settle();

    expect(adapter.calls).toContain('restore:0x55');
    expect(adapter.restored).toEqual(snapshot('0x55'));
    expect(controller.status().phase).toBe('idle');
  });

  it('does nothing while the setting is off', async () => {
    const { adapter, controller } = makeController();
    await controller.setWatching(true);

    controller.handleSnapshot({ foreground: game, running: [game] });
    await controller.settle();

    expect(adapter.calls).toEqual([]);
    expect(controller.status().interruptAffinity).toBe(false);
  });

  it('refuses to change the setting during an active session', async () => {
    const { controller } = makeController();
    await controller.setInterruptAffinity(true);
    await controller.setWatching(true);
    controller.handleSnapshot({ foreground: game, running: [game] });
    await controller.settle();

    await expect(controller.setInterruptAffinity(false)).rejects.toThrow('Restore the active game session');
  });

  it('records an honest skip when no device is eligible', async () => {
    const { adapter, controller } = makeController();
    adapter.inspectInterruptAffinity = async () => [];
    await controller.setInterruptAffinity(true);
    await controller.setWatching(true);

    controller.handleSnapshot({ foreground: game, running: [game] });
    await controller.settle();

    expect(adapter.calls).toEqual([]);
    expect(controller.status().active?.adjustments.at(-1)?.error).toMatch(/No physical GPU|No eligible device/i);
  });
});
