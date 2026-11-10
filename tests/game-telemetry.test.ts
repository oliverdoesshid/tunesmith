import { describe, expect, it } from 'vitest';
import { GameController, type GameAdapter, type ProfilesSource, type SessionStore } from '../src/main/engine/game/controller';
import type { StoredGameSession } from '../src/main/engine/game/store';
import { normaliseTelemetry } from '../src/main/platform/game/telemetry';
import { evaluateGameProfile } from '../src/shared/game/policy';
import { gameProfileSchema } from '../src/shared/game/schema';
import { evaluateGuards } from '../src/shared/game/telemetry';
import type { CpuTopology, GameProfile, TelemetrySample } from '../src/shared/game/types';
import type { PriorityClass } from '../src/shared/types';

const TOPOLOGY: CpuTopology = {
  logicalProcessors: 8,
  physicalCores: 4,
  hybrid: false,
  efficiencyClasses: new Array<number>(8).fill(0),
  coreIndices: [0, 0, 1, 1, 2, 2, 3, 3],
  source: 'synthetic',
  higherEfficiencyIsFaster: true,
};

function sample(overrides: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    at: '2026-01-01T00:00:00.000Z',
    cpuTempC: 70,
    cpuTempSource: 'acpi-thermal-zone',
    gpuTempC: 65,
    gpuTempSource: 'nvidia-smi',
    powerDrawW: null,
    powerSource: 'none',
    onAc: true,
    batteryPercent: null,
    ...overrides,
  };
}

const PROFILE: GameProfile = gameProfileSchema.parse({
  schemaVersion: 1,
  id: 'guarded-game',
  name: 'Guarded Game',
  version: '1.0.0',
  description: 'A profile with thermal guards, used to exercise restore and cooldown.',
  authors: [{ handle: 'tester' }],
  license: 'MIT',
  risk: 'moderate',
  trigger: { exe: 'game.exe' },
  actions: { priority: 'High' },
  guards: { maxCpuTempC: 85, maxGpuTempC: 87, sampleSeconds: 5, cooldownSeconds: 120 },
});

describe('thermal guard evaluation', () => {
  it('passes below the limit and reports what it checked', () => {
    const outcome = evaluateGuards({ maxCpuTempC: 85 }, sample({ cpuTempC: 70 }));
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.checked).toEqual(['CPU 70°C']);
      expect(outcome.missing).toEqual([]);
    }
  });

  it('trips at exactly the limit, not only above it', () => {
    const outcome = evaluateGuards({ maxCpuTempC: 85 }, sample({ cpuTempC: 85 }));
    expect(outcome.status).toBe('trip');
    if (outcome.status === 'trip') expect(outcome.reason).toEqual({ kind: 'cpu-temp', valueC: 85, limitC: 85 });
  });

  it('trips on GPU temperature', () => {
    const outcome = evaluateGuards({ maxGpuTempC: 87 }, sample({ gpuTempC: 91.4 }));
    expect(outcome.status).toBe('trip');
    if (outcome.status === 'trip') expect(outcome.reason.kind).toBe('gpu-temp');
  });

  it('restores when the machine drops to battery', () => {
    const outcome = evaluateGuards({ onBattery: 'restore' }, sample({ onAc: false, batteryPercent: 41 }));
    expect(outcome.status).toBe('trip');
    if (outcome.status === 'trip') {
      expect(outcome.reason).toEqual({ kind: 'on-battery', batteryPercent: 41 });
      expect(outcome.message).toContain('41%');
    }
  });

  it('ignores battery when the profile says so', () => {
    expect(evaluateGuards({ onBattery: 'ignore' }, sample({ onAc: false })).status).toBe('ok');
  });

  it('reports an unenforceable guard instead of passing it', () => {
    const outcome = evaluateGuards({ maxCpuTempC: 85 }, sample({ cpuTempC: null, cpuTempSource: 'none' }));
    expect(outcome.status).toBe('unavailable');
    if (outcome.status === 'unavailable') expect(outcome.message).toContain('CPU temperature');
  });

  it('enforces the readable half and reports the missing half', () => {
    const outcome = evaluateGuards({ maxCpuTempC: 85, maxGpuTempC: 87 }, sample({ gpuTempC: null }));
    expect(outcome.status).toBe('ok');
    if (outcome.status === 'ok') {
      expect(outcome.missing).toEqual(['GPU temperature']);
    }
  });

  it('trips on the CPU even when the GPU sensor is missing', () => {
    const outcome = evaluateGuards({ maxCpuTempC: 85, maxGpuTempC: 87 }, sample({ cpuTempC: 96, gpuTempC: null }));
    expect(outcome.status).toBe('trip');
  });

  it('does nothing when no condition is configured', () => {
    expect(evaluateGuards({ sampleSeconds: 10 }, sample())).toEqual({ status: 'ok', checked: [], missing: [] });
    expect(evaluateGuards(undefined, null)).toEqual({ status: 'ok', checked: [], missing: [] });
  });
});

