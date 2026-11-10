import { describe, expect, it } from 'vitest';
import { GameController, type GameAdapter, type ProcessOutcome, type ProfilesSource, type SessionStore } from '../src/main/engine/game/controller';
import type { StoredGameSession } from '../src/main/engine/game/store';
import { buildEcoModeScript } from '../src/main/platform/game/eco';
import { evaluateGameProfile } from '../src/shared/game/policy';
import { gameProfileSchema } from '../src/shared/game/schema';
import type { CpuTopology, GameProfile } from '../src/shared/game/types';
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
  id: 'eco-test',
  name: 'Eco Test',
  version: '1.0.0',
  description: 'A profile used by the unit tests to exercise Efficiency Mode.',
  authors: [{ handle: 'tester' }],
  license: 'MIT',
  risk: 'moderate',
  trigger: { exe: 'game.exe' },
  actions: {
    backgroundRules: [{ process: 'chrome.exe', action: 'eco-mode' }],
  },
});

const START = '2026-01-01T00:00:00.000Z';

class FakeAdapter implements GameAdapter {
  calls: string[] = [];
  eco = new Map<number, boolean>();
  failEcoOff = false;

  async topology(): Promise<CpuTopology> {
    return TOPOLOGY;
  }
  async applyAffinityAndPriority(): Promise<void> {
    this.calls.push('affinity');
  }
  async readProcessPriority(): Promise<PriorityClass | null> {
    return 'Normal';
  }
  async setProcessPriority(): Promise<void> {
    this.calls.push('set-priority');
  }
  async suspendProcesses(): Promise<ProcessOutcome[]> {
    return [];
  }
  async resumeProcesses(): Promise<ProcessOutcome[]> {
    return [];
  }
  async setEcoMode(pids: readonly number[], enabled: boolean): Promise<ProcessOutcome[]> {
    this.calls.push(`eco:${pids.join(',')}:${enabled ? 'on' : 'off'}`);
    if (!enabled && this.failEcoOff) return pids.map((pid) => ({ pid, ok: false }));
    for (const pid of pids) this.eco.set(pid, enabled);
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
}

class FakeSessions implements SessionStore {
  saved: StoredGameSession[] = [];
  private seq = 0;

  newSessionId(): string {
    this.seq += 1;
    return `eco-session-${this.seq}`;
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

function makeController(options: { adapter?: FakeAdapter; sessions?: FakeSessions } = {}) {
  const adapter = options.adapter ?? new FakeAdapter();
  const sessions = options.sessions ?? new FakeSessions();
  const profiles: ProfilesSource = { load: async () => ({ profiles: [PROFILE], errors: [] }) };

  const controller = new GameController({
    adapter,
    profiles,
    sessions,
    now: () => START,
    createWatcher: () => ({ start: () => {}, stop: () => {} }),
  });

  return { controller, adapter, sessions };
}

const withBrowser = {
  foreground: { pid: 100, exe: 'game.exe', path: 'C:\\Games\\game.exe', title: 'Game' },
  running: [
    { pid: 100, exe: 'game.exe' },
    { pid: 200, exe: 'chrome.exe' },
  ],
};

const idle = { foreground: null, running: [] };

describe('efficiency mode policy', () => {
  const eco = (exe: string, risk = 'moderate') =>
    gameProfileSchema.parse({
      schemaVersion: 1,
      id: 'eco-policy',
      name: 'Eco Policy',
      version: '1.0.0',
      description: 'A profile used by the unit tests to exercise Efficiency Mode policy.',
      authors: [{ handle: 'tester' }],
      license: 'MIT',
      risk,
      trigger: { exe: 'game.exe' },
      actions: { backgroundRules: [{ process: exe, action: 'eco-mode' }] },
    });
  const codes = (profile: GameProfile) => evaluateGameProfile(profile, TOPOLOGY).map((f) => f.code);

  it('blocks Efficiency Mode on the shell', () => {
    expect(codes(eco('explorer.exe'))).toContain('game.protected-background');
  });

  it('blocks Efficiency Mode on the watcher host shell', () => {
    expect(codes(eco('powershell.exe'))).toContain('game.protected-background');
  });

  it('allows Efficiency Mode in a conservative profile', () => {
    expect(codes(eco('chrome.exe', 'conservative'))).not.toContain('game.conservative-suspend');
  });

  it('warns about Efficiency Mode on a launcher', () => {
    expect(codes(eco('Discord.exe'))).toContain('game.caution-eco');
  });
});

describe('efficiency mode script', () => {
  it('injects only validated literals and removes the placeholders', () => {
    const script = buildEcoModeScript([200], true);
    expect(script).not.toContain('PIDS');
    expect(script.replace("'on'", '')).not.toContain('MODE');
    expect(script).toContain("'on'");
  });
});

describe('efficiency mode sessions', () => {
  it('applies eco mode and records it in the session', async () => {
    const { controller, adapter, sessions } = makeController();
    await controller.setWatching(true);
    controller.handleSnapshot(withBrowser);
    await controller.settle();

    expect(adapter.calls).toContain('eco:200:on');
    expect(adapter.eco.get(200)).toBe(true);

    const saved = sessions.latest();
    expect(saved.processes).toEqual([{ pid: 200, exe: 'chrome.exe', previousPriority: 'Normal', suspended: false, ecoMode: true }]);
    expect(saved.adjustments.some((a) => a.kind === 'background-eco' && a.ok)).toBe(true);
    expect(controller.status().phase).toBe('active');
  });

  it('switches eco mode off the moment the game exits', async () => {
    const { controller, adapter } = makeController();
    await controller.setWatching(true);
    controller.handleSnapshot(withBrowser);
    await controller.settle();

    controller.handleSnapshot(idle);
    await controller.settle();
    controller.handleSnapshot(idle);
    await controller.settle();

    expect(adapter.calls).toContain('eco:200:off');
    expect(adapter.eco.get(200)).toBe(false);
    expect(controller.status().phase).toBe('idle');
  });

  it('surfaces a failed eco restore instead of hiding it', async () => {
    const adapter = new FakeAdapter();
    adapter.failEcoOff = true;
    const { controller } = makeController({ adapter });
    await controller.setWatching(true);
    controller.handleSnapshot(withBrowser);
    await controller.settle();

    controller.handleSnapshot(idle);
    await controller.settle();
    controller.handleSnapshot(idle);
    await controller.settle();

    expect(controller.status().lastError).toContain('Efficiency Mode');
    expect(controller.status().pendingRestore).not.toBeNull();
  });

  it('never targets the optimizer process itself', async () => {
    const { controller, adapter } = makeController();
    await controller.setWatching(true);
    controller.handleSnapshot({
      foreground: withBrowser.foreground,
      running: [...withBrowser.running, { pid: process.pid, exe: 'chrome.exe' }],
    });
    await controller.settle();

    expect(adapter.calls).not.toContain(`eco:${process.pid}:on`);
    expect(adapter.calls).toContain('eco:200:on');
  });
});
