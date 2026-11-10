import { describe, expect, it } from 'vitest';
import { GameController, type GameAdapter, type ProcessOutcome, type ProfilesSource, type SessionStore } from '../src/main/engine/game/controller';
import type { StoredGameSession } from '../src/main/engine/game/store';
import { TIMER_HOLD_PERIOD_MS, buildTimerHoldScript } from '../src/main/platform/game/timer';
import { interfaceIsActive, irqValueName, msiKeyPath } from '../src/main/platform/interrupts';
import { describeActions } from '../src/shared/game/describe';
import { evaluateGameProfile } from '../src/shared/game/policy';
import { gameProfileSchema } from '../src/shared/game/schema';
import type { CpuTopology, GameProfile } from '../src/shared/game/types';
import { compilePlan } from '../src/shared/preset/compiler';
import { evaluatePresetPolicy } from '../src/shared/preset/policy';
import { presetSchema, type Preset } from '../src/shared/preset/schema';
import type { PriorityClass } from '../src/shared/types';
import { makePreset, makeSpec } from './factories';

const LATENCY_ACTIONS = {
  deviceInterrupts: [{ deviceClass: 'gpu' }, { deviceClass: 'network' }],
  irqPriorities: [{ irq: 8, priority: 'high' }],
  network: [{ tcpAckFrequency: 1, tcpNoDelay: 1 }],
} as const;

function aggressivePreset(actionOverrides: Record<string, unknown> = {}): Preset {
  return makePreset({
    risk: 'aggressive',
    requires: { elevation: true, restorePoint: 'required' },
    profiles: [{ id: 'base', name: 'Base', actions: { ...LATENCY_ACTIONS, ...actionOverrides } }],
  });
}

function codesOf(preset: Preset): string[] {
  return evaluatePresetPolicy(preset).map((finding) => finding.code);
}

describe('latency schema', () => {
  it('accepts the new action groups', () => {
    const preset = aggressivePreset();
    expect(preset.profiles[0]?.actions.deviceInterrupts).toHaveLength(2);
    expect(preset.profiles[0]?.actions.irqPriorities).toHaveLength(1);
    expect(preset.profiles[0]?.actions.network).toHaveLength(1);
  });

  it('rejects an out-of-range IRQ number', () => {
    const parsed = makePresetSafe({ irqPriorities: [{ irq: 256, priority: 'high' }] });
    expect(parsed.success).toBe(false);
  });

  it('rejects a message limit outside 1-32', () => {
    expect(makePresetSafe({ deviceInterrupts: [{ deviceClass: 'gpu', messageLimit: 64 }] }).success).toBe(false);
  });

  it('rejects a network entry that changes nothing', () => {
    expect(makePresetSafe({ network: [{}] }).success).toBe(false);
  });
});

function makePresetSafe(actions: Record<string, unknown>) {
  // Bypass the throwing factory to assert on the failure itself.
  return presetSchema.safeParse({
    schemaVersion: 1,
    signatureVersion: 1,
    id: 'latency-schema-test',
    name: 'Latency Schema Test',
    version: '1.0.0',
    description: 'Schema-level fixture for the latency action vocabulary.',
    authors: [{ handle: 'tester' }],
    license: 'MIT',
    risk: 'aggressive',
    tags: ['gaming'],
    compatibility: {},
    profiles: [{ id: 'base', name: 'Base', actions }],
  });
}



describe('latency policy', () => {
  it('blocks latency actions below the aggressive risk level', () => {
    const moderate = makePreset({ risk: 'moderate', profiles: [{ id: 'base', name: 'Base', actions: LATENCY_ACTIONS }] });
    expect(codesOf(moderate)).toContain('preset.risk-mismatch');
  });

  it('blocks latency actions in a conservative preset', () => {
    const conservative = makePreset({ risk: 'conservative', profiles: [{ id: 'base', name: 'Base', actions: { network: [{ tcpNoDelay: 1 }] } }] });
    expect(codesOf(conservative)).toContain('preset.risk-mismatch');
  });

  it('passes a well-formed aggressive plan with a required restore point', () => {
    const findings = evaluatePresetPolicy(aggressivePreset());
    expect(findings.filter((finding) => finding.severity === 'block')).toEqual([]);
  });

  it('warns when the restore point is not required', () => {
    const preset = makePreset({
      risk: 'aggressive',
      profiles: [{ id: 'base', name: 'Base', actions: LATENCY_ACTIONS }],
    });
    expect(codesOf(preset)).toContain('interrupts.require-restore');
  });

  it('blocks a message limit the hardware cannot negotiate', () => {
    const preset = aggressivePreset({ deviceInterrupts: [{ deviceClass: 'gpu', messageLimit: 3 }] });
    expect(codesOf(preset)).toContain('interrupts.message-limit');
  });

  it('accepts negotiable message limits', () => {
    for (const limit of [1, 2, 4, 16, 32]) {
      const preset = aggressivePreset({ deviceInterrupts: [{ deviceClass: 'network', messageLimit: limit }] });
      expect(codesOf(preset)).not.toContain('interrupts.message-limit');
    }
  });

  it('warns that IRQ priority is shared and network tuning is blunt', () => {
    const found = codesOf(aggressivePreset());
    expect(found).toContain('irq-priority.shared');
    expect(found).toContain('network.blunt');
    expect(found).toContain('interrupts.enum-acl');
  });
});