describe('telemetry normalisation', () => {
  it('prefers a hardware monitor over every fallback', () => {
    const result = normaliseTelemetry({
      onAc: true,
      lhm: { cpuTempC: 63.4, gpuTempC: 58, powerDrawW: 88.2 },
      ohm: { cpuTempC: 70, gpuTempC: 70, powerDrawW: 99 },
      acpiCpuTempC: 41,
      nvidiaGpuTempC: 75,
    });
    expect(result.cpuTempC).toBe(63.4);
    expect(result.cpuTempSource).toBe('libre-hardware-monitor');
    expect(result.gpuTempC).toBe(58);
    expect(result.gpuTempSource).toBe('libre-hardware-monitor');
    expect(result.powerDrawW).toBe(88.2);
    expect(result.powerSource).toBe('libre-hardware-monitor');
  });

  it('falls back through OpenHardwareMonitor, ACPI zones and the zone counter', () => {
    expect(normaliseTelemetry({ ohm: { cpuTempC: 60 }, acpiCpuTempC: 45 }).cpuTempSource).toBe('open-hardware-monitor');
    expect(normaliseTelemetry({ acpiCpuTempC: 45, counterCpuTempC: 50 }).cpuTempSource).toBe('acpi-thermal-zone');
    expect(normaliseTelemetry({ counterCpuTempC: 50 }).cpuTempSource).toBe('thermal-zone-counter');
    expect(normaliseTelemetry({}).cpuTempSource).toBe('none');
  });

  it('uses nvidia-smi only when no hardware monitor supplies a GPU temperature', () => {
    const result = normaliseTelemetry({ nvidiaGpuTempC: 67 });
    expect(result.gpuTempC).toBe(67);
    expect(result.gpuTempSource).toBe('nvidia-smi');
  });

  it('uses battery discharge only while on battery', () => {
    expect(normaliseTelemetry({ onAc: false, batteryPowerW: 42.5 }).powerSource).toBe('battery');
    expect(normaliseTelemetry({ onAc: true, batteryPowerW: 42.5 }).powerDrawW).toBeNull();
  });

  it('rejects implausible temperatures and keeps plausible ones', () => {
    expect(normaliseTelemetry({ acpiCpuTempC: -273 }).cpuTempC).toBeNull();
    expect(normaliseTelemetry({ acpiCpuTempC: 400 }).cpuTempC).toBeNull();
    expect(normaliseTelemetry({ acpiCpuTempC: 62.44 }).cpuTempC).toBe(62.4);
  });

  it('accepts string numbers from PowerShell and bounds battery and power', () => {
    const result = normaliseTelemetry({
      onAc: false,
      batteryPercent: '101',
      batteryPowerW: '40.25',
      ohm: { cpuTempC: '61', gpuTempC: '71' },
    });
    expect(result.onAc).toBe(false);
    expect(result.batteryPercent).toBeNull();
    expect(result.powerDrawW).toBe(40.3);
    expect(result.gpuTempC).toBe(71);
    expect(result.gpuTempSource).toBe('open-hardware-monitor');
  });

  it('treats missing fields as unknown, never as zero', () => {
    expect(normaliseTelemetry({})).toMatchObject({
      cpuTempC: null,
      gpuTempC: null,
      powerDrawW: null,
      powerSource: 'none',
      onAc: null,
      batteryPercent: null,
    });
  });
});

