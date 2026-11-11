import { describe, expect, it } from 'vitest';
import { buildPowerReadApiScript } from '../src/main/platform/power';
import { POWER_SETTINGS, describePowerSetting } from '../src/shared/power';
import { compilePlan } from '../src/shared/preset/compiler';
import { evaluatePresetPolicy } from '../src/shared/preset/policy';
import { makePreset, makeSpec } from './factories';

const SETTINGS = [
  { setting: 'core-parking-min-cores', value: 100 },
  { setting: 'core-parking-max-cores', value: 100 },
  { setting: 'energy-performance-preference', value: 0 },
] as const;

function powerPreset(settings: Array<{ setting: string; value: number }> = [...SETTINGS]) {
  return makePreset({
    profiles: [
      {
        id: 'base',
        name: 'Base',
        actions: { power: { settings } },
      },
    ],
  });
}

function codes(settings: Array<{ setting: string; value: number }>): string[] {
  return evaluatePresetPolicy(powerPreset(settings)).map((finding) => finding.code);
}

describe('EPP and core-parking vocabulary', () => {
  it('accepts the new setting ids through the real schema', () => {
    const preset = powerPreset();
    expect(preset.profiles[0]?.actions.power?.settings).toEqual(SETTINGS);
  });

  it('describes EPP as both a percentage and a hex value', () => {
    expect(describePowerSetting('energy-performance-preference', 0)).toBe('0% (0x00) — maximum performance');
    expect(describePowerSetting('energy-performance-preference', 100)).toBe(
      '100% (0x64) — maximum energy savings',
    );
    expect(describePowerSetting('energy-performance-preference', 42)).toBe('42% (0x2A)');
  });

  it('marks both hidden settings for API capture', () => {
    expect(POWER_SETTINGS['energy-performance-preference'].readVia).toBe('power-api');
    expect(POWER_SETTINGS['core-parking-max-cores'].readVia).toBe('power-api');
    expect(POWER_SETTINGS['energy-performance-preference'].guid).toBe('36687f9e-e3a5-4dbf-b1dc-15eb381c6863');
    expect(POWER_SETTINGS['core-parking-max-cores'].guid).toBe('ea062031-0e34-4ff1-9b6d-eb1059334028');
  });

  it('warns about EPP and core parking while remaining applicable', () => {
    const found = codes([...SETTINGS]);
    expect(found).toContain('power.epp');
    expect(found).toContain('power.epp-performance');
    expect(found).toContain('power.core-parking');
    expect(found).not.toContain('power.core-parking-range');
  });

  it('rejects a contradictory core-parking range', () => {
    expect(
      codes([
        { setting: 'core-parking-min-cores', value: 100 },
        { setting: 'core-parking-max-cores', value: 50 },
      ]),
    ).toContain('power.core-parking-range');
  });

  it('compiles the new settings into visible power steps', () => {
    const plan = compilePlan(powerPreset(), makeSpec());
    const epp = plan.steps.find((step) => step.target === 'power:energy-performance-preference');
    const maxCores = plan.steps.find((step) => step.target === 'power:core-parking-max-cores');
    expect(epp?.group).toBe('Power');
    expect(epp?.detail).toContain('0x00');
    expect(maxCores?.detail).toBe('-> 100%');
  });

  it('builds a fixed PowerReadACValue script for hidden capture', () => {
    const script = buildPowerReadApiScript('8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c', 'energy-performance-preference');
    expect(script).toContain('PowerReadACValue');
    expect(script).toContain('36687f9e-e3a5-4dbf-b1dc-15eb381c6863');
    expect(script).toContain('54533251-82be-4824-96c1-47b60b740d00');
    expect(() => buildPowerReadApiScript('not-a-guid', 'energy-performance-preference')).toThrow();
  });
});
