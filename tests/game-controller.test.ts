import { describe, expect, it } from 'vitest';
import { GameController, type GameAdapter, type ProfilesSource, type SessionStore } from '../src/main/engine/game/controller';
import type { StoredGameSession } from '../src/main/engine/game/store';
import { gameProfileSchema } from '../src/shared/game/schema';
import type {
  CpuTopology,
  GameNetworkApplyResult,
  GameNetworkSettings,
  GameNetworkSnapshot,
  GameNetworkTarget,
  GameProfile,
} from '../src/shared/game/types';
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

const PROFILE: GameProfile = gameProfileSchema.parse({
  schemaVersion: 1,
  id: 'test-game',
  name: 'Test Game',
  version: '1.0.0',
  description: 'A profile used by the unit tests to exercise the controller.',
  authors: [{ handle: 'tester' }],
  license: 'MIT',
  risk: 'moderate',
  trigger: { exe: 'game.exe' },
  actions: {
    affinity: { strategy: 'physical-cores' },
    priority: 'High',
    gpuPreference: 'high-performance',
    backgroundRules: [{ process: 'chrome.exe', action: 'suspend' }],
  },
});

const GAME_PATH = 'C:\\Games\\game.exe';
const START = '2026-01-01T00:00:00.000Z';

const NETWORK_PROFILE: GameProfile = gameProfileSchema.parse({
  schemaVersion: 1,
  id: 'network-game',
  name: 'Network Game',
  version: '1.0.0',
  description: 'A profile used by the unit tests to exercise game network tuning.',
  authors: [{ handle: 'tester' }],
  license: 'MIT',
  risk: 'moderate',
  trigger: { exe: 'game.exe' },
  actions: { network: { tcpAckFrequency: 1, tcpNoDelay: 1 } },
});

class FakeAdapter implements GameAdapter {
  calls: string[] = [];
  priorities = new Map<number, PriorityClass>();
  suspended = new Set<number>();
  gpu = new Map<string, string | null>();
  networkTargets: GameNetworkTarget[] = [
    {
      interfaceGuid: '11111111-2222-3333-4444-555555555555',
      adapterName: 'Ethernet',
      adapterDescription: 'Test Ethernet',
      endpoints: [
        {
          protocol: 'tcp',
          localAddress: '192.168.1.20',
          localPort: 50_000,
          remoteAddress: '203.0.113.10',
          remotePort: 27_015,
        },
      ],
    },
  ];

  async topology(): Promise<CpuTopology> {
    return TOPOLOGY;
  }
  async applyAffinityAndPriority(pid: number, maskHex: string, priority: string | null): Promise<void> {
    this.calls.push(`affinity:${pid}:${maskHex}:${priority ?? 'none'}`);
  }
  async readProcessPriority(pid: number): Promise<PriorityClass | null> {
    this.calls.push(`read-priority:${pid}`);
    return this.priorities.get(pid) ?? 'Normal';
  }
  async setProcessPriority(pid: number, priority: PriorityClass): Promise<void> {
    this.calls.push(`set-priority:${pid}:${priority}`);
    this.priorities.set(pid, priority);
  }
  async suspendProcesses(pids: readonly number[]): Promise<{ pid: number; ok: boolean }[]> {
    this.calls.push(`suspend:${pids.join(',')}`);
    for (const pid of pids) this.suspended.add(pid);
    return pids.map((pid) => ({ pid, ok: true }));
  }
  async resumeProcesses(pids: readonly number[]): Promise<{ pid: number; ok: boolean }[]> {
    this.calls.push(`resume:${pids.join(',')}`);
    for (const pid of pids) this.suspended.delete(pid);
    return pids.map((pid) => ({ pid, ok: true }));
  }
  async purgeStandbyList(): Promise<boolean> {
    this.calls.push('purge');
    return true;
  }
  async readGpuPreference(exePath: string): Promise<string | null> {
    this.calls.push(`read-gpu:${exePath}`);
    return this.gpu.get(exePath) ?? null;
  }
  async writeGpuPreference(exePath: string, preference: 'high-performance' | 'power-saving'): Promise<void> {
    this.calls.push(`write-gpu:${exePath}:${preference}`);
    this.gpu.set(exePath, preference === 'high-performance' ? 'GpuPreference=2;' : 'GpuPreference=1;');
  }
  async restoreGpuPreference(exePath: string, previous: string | null): Promise<void> {
    this.calls.push(`restore-gpu:${exePath}:${previous ?? 'null'}`);
    this.gpu.set(exePath, previous);
  }
  async inspectNetwork(pid: number): Promise<GameNetworkTarget[]> {
    this.calls.push(`network-inspect:${pid}`);
    return this.networkTargets;
  }
  async captureNetwork(targets: readonly GameNetworkTarget[]): Promise<GameNetworkSnapshot> {
    this.calls.push('network-capture');
    return {
      capturedAt: START,
      interfaces: targets.map((target) => ({ ...target, tcpAckFrequency: 2, tcpNoDelay: 0 })),
    };
  }
  async applyNetwork(snapshot: GameNetworkSnapshot, settings: GameNetworkSettings): Promise<GameNetworkApplyResult> {
    this.calls.push(`network-apply:${snapshot.interfaces.length}:${settings.tcpAckFrequency ?? 'x'}`);
    return { ok: true, tcpInterfaces: snapshot.interfaces.length, adapter: 'not-requested', message: 'Applied.' };
  }
  async restoreNetwork(snapshot: GameNetworkSnapshot): Promise<string[]> {
    this.calls.push(`network-restore:${snapshot.interfaces.length}`);
    return [];
  }
}

