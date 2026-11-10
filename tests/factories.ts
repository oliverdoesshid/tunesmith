import type { CompiledPlan, PlannedStep, StepGroup } from '../src/shared/preset/compiler';
import { presetSchema, type Preset } from '../src/shared/preset/schema';
import type { CapturedState } from '../src/shared/session';
import type { HardwareSpec, PresetAction } from '../src/shared/types';
import type { StepAdapter } from '../src/main/engine/adapter';

export const TEST_SIGNATURE = 'AMD_Ryzen5_5600X_RTX3060_32GB_SSD';

export function makeSpec(overrides: Partial<HardwareSpec> = {}): HardwareSpec {
  const spec: HardwareSpec = {
    schemaVersion: 1,
    signatureVersion: 1,
    cpu: {
      vendor: 'AMD',
      rawName: 'AMD Ryzen 5 5600X 6-Core Processor',
      model: 'Ryzen5_5600X',
      token: 'AMD_Ryzen5_5600X',
      cores: 6,
      threads: 12,
      maxClockMhz: 3701,
    },
    primaryGpu: {
      vendor: 'NVIDIA',
      rawName: 'NVIDIA GeForce RTX 3060',
      model: 'RTX3060',
      token: 'RTX3060',
      vramBytes: 12_884_901_888,
      vramGb: 12,
      driverVersion: '32.0.16.2101',
      kind: 'discrete',
      vramSource: 'registry',
    },
    gpus: [],
    memory: { totalBytes: 34_273_869_824, totalGb: 31.9, bucketGb: 32, speedMhz: 3200, moduleCount: 2 },
    storage: {
      primary: { index: 0, model: 'KINGSTON SNV2S1000G', mediaType: 'SSD', bus: 'NVMe', sizeGb: 931.5, isSystem: true },
      devices: [],
    },
    os: { caption: 'Microsoft Windows 11 Pro', build: 26300, arch: '64-bit', isWindows11: true },
    signature: TEST_SIGNATURE,
    detectedAt: '2026-01-01T00:00:00.000Z',
    warnings: [],
  };
  return { ...spec, ...overrides };
}

/** Build a preset and run it through the real schema, so an invalid factory throws. */
export function makePreset(overrides: Record<string, unknown> = {}): Preset {
  const base: Record<string, unknown> = {
    schemaVersion: 1,
    signatureVersion: 1,
    id: 'test-preset',
    name: 'Test Preset',
    version: '1.0.0',
    description: 'A preset used by the unit tests to exercise policy and compilation.',
    authors: [{ handle: 'tester' }],
    license: 'MIT',
    risk: 'moderate',
    tags: ['gaming'],
    compatibility: {},
    profiles: [
      {
        id: 'base',
        name: 'Base',
        actions: {
          registry: [
            {
              op: 'set',
              hive: 'HKCU',
              path: 'System\\GameConfigStore',
              name: 'GameDVR_Enabled',
              type: 'REG_DWORD',
              data: 0,
            },
          ],
        },
      },
    ],
  };
  return presetSchema.parse({ ...base, ...overrides });
}

export function groupOf(action: PresetAction): StepGroup {
  switch (action.kind) {
    case 'registry':
      return 'Registry';
    case 'service':
      return 'Services';
    case 'priority':
      return 'Priorities';
    case 'power-plan':
    case 'power-setting':
      return 'Power';
    case 'device-interrupt':
    case 'irq-priority':
    case 'network':
      return 'Registry';
  }
}

export function makePlan(actions: PresetAction[], overrides: Partial<CompiledPlan> = {}): CompiledPlan {
  const steps: PlannedStep[] = actions.map((action, index) => ({
    key: `k${index}`,
    group: groupOf(action),
    label: `step-${index}`,
    target: `target-${index}`,
    detail: 'test',
    volatile: false,
    action,
    profileId: 'base',
  }));

  const summary: Record<StepGroup, number> = { Registry: 0, Services: 0, Priorities: 0, Power: 0 };
  for (const step of steps) summary[step.group] += 1;

  return {
    presetId: 'test-preset',
    presetName: 'Test Preset',
    presetVersion: '1.0.0',
    risk: 'moderate',
    signature: TEST_SIGNATURE,
    compatibility: { applicable: true, score: 1, specified: 0, matched: 0, reasons: [] },
    activeProfiles: [{ id: 'base', name: 'Base', conditional: false }],
    steps,
    findings: [],
    blocked: false,
    needsConsent: false,
    warnings: [],
    restorePoint: 'preferred',
    summary,
    overrides: 0,
    ...overrides,
  };
}

export const registryAction = (name = 'Value'): PresetAction => ({
  kind: 'registry',
  op: 'set',
  hive: 'HKCU',
  path: 'Control Panel\\Mouse',
  name,
  type: 'REG_SZ',
  data: '0',
});

export class FakeAdapter implements StepAdapter {
  applied: string[] = [];
  restored: string[] = [];
  captured: string[] = [];
  failOnApply = new Set<string>();
  failOnCapture = new Set<string>();
  states = new Map<string, CapturedState>();

  async capture(step: PlannedStep): Promise<CapturedState> {
    this.captured.push(step.key);
    if (this.failOnCapture.has(step.key)) throw new Error(`capture exploded for ${step.key}`);
    const preset = this.states.get(step.key);
    if (preset !== undefined) return preset;
    return { kind: 'registry', target: step.target, exists: false };
  }

  async apply(step: PlannedStep, _before: CapturedState): Promise<void> {
    if (this.failOnApply.has(step.key)) throw new Error(`apply exploded for ${step.key}`);
    this.applied.push(step.key);
  }

  async restore(state: CapturedState): Promise<void> {
    this.restored.push(state.target);
  }
}