describe('latency compiler', () => {
  it('emits stable keys in the Registry group, ordered after raw writes', () => {
    const preset = makePreset({
      risk: 'aggressive',
      requires: { restorePoint: 'required' },
      profiles: [
        {
          id: 'base',
          name: 'Base',
          actions: {
            registry: [
              { op: 'set', hive: 'HKCU', path: 'System\\GameConfigStore', name: 'GameDVR_Enabled', type: 'REG_DWORD', data: 0 },
            ],
            power: { plan: 'high-performance' },
            ...LATENCY_ACTIONS,
          },
        },
      ],
    });
    const plan = compilePlan(preset, makeSpec());
    const keys = plan.steps.map((step) => step.key);
    expect(keys).toContain('msi|gpu');
    expect(keys).toContain('msi|network');
    expect(keys).toContain('irq|8');
    expect(keys).toContain('network|tcp');
    for (const key of ['msi|gpu', 'msi|network', 'irq|8', 'network|tcp']) {
      expect(plan.steps.find((step) => step.key === key)?.group).toBe('Registry');
    }
    const indexOf = (key: string) => keys.indexOf(key);
    expect(indexOf('reg|hkcu\\system\\gameconfigstore\\gamedvr_enabled')).toBeLessThan(indexOf('msi|gpu'));
    expect(indexOf('msi|network')).toBeLessThan(indexOf('irq|8'));
    expect(indexOf('irq|8')).toBeLessThan(indexOf('network|tcp'));
  });

  it('labels the steps for the preview diff', () => {
    const plan = compilePlan(aggressivePreset(), makeSpec());
    const labels = new Map(plan.steps.map((step) => [step.key, step]));
    expect(labels.get('msi|gpu')?.label).toContain('MSI-X');
    expect(labels.get('irq|8')?.detail).toContain('High');
    expect(labels.get('network|tcp')?.detail).toContain('TcpAckFrequency=1');
  });
});

describe('interrupt helpers', () => {
  it('maps a PnP id onto the Enum MSI key', () => {
    const id = 'PCI\\VEN_10DE&DEV_2487&SUBSYS_397D1462&REV_A1\\4&1FC990D7&0&0019';
    expect(msiKeyPath(id)).toBe(
      `SYSTEM\\CurrentControlSet\\Enum\\${id}\\Device Parameters\\Interrupt Management\\MessageSignaledInterruptProperties`,
    );
  });

  it('names IRQ priority values conventionally', () => {
    expect(irqValueName(8)).toBe('IRQ8Priority');
  });

  it('treats only configured interfaces as active', () => {
    expect(interfaceIsActive({ dhcpIp: '192.168.1.10', hasStaticIp: false })).toBe(true);
    expect(interfaceIsActive({ dhcpIp: null, hasStaticIp: true })).toBe(true);
    expect(interfaceIsActive({ dhcpIp: '0.0.0.0', hasStaticIp: false })).toBe(false);
    expect(interfaceIsActive({ dhcpIp: null, hasStaticIp: false })).toBe(false);
    expect(interfaceIsActive({ dhcpIp: '', hasStaticIp: false })).toBe(false);
  });
});

describe('timer holder script', () => {
  it('requests 0.5 ms via NtSetTimerResolution and watches the parent', () => {
    expect(TIMER_HOLD_PERIOD_MS).toBe(0.5);
    const script = buildTimerHoldScript(1234, 0.5);
    expect(script).toContain('NtSetTimerResolution');
    expect(script).toContain('$desired = 5000');
    expect(script).toContain('$parentPid = 1234');
    expect(script).toContain('Get-Process -Id $parentPid');
  });

  it('refuses a non-numeric parent pid', () => {
    expect(() => buildTimerHoldScript(Number.NaN, 0.5)).toThrow();
    expect(() => buildTimerHoldScript(-4, 0.5)).toThrow();
  });
});

describe('game timer policy and labels', () => {
  const profile = (actions: Record<string, unknown>): GameProfile =>
    gameProfileSchema.parse({
      schemaVersion: 1,
      id: 'timer-test',
      name: 'Timer Test',
      version: '1.0.0',
      description: 'A profile used by the unit tests to exercise the timer hold.',
      authors: [{ handle: 'tester' }],
      license: 'MIT',
      risk: 'moderate',
      trigger: { exe: 'game.exe' },
      actions,
    });

  it('warns about the power cost of holding the timer', () => {
    const found = evaluateGameProfile(profile({ timerHold: true }), null).map((finding) => finding.code);
    expect(found).toContain('game.timer-hold');
  });

  it('stays silent without the hold', () => {
    const found = evaluateGameProfile(profile({}), null).map((finding) => finding.code);
    expect(found).not.toContain('game.timer-hold');
  });

  it('describes the hold in the UI labels', () => {
    expect(describeActions(profile({ timerHold: true }))).toContain('Timer: hold 0.5 ms resolution while playing');
  });
});