class FakeSessions implements SessionStore {
  saved: StoredGameSession[] = [];
  pendingList: StoredGameSession[] = [];
  private seq = 0;

  newSessionId(): string {
    this.seq += 1;
    return `session-${this.seq}`;
  }
  async save(session: StoredGameSession): Promise<void> {
    this.saved.push(structuredClone(session));
  }
  async pending(): Promise<StoredGameSession[]> {
    return this.pendingList;
  }
  latest(): StoredGameSession {
    const last = this.saved[this.saved.length - 1];
    if (last === undefined) throw new Error('nothing saved');
    return last;
  }
}

function makeController(options: { profiles?: GameProfile[]; sessions?: FakeSessions; adapter?: FakeAdapter } = {}) {
  const adapter = options.adapter ?? new FakeAdapter();
  const sessions = options.sessions ?? new FakeSessions();
  const profiles: ProfilesSource = {
    load: async () => ({ profiles: options.profiles ?? [PROFILE], errors: [] }),
  };

  const controller = new GameController({
    adapter,
    profiles,
    sessions,
    now: () => START,
    createWatcher: () => ({ start: () => {}, stop: () => {} }),
  });

  return { controller, adapter, sessions };
}

const gameOnly = {
  foreground: { pid: 100, exe: 'game.exe', path: GAME_PATH, title: 'Test Game' },
  running: [{ pid: 100, exe: 'game.exe' }],
};

const withBrowser = {
  foreground: gameOnly.foreground,
  running: [...gameOnly.running, { pid: 200, exe: 'chrome.exe' }],
};

const idle = { foreground: null, running: [] };