describe('guard schema', () => {
  it('accepts a threshold with defaults omitted', () => {
    const parsed = gameProfileSchema.parse({ ...PROFILE, guards: { maxCpuTempC: 90 } });
    expect(parsed.guards?.maxCpuTempC).toBe(90);
  });

  it('rejects a guard with no usable condition', () => {
    expect(() => gameProfileSchema.parse({ ...PROFILE, guards: { cooldownSeconds: 60 } })).toThrow();
  });

  it('rejects impossible limits and cooldowns', () => {
    expect(() => gameProfileSchema.parse({ ...PROFILE, guards: { maxCpuTempC: 120 } })).toThrow();
    expect(() => gameProfileSchema.parse({ ...PROFILE, guards: { maxCpuTempC: 90, cooldownSeconds: 10 } })).toThrow();
  });

  it('warns about a limit that will trip under ordinary load', () => {
    const tight = gameProfileSchema.parse({ ...PROFILE, guards: { maxCpuTempC: 70 } });
    const findings = evaluateGameProfile(tight, TOPOLOGY);
    expect(findings.some((finding) => finding.code === 'game.guard-tight' && finding.severity === 'warn')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Controller behaviour
 * ------------------------------------------------------------------ */

const GAME_PATH = 'C:\\Games\\game.exe';
const START = '2026-01-01T00:00:00.000Z';

class FakeAdapter implements GameAdapter {
  calls: string[] = [];
  telemetry: TelemetrySample = sample();

  async topology(): Promise<CpuTopology> {
    return TOPOLOGY;
  }
  async applyAffinityAndPriority(pid: number, maskHex: string, priority: string | null): Promise<void> {
    this.calls.push(`affinity:${pid}:${maskHex}:${priority ?? 'none'}`);
  }
  async readProcessPriority(): Promise<PriorityClass | null> {
    return 'Normal';
  }
  async setProcessPriority(): Promise<void> {}
  async suspendProcesses(pids: readonly number[]): Promise<{ pid: number; ok: boolean }[]> {
    return pids.map((pid) => ({ pid, ok: true }));
  }
  async resumeProcesses(pids: readonly number[]): Promise<{ pid: number; ok: boolean }[]> {
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
  async readTelemetry(): Promise<TelemetrySample> {
    return this.telemetry;
  }
}

class FakeSessions implements SessionStore {
  saved: StoredGameSession[] = [];
  private seq = 0;

  newSessionId(): string {
    this.seq += 1;
    return `session-${this.seq}`;
  }
  async save(session: StoredGameSession): Promise<void> {
    this.saved.push(structuredClone(session));
  }
  async pending(): Promise<StoredGameSession[]> {
    return [];
  }
}

const SNAPSHOT = {
  foreground: { pid: 100, exe: 'game.exe', path: GAME_PATH, title: 'Guarded Game' },
  running: [{ pid: 100, exe: 'game.exe' }],
};

function makeController(adapter: FakeAdapter, clock: { value: number }) {
  const sessions = new FakeSessions();
  const profiles: ProfilesSource = { load: async () => ({ profiles: [PROFILE], errors: [] }) };
  const controller = new GameController({
    adapter,
    profiles,
    sessions,
    now: () => START,
    nowMs: () => clock.value,
    createWatcher: () => ({ start: () => {}, stop: () => {} }),
  });
  return { controller, sessions };
}

describe('controller thermal safety', () => {
  it('refuses to apply a profile that is already over its limit', async () => {
    const adapter = new FakeAdapter();
    adapter.telemetry = sample({ cpuTempC: 95 });
    const clock = { value: 0 };
    const { controller } = makeController(adapter, clock);

    await controller.start();
    await controller.setWatching(true);
    controller.handleSnapshot(SNAPSHOT);
    await controller.settle();

    const status = controller.status();
    expect(status.active).toBeNull();
    expect(status.phase).toBe('error');
    expect(status.lastError).toContain('Refused to tune');
    expect(status.guard?.status).toBe('trip');

    // Cooldown: focusing the game again must not immediately re-apply.
    clock.value += 60_000;
    controller.handleSnapshot(SNAPSHOT);
    await controller.settle();
    expect(controller.status().active).toBeNull();
  });

  it('restores an active session when the CPU crosses the guard, then waits out the cooldown', async () => {
    const adapter = new FakeAdapter();
    const clock = { value: 1_000 };
    const { controller, sessions } = makeController(adapter, clock);

    await controller.start();
    await controller.setWatching(true);
    controller.handleSnapshot(SNAPSHOT);
    await controller.settle();
    expect(controller.status().active).not.toBeNull();

    adapter.telemetry = sample({ cpuTempC: 91.7 });
    clock.value += 6_000;
    controller.handleSnapshot(SNAPSHOT);
    await controller.settle();

    const status = controller.status();
    expect(status.active).toBeNull();
    expect(status.guard?.status).toBe('trip');

    const session = sessions.saved.find((entry) => entry.adjustments.some((item) => item.kind === 'thermal-guard'));
    expect(session).toBeDefined();
    expect(session?.adjustments.some((item) => item.target === 'cpu-temp' && item.ok === false)).toBe(true);

    // Still cooling down: no re-apply even though the game is focused.
    clock.value += 30_000;
    controller.handleSnapshot(SNAPSHOT);
    await controller.settle();
    expect(controller.status().active).toBeNull();

    // Cool again and past the cooldown: the profile applies normally.
    adapter.telemetry = sample({ cpuTempC: 68 });
    clock.value += 120_000;
    controller.handleSnapshot(SNAPSHOT);
    await controller.settle();
    expect(controller.status().active).not.toBeNull();
  });

  it('records a partly enforced guard once instead of failing the session', async () => {
    const adapter = new FakeAdapter();
    adapter.telemetry = sample({ gpuTempC: null, gpuTempSource: 'none' });
    const clock = { value: 1_000 };
    const { controller, sessions } = makeController(adapter, clock);

    await controller.start();
    await controller.setWatching(true);
    controller.handleSnapshot(SNAPSHOT);
    await controller.settle();

    adapter.telemetry = sample({ gpuTempC: null, gpuTempSource: 'none' });
    clock.value += 6_000;
    controller.handleSnapshot(SNAPSHOT);
    await controller.settle();
    clock.value += 6_000;
    controller.handleSnapshot(SNAPSHOT);
    await controller.settle();

    expect(controller.status().active).not.toBeNull();
    const notes = sessions.saved.flatMap((session) =>
      session.adjustments.filter((item) => item.kind === 'thermal-guard' && item.detail === 'Partly enforced'),
    );
    expect(notes).toHaveLength(1);
  });
});
