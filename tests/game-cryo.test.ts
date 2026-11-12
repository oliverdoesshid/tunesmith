import { describe, expect, it } from 'vitest';
import {
  GameController,
  type GameAdapter,
  type ProcessOutcome,
  type ProfilesSource,
  type SessionStore,
} from '../src/main/engine/game/controller';
import type { StoredGameSession } from '../src/main/engine/game/store';
import {
  CRYO_FREEZE_CANDIDATES,
  cryoFreezeBudget,
  cryoFreezeNames,
} from '../src/shared/game/cryo';
import { SUSPEND_CAUTION, SUSPEND_DENYLIST } from '../src/shared/game/policy';
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

const START = '2026-01-01T00:00:00.000Z';

function profile(actions: GameProfile['actions'] = {}): GameProfile {
  return gameProfileSchema.parse({
    schemaVersion: 1,
    id: 'cryo-test',
    name: 'Cryo Test',
    version: '1.0.0',
    description: 'A profile used by the unit tests to exercise automatic Cryo-Freeze.',
    authors: [{ handle: 'tester' }],
    license: 'MIT',
    risk: 'moderate',
    trigger: { exe: 'game.exe' },
    actions,
  });
}

class FakeAdapter implements GameAdapter {
  suspended: number[] = [];
  resumed: number[] = [];
  calls: string[] = [];