const TOPOLOGY: CpuTopology = {
  logicalProcessors: 8,
  physicalCores: 4,
  hybrid: false,
  efficiencyClasses: new Array<number>(8).fill(0),
  coreIndices: [0, 0, 1, 1, 2, 2, 3, 3],
  source: 'synthetic',
  higherEfficiencyIsFaster: true,
};

const TIMER_PROFILE: GameProfile = gameProfileSchema.parse({
  schemaVersion: 1,
  id: 'timer-session-test',
  name: 'Timer Session Test',
  version: '1.0.0',
  description: 'A profile used by the unit tests to exercise the timer hold session.',
  authors: [{ handle: 'tester' }],
  license: 'MIT',
  risk: 'moderate',
  trigger: { exe: 'game.exe' },
  actions: { timerHold: true },
});

class FakeTimerAdapter implements GameAdapter {
  calls: string[] = [];
  holderAlive = false;

  async topology(): Promise<CpuTopology> {
    return TOPOLOGY;
  }
  async applyAffinityAndPriority(): Promise<void> {}
  async readProcessPriority(): Promise<PriorityClass | null> {
    return 'Normal';
  }
  async setProcessPriority(): Promise<void> {}
  async suspendProcesses(): Promise<ProcessOutcome[]> {
    return [];
  }
  async resumeProcesses(): Promise<ProcessOutcome[]> {
    return [];
  }
  async purgeStandbyList(): Promise<boolean> {
    return true;
  }
  async readGpuPreference(): Promise<string | null> {
    return null;
  }
  async writeGpuPreference(): Promise<void> {}
  async restoreGpuPreference(): Promise<void> {}
  async startTimerHold(): Promise<{ stop(): Promise<void> }> {
    this.calls.push('timer:start');
    this.holderAlive = true;
    return {
      stop: async () => {
        this.calls.push('timer:stop');
        this.holderAlive = false;
      },
    };
  }
}

class FakeTimerSessions implements SessionStore {
  saved: StoredGameSession[] = [];
  private seq = 0;

  newSessionId(): string {
    this.seq += 1;
    return `timer-session-${this.seq}`;
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

function makeTimerController(adapter?: FakeTimerAdapter) {
  const realAdapter = adapter ?? new FakeTimerAdapter();
  const sessions = new FakeTimerSessions();
  const profiles: ProfilesSource = { load: async () => ({ profiles: [TIMER_PROFILE], errors: [] }) };
  const controller = new GameController({
    adapter: realAdapter,
    profiles,
    sessions,
    now: () => '2026-01-01T00:00:00.000Z',
    createWatcher: () => ({ start: () => {}, stop: () => {} }),
  });
  return { controller, adapter: realAdapter, sessions };
}

const withGame = {
  foreground: { pid: 100, exe: 'game.exe', path: 'C:\\Games\\game.exe', title: 'Game' },
  running: [{ pid: 100, exe: 'game.exe' }],
};
const idle = { foreground: null, running: [] };

describe('game timer sessions', () => {
  it('holds the timer on activation and records it', async () => {
    const { controller, adapter, sessions } = makeTimerController();
    await controller.setWatching(true);
    controller.handleSnapshot(withGame);
    await controller.settle();

    expect(adapter.calls).toContain('timer:start');
    expect(adapter.holderAlive).toBe(true);
    const saved = sessions.latest();
    expect(saved.timerHeld).toBe(true);
    expect(saved.adjustments.some((a) => a.kind === 'timer-resolution' && a.ok)).toBe(true);
  });

  it('stops the holder the moment the game exits', async () => {
    const { controller, adapter, sessions } = makeTimerController();
    await controller.setWatching(true);
    controller.handleSnapshot(withGame);
    await controller.settle();

    controller.handleSnapshot(idle);
    await controller.settle();
    controller.handleSnapshot(idle);
    await controller.settle();

    expect(adapter.calls).toContain('timer:stop');
    expect(adapter.holderAlive).toBe(false);
    expect(sessions.latest().timerHeld).toBe(false);
    expect(controller.status().phase).toBe('idle');
  });

  it('records a failed adjustment when the holder is unavailable', async () => {
    const adapter = new FakeTimerAdapter();
    const { controller, sessions } = makeTimerController(adapter);
    // Simulate a machine without the optional capability.
    (adapter as Partial<GameAdapter>).startTimerHold = undefined;
    await controller.setWatching(true);
    controller.handleSnapshot(withGame);
    await controller.settle();

    const saved = sessions.latest();
    expect(saved.timerHeld).not.toBe(true);
    const adjustment = saved.adjustments.find((a) => a.kind === 'timer-resolution');
    expect(adjustment?.ok).toBe(false);
    // Restore must still complete cleanly.
    controller.handleSnapshot(idle);
    await controller.settle();
    controller.handleSnapshot(idle);
    await controller.settle();
    expect(controller.status().phase).toBe('idle');
  });
});
