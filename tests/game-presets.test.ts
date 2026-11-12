import { describe, expect, it } from 'vitest';
import cyberpunk from '../presets/games/cyberpunk-2077.json';
import esports from '../presets/games/esports-low-latency.json';
import eco from '../presets/games/efficiency-eco.json';
import siege from '../presets/games/rainbow-six-siege.json';
import streaming from '../presets/games/tiktok-live-studio-streaming.json';
import { describeActions } from '../src/shared/game/describe';
import { evaluateGameProfile, isBlocked, watchList } from '../src/shared/game/policy';
import { gameProfileSchema } from '../src/shared/game/schema';
import type { CpuTopology } from '../src/shared/game/types';

const BUNDLED: unknown[] = [cyberpunk, esports, eco, siege, streaming];

/** A plain 8-thread machine: nothing may depend on hybrid cores to stay safe. */
const TOPOLOGY: CpuTopology = {
  logicalProcessors: 8,
  physicalCores: 4,
  hybrid: false,
  efficiencyClasses: new Array<number>(8).fill(0),
  coreIndices: [0, 0, 1, 1, 2, 2, 3, 3],
  source: 'synthetic',
  higherEfficiencyIsFaster: true,
};

describe('bundled game profiles', () => {
  it('every shipped profile is structurally valid', () => {
    for (const candidate of BUNDLED) {
      const parsed = gameProfileSchema.safeParse(candidate);
      expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true);
    }
  });

  it('none is refused by policy on a non-hybrid machine', () => {
    for (const candidate of BUNDLED) {
      const profile = gameProfileSchema.parse(candidate);
      const findings = evaluateGameProfile(profile, TOPOLOGY);
      expect(isBlocked(findings), `${profile.id}: ${findings.map((f) => f.message).join('; ')}`).toBe(false);
    }
  });

  it('every profile does something visible', () => {
    for (const candidate of BUNDLED) {
      const profile = gameProfileSchema.parse(candidate);
      expect(describeActions(profile).length).toBeGreaterThan(0);
      expect(profile.trigger.exe !== undefined || profile.trigger.packageFamilyName !== undefined).toBe(true);
    }
  });

  it('leaves the standby-memory purge disabled by default', () => {
    // It is available, but shipping it on would trade load time for a nicer number in
    // Task Manager. See docs/GAME-ENGINE.md.
    for (const candidate of BUNDLED) {
      const profile = gameProfileSchema.parse(candidate);
      expect(profile.actions.flushStandbyMemory ?? false).toBe(false);
    }
  });

  it('asks the watcher only for validated image names', () => {
    const names = watchList(BUNDLED.map((candidate) => gameProfileSchema.parse(candidate)));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/^[a-z0-9][a-z0-9 ._-]*\.exe$/);
  });
});
