import { describe, expect, it } from 'vitest';
import { compilePlan, resolveActiveProfiles } from '../src/shared/preset/compiler';
import { makePreset, makeSpec } from './factories';

const baseProfile = {
  id: 'base',
  name: 'Base',
  actions: {
    registry: [
      { op: 'set', hive: 'HKCU', path: 'System\\GameConfigStore', name: 'GameDVR_Enabled', type: 'REG_DWORD', data: 0 },
    ],
    power: { plan: 'high-performance', settings: [{ setting: 'processor-min-state', value: 100 }] },
  },
};

describe('profile resolution', () => {
  it('activates a conditional profile only when the condition matches', () => {
    const preset = makePreset({
      profiles: [
        baseProfile,
        {
          id: 'big-vram',
          name: 'Big VRAM',
          extends: 'base',
          when: { gpuVramGb: { min: 16 } },
          actions: { priorities: [{ process: 'game.exe', priority: 'High' }] },
        },
      ],
    });

    expect(resolveActiveProfiles(preset, makeSpec()).map((p) => p.id)).toEqual(['base']);
    expect(resolveActiveProfiles(preset, makeSpec({ primaryGpu: { ...makeSpec().primaryGpu!, vramGb: 24 } })).map((p) => p.id)).toEqual([
      'base',
      'big-vram',
    ]);
  });

  it('keeps a child inactive when its parent is inactive', () => {
    const preset = makePreset({
      profiles: [
        baseProfile,
        {
          id: 'nvidia-only',
          name: 'NVIDIA only',
          extends: 'base',
          when: { gpu: ['RTX40*'] },
          actions: { priorities: [{ process: 'a.exe', priority: 'High' }] },
        },
        {
          id: 'nvidia-child',
          name: 'Child of NVIDIA profile',
          extends: 'nvidia-only',
          actions: { priorities: [{ process: 'b.exe', priority: 'High' }] },
        },
      ],
    });

    expect(resolveActiveProfiles(preset, makeSpec()).map((p) => p.id)).toEqual(['base']);
  });

  it('matches storage and RAM conditions', () => {
    const preset = makePreset({
      profiles: [baseProfile, { id: 'hdd', name: 'HDD', when: { storage: ['HDD'] }, actions: {} }],
    });
    expect(resolveActiveProfiles(preset, makeSpec()).map((p) => p.id)).toEqual(['base']);

    const hddSpec = makeSpec({
      storage: { primary: { index: 0, model: 'ST2000', mediaType: 'HDD', bus: 'SATA', sizeGb: 1863, isSystem: true }, devices: [] },
    });
    expect(resolveActiveProfiles(preset, hddSpec).map((p) => p.id)).toEqual(['base', 'hdd']);
  });
});

describe('plan compilation', () => {
  it('orders power plan before power settings', () => {
    const plan = compilePlan(makePreset({ profiles: [baseProfile] }), makeSpec());
    const powerKinds = plan.steps.filter((s) => s.group === 'Power').map((s) => s.action.kind);
    expect(powerKinds).toEqual(['power-plan', 'power-setting']);
  });

  it('deduplicates repeated targets so the last profile wins', () => {
    const plan = compilePlan(
      makePreset({
        profiles: [
          baseProfile,
          {
            id: 'override',
            name: 'Override',
            extends: 'base',
            actions: {
              registry: [
                { op: 'set', hive: 'HKCU', path: 'System\\GameConfigStore', name: 'GameDVR_Enabled', type: 'REG_DWORD', data: 1 },
              ],
            },
          },
        ],
      }),
      makeSpec(),
    );

    const steps = plan.steps.filter((s) => s.target.toLowerCase().includes('gamedvr_enabled'));
    expect(steps).toHaveLength(1);
    expect(steps[0]?.action).toMatchObject({ data: 1 });
    expect(plan.overrides).toBe(1);
  });

  it('counts groups for the UI summary', () => {
    const plan = compilePlan(makePreset({ profiles: [baseProfile] }), makeSpec());
    expect(plan.summary).toEqual({ Registry: 1, Services: 0, Priorities: 0, Power: 2 });
    expect(plan.steps).toHaveLength(3);
  });

  it('surfaces the hardware match result', () => {
    const plan = compilePlan(
      makePreset({ profiles: [baseProfile], compatibility: { cpu: ['Intel_i9*'] } }),
      makeSpec(),
    );
    expect(plan.compatibility.applicable).toBe(false);
    expect(plan.compatibility.score).toBe(0);
  });

  it('propagates policy findings and the blocked flag', () => {
    const plan = compilePlan(
      makePreset({
        profiles: [
          {
            id: 'base',
            name: 'Base',
            actions: {
              services: [{ name: 'WinDefend', startup: 'Disabled' }],
            },
          },
        ],
      }),
      makeSpec(),
    );
    expect(plan.blocked).toBe(true);
    expect(plan.findings.some((f) => f.code === 'service.protected')).toBe(true);
  });

  it('marks volatile steps', () => {
    const plan = compilePlan(
      makePreset({
        profiles: [
          {
            id: 'base',
            name: 'Base',
            actions: { priorities: [{ process: 'game.exe', priority: 'High' }] },
          },
        ],
      }),
      makeSpec(),
    );
    expect(plan.steps[0]?.volatile).toBe(true);
  });
});