  async topology(): Promise<CpuTopology> {
    return TOPOLOGY;
  }
  async applyAffinityAndPriority(): Promise<void> {
    this.calls.push('affinity');
  }
  async readProcessPriority(): Promise<PriorityClass | null> {
    return 'Normal';
  }
  async setProcessPriority(pid: number, priority: PriorityClass): Promise<void> {
    this.calls.push(`priority:${pid}:${priority}`);
  }
  async suspendProcesses(pids: readonly number[]): Promise<ProcessOutcome[]> {
    this.suspended.push(...pids);
    return pids.map((pid) => ({ pid, ok: true }));
  }
  async resumeProcesses(pids: readonly number[]): Promise<ProcessOutcome[]> {
    this.resumed.push(...pids);
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
    return `cryo-session-${this.seq}`;
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

function makeController(
  options: {
    profiles?: GameProfile[];
    knownGames?: () => Promise<readonly string[]>;
    adapter?: FakeAdapter;
    sessions?: FakeSessions;
  } = {},
) {
  const adapter = options.adapter ?? new FakeAdapter();
  const sessions = options.sessions ?? new FakeSessions();
  const profiles: ProfilesSource = {
    load: async () => ({ profiles: options.profiles ?? [profile()], errors: [] }),
  };

  const controller = new GameController({
    adapter,
    profiles,
    sessions,
    knownGames: options.knownGames,
    now: () => START,
    createWatcher: () => ({ start: () => {}, stop: () => {} }),
  });

  return { controller, adapter, sessions };
}

const game = { pid: 100, exe: 'game.exe' };
const oneDrive = { pid: 300, exe: 'OneDrive.exe' };
const dropbox = { pid: 301, exe: 'Dropbox.exe' };
const chrome = { pid: 200, exe: 'chrome.exe' };
const running = [game, oneDrive, dropbox, chrome];

describe('Cryo-Freeze catalog', () => {
  it('never contains a policy-denied or caution process', () => {
    for (const name of cryoFreezeNames()) {
      expect(SUSPEND_DENYLIST.has(name)).toBe(false);
      expect(SUSPEND_CAUTION.has(name)).toBe(false);
      expect(name.endsWith('.exe')).toBe(true);
    }
    expect(cryoFreezeNames()).toContain('onedrive.exe');
    expect(cryoFreezeNames().length).toBeGreaterThan(0);
  });

  it('scales the automatic budget to the machine', () => {
    expect(cryoFreezeBudget(4)).toBe(2);
    expect(cryoFreezeBudget(8)).toBe(6);
    expect(cryoFreezeBudget(16)).toBe(12);
  });
});

describe('Cryo-Freeze sessions', () => {
  it('suspends non-essential candidates and resumes them when the game exits', async () => {
    const { controller, adapter, sessions } = makeController();
    await controller.setCryoFreeze(true);
    await controller.setWatching(true);

    controller.handleSnapshot({ foreground: game, running });
    await controller.settle();

    expect(adapter.suspended.sort()).toEqual([300, 301]);
    expect(controller.status().cryoFreeze).toBe(true);
    expect(controller.status().active?.suspended).toEqual(
      expect.arrayContaining([
        { pid: 300, process: 'OneDrive.exe', cryoFreeze: true },
        { pid: 301, process: 'Dropbox.exe', cryoFreeze: true },
      ]),
    );

    const saved = sessions.latest();
    expect(saved.processes).toEqual(
      expect.arrayContaining([
        { pid: 300, exe: 'OneDrive.exe', previousPriority: null, suspended: true, cryoFreeze: true },
        { pid: 301, exe: 'Dropbox.exe', previousPriority: null, suspended: true, cryoFreeze: true },
      ]),
    );
    expect(saved.adjustments.some((adjustment) => adjustment.detail.includes('Cryo-Freeze'))).toBe(true);

    controller.handleSnapshot({ foreground: null, running: [] });
    await controller.settle();
    controller.handleSnapshot({ foreground: null, running: [] });
    await controller.settle();

    expect(adapter.resumed.sort()).toEqual([300, 301]);
    expect(controller.status().phase).toBe('idle');
  });

  it('does not freeze a process an explicit profile rule already manages', async () => {
    const { controller, adapter } = makeController({
      profiles: [
        profile({
          backgroundRules: [{ process: 'OneDrive.exe', action: 'lower-priority', priority: 'BelowNormal' }],
        }),
      ],
    });
    await controller.setCryoFreeze(true);
    await controller.setWatching(true);

    controller.handleSnapshot({ foreground: game, running });
    await controller.settle();

    expect(adapter.suspended).toEqual([301]);
    expect(adapter.calls).toContain('priority:300:BelowNormal');
  });

  it('does nothing automatic while Cryo-Freeze is off', async () => {
    const { controller, adapter } = makeController();
    await controller.setWatching(true);

    controller.handleSnapshot({ foreground: game, running });
    await controller.settle();

    expect(adapter.suspended).toEqual([]);
    expect(controller.status().cryoFreeze).toBe(false);
  });

  it('starts a Cryo-Freeze-only session for a known library game without a profile', async () => {
    const { controller, adapter } = makeController({
      profiles: [],
      knownGames: async () => ['Game.exe'],
    });
    await controller.setCryoFreeze(true);
    await controller.setWatching(true);

    controller.handleSnapshot({ foreground: game, running });
    await controller.settle();

    expect(controller.status().active?.profileId).toBe('cryo-freeze');
    expect(adapter.suspended.sort()).toEqual([300, 301]);
  });

  it('refuses to change the setting while a session is active', async () => {
    const { controller } = makeController();
    await controller.setCryoFreeze(true);
    await controller.setWatching(true);
    controller.handleSnapshot({ foreground: game, running });
    await controller.settle();

    await expect(controller.setCryoFreeze(false)).rejects.toThrow('Restore the active game session');
  });

  it('caps automatic suspensions on smaller CPUs', async () => {
    const adapter = new FakeAdapter();
    const smallTopology = { ...TOPOLOGY, logicalProcessors: 4 };
    adapter.topology = async () => smallTopology;
    const allCandidates = CRYO_FREEZE_CANDIDATES.map((candidate, index) => ({
      pid: 500 + index,
      exe: candidate.process,
    }));
    const { controller } = makeController({ adapter });

    await controller.setCryoFreeze(true);
    await controller.setWatching(true);
    controller.handleSnapshot({ foreground: game, running: [game, ...allCandidates] });
    await controller.settle();

    expect(adapter.suspended).toHaveLength(2);
  });
});