describe('game controller', () => {
  it('ignores a foreground window that matches no profile', async () => {
    const { controller, adapter } = makeController();
    await controller.setWatching(true);

    controller.handleSnapshot({ foreground: { pid: 5, exe: 'notepad.exe', path: null, title: 'x' }, running: [] });
    await controller.settle();

    expect(adapter.calls).toHaveLength(0);
    expect(controller.status().active).toBeNull();
  });

  it('activates the matching profile and records every action', async () => {
    const { controller, adapter, sessions } = makeController();
    await controller.setWatching(true);

    controller.handleSnapshot(withBrowser);
    await controller.settle();

    // Physical cores of a 4-core/8-thread CPU are 0,2,4,6.
    expect(adapter.calls).toContain('affinity:100:0x55:High');
    expect(adapter.calls).toContain('suspend:200');
    expect(adapter.suspended.has(200)).toBe(true);

    const status = controller.status();
    expect(status.phase).toBe('active');
    expect(status.active?.profileId).toBe('test-game');
    expect(status.active?.suspended).toEqual([{ pid: 200, process: 'chrome.exe' }]);

    const saved = sessions.latest();
    expect(saved.phase).toBe('active');
    expect(saved.gpu).toEqual({ exePath: GAME_PATH, previous: null });
  });

  it('captures the previous GPU preference before overwriting it', async () => {
    const { controller, adapter } = makeController();
    await controller.setWatching(true);
    adapter.gpu.set(GAME_PATH, 'GpuPreference=1;');

    controller.handleSnapshot(withBrowser);
    await controller.settle();

    const read = adapter.calls.indexOf(`read-gpu:${GAME_PATH}`);
    const write = adapter.calls.indexOf(`write-gpu:${GAME_PATH}:high-performance`);
    expect(read).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(read);
  });

  it('captures the game network route before changing it and restores it on exit', async () => {
    const { controller, adapter, sessions } = makeController({ profiles: [NETWORK_PROFILE] });
    await controller.setWatching(true);

    controller.handleSnapshot(withBrowser);
    await controller.settle();

    const inspected = adapter.calls.indexOf('network-inspect:100');
    const captured = adapter.calls.indexOf('network-capture');
    const applied = adapter.calls.findIndex((call) => call.startsWith('network-apply:'));
    expect(inspected).toBeGreaterThanOrEqual(0);
    expect(captured).toBeGreaterThan(inspected);
    expect(applied).toBeGreaterThan(captured);

    const saved = sessions.saved.find((session) => session.network !== undefined);
    expect(saved?.network?.interfaces[0]?.tcpAckFrequency).toBe(2);
    expect(saved?.network?.interfaces[0]?.tcpNoDelay).toBe(0);

    await controller.stopActive();
    expect(adapter.calls.some((call) => call.startsWith('network-restore:'))).toBe(true);
  });

  it('does not tear down on the first missing tick', async () => {
    const { controller, adapter } = makeController();
    await controller.setWatching(true);
    controller.handleSnapshot(withBrowser);
    await controller.settle();

    controller.handleSnapshot(idle);
    await controller.settle();

    expect(controller.status().phase).toBe('active');
    expect(adapter.calls.some((call) => call.startsWith('resume:'))).toBe(false);
  });

  it('resumes suspended processes and restores the GPU preference when the game exits', async () => {
    const { controller, adapter } = makeController();
    await controller.setWatching(true);
    controller.handleSnapshot(withBrowser);
    await controller.settle();

    controller.handleSnapshot(idle);
    await controller.settle();
    controller.handleSnapshot(idle);
    await controller.settle();

    expect(adapter.calls).toContain('resume:200');
    expect(adapter.suspended.has(200)).toBe(false);
    expect(adapter.calls).toContain(`restore-gpu:${GAME_PATH}:null`);
    expect(controller.status().phase).toBe('idle');
    expect(controller.status().active).toBeNull();
  });

  it('restores immediately on request', async () => {
    const { controller, adapter } = makeController();
    await controller.setWatching(true);
    controller.handleSnapshot(withBrowser);
    await controller.settle();

    const status = await controller.stopActive();

    expect(status.phase).toBe('idle');
    expect(adapter.suspended.size).toBe(0);
    expect(adapter.calls).toContain(`restore-gpu:${GAME_PATH}:null`);
  });

  it('refuses a blocked profile without touching the machine', async () => {
    const blocked = gameProfileSchema.parse({
      schemaVersion: 1,
      id: 'blocked-game',
      name: 'Blocked Game',
      version: '1.0.0',
      description: 'A profile that tries to suspend the Windows shell and must be refused.',
      authors: [{ handle: 'tester' }],
      license: 'MIT',
      risk: 'aggressive',
      trigger: { exe: 'game.exe' },
      actions: { backgroundRules: [{ process: 'explorer.exe', action: 'suspend' }] },
    });

    const { controller, adapter } = makeController({ profiles: [blocked] });
    await controller.setWatching(true);

    controller.handleSnapshot(withBrowser);
    await controller.settle();

    expect(adapter.calls).toHaveLength(0);
    expect(controller.status().active).toBeNull();
    expect(controller.status().lastError).toContain('protected');
  });

  it('recovers a session left behind by a crash', async () => {
    const sessions = new FakeSessions();
    sessions.pendingList = [
      {
        schemaVersion: 1,
        id: 'crashed',
        profileId: 'test-game',
        profileName: 'Test Game',
        exe: 'game.exe',
        pid: 100,
        startedAt: START,
        phase: 'active',
        game: { affinityApplied: true, priorityApplied: true },
        gpu: { exePath: GAME_PATH, previous: 'GpuPreference=1;' },
        processes: [{ pid: 200, exe: 'chrome.exe', previousPriority: 'Normal', suspended: true }],
        adjustments: [],
      },
    ];

    const { controller, adapter } = makeController({ sessions });
    await controller.start();

    expect(adapter.calls).toContain('resume:200');
    expect(adapter.calls).toContain(`restore-gpu:${GAME_PATH}:GpuPreference=1;`);
    expect(sessions.latest().restoredAt).toBe(START);
    expect(sessions.latest().interrupted).toBe(true);
  });

  it('stops watching and restores when game mode is switched off', async () => {
    const { controller, adapter } = makeController();
    await controller.setWatching(true);
    controller.handleSnapshot(withBrowser);
    await controller.settle();

    const status = await controller.setWatching(false);

    expect(status.watching).toBe(false);
    expect(status.active).toBeNull();
    expect(adapter.suspended.size).toBe(0);
  });
});
