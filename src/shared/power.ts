/**
 * Power plan vocabulary.
 *
 * Presets never supply GUIDs. They select a friendly id from the tables below, and
 * the engine translates it. That keeps an untrusted file from pointing `powercfg` at
 * an arbitrary setting, and it makes the vocabulary reviewable.
 *
 * VERIFICATION
 * Every GUID here was read back from a live Windows 11 host via
 * `powercfg -query SCHEME_CURRENT <subgroup>` before being committed. That matters:
 * several GUIDs in wide circulation online are wrong, notably PCIe link state
 * management, which is `ee12f906-...-e5fa1a576df5` and not the frequently copied
 * `...-e23bddde8f4c`.
 *
 * DELIBERATE EXCLUSIONS
 * - "Ultimate Performance" has no stable GUID (Windows duplicates it per machine), so
 *   it cannot be expressed as a fixed target.
 * - Hidden settings are excluded: `powercfg -query` does not report their current
 * - Hidden settings are excluded unless they can be read through the official
 *   `PowerReadACValue` API. EPP and core-parking maximum are hidden from `powercfg -query`
 *   on Windows 11, but their effective AC values are still readable through that API.
 */

export const POWER_PLAN_IDS = ['balanced', 'high-performance', 'power-saver'] as const;
export type PowerPlanId = (typeof POWER_PLAN_IDS)[number];

export const POWER_SUBGROUPS = {
  processor: '54533251-82be-4824-96c1-47b60b740d00',
  usb: '2a737441-1930-4402-8d77-b2bebba308a3',
  pcie: '501a4d13-42af-4429-9fd1-a8218c268e20',
  disk: '0012ee47-9041-4b5d-9b77-535fba8b1442',
} as const;

export type PowerSubgroupId = keyof typeof POWER_SUBGROUPS;

/** Well-known plans. These three GUIDs are stable across Windows 10 and 11. */
export const POWER_PLANS: Record<PowerPlanId, { guid: string; label: string }> = {
  balanced: { guid: '381b4222-f694-41f0-9685-ff5bb260df2e', label: 'Balanced' },
  'high-performance': { guid: '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c', label: 'High performance' },
  'power-saver': { guid: 'a1841308-3541-4fab-bc81-f71556f20b4a', label: 'Power saver' },
};

export const POWER_SETTING_IDS = [
  'processor-min-state',
  'processor-max-state',
  'core-parking-min-cores',
  'core-parking-max-cores',
  'energy-performance-preference',
  'usb-selective-suspend',
  'pcie-link-state',
  'disk-idle-timeout',
] as const;
export type PowerSettingId = (typeof POWER_SETTING_IDS)[number];

export type PowerValueKind = 'percent' | 'toggle' | 'enum' | 'seconds' | 'epp';

export interface PowerSettingMeta {
  subgroup: PowerSubgroupId;
  guid: string;
  label: string;
  kind: PowerValueKind;
  min: number;
  max: number;
  /** `powercfg -query` cannot report some processor settings; read those via powrprof. */
  readVia?: 'powercfg' | 'power-api';
  /** Short explanation shown in the plan preview. */
  note: string;
}

export const POWER_SETTINGS: Record<PowerSettingId, PowerSettingMeta> = {
  'processor-min-state': {
    subgroup: 'processor',
    guid: '893dee8e-2bef-41e0-89c6-b55d0929964c',
    label: 'Minimum processor state',
    kind: 'percent',
    min: 0,
    max: 100,
    note: 'Raising this keeps clocks high; it also raises idle heat and power draw.',
  },
  'processor-max-state': {
    subgroup: 'processor',
    guid: 'bc5038f7-23e0-4960-96da-33abaf5935ec',
    label: 'Maximum processor state',
    kind: 'percent',
    min: 0,
    max: 100,
    note: 'Lowering this throttles the CPU. Presets should normally keep it at 100.',
  },
  'core-parking-min-cores': {
    subgroup: 'processor',
    guid: '0cc5b647-c1df-4637-891a-dec35c318583',
    label: 'Processor performance core parking min cores',
    kind: 'percent',
    min: 0,
    max: 100,
    note: '100% keeps every core unparked, which reduces scheduling jitter. This is system-wide, not per-game.',
  },
  'core-parking-max-cores': {
    subgroup: 'processor',
    guid: 'ea062031-0e34-4ff1-9b6d-eb1059334028',
    label: 'Processor performance core parking max cores',
    kind: 'percent',
    min: 0,
    max: 100,
    readVia: 'power-api',
    note: 'Caps the percentage of cores that may stay unparked. Pair with min cores 100 to keep every core available; this is system-wide and raises idle power.',
  },
  'energy-performance-preference': {
    subgroup: 'processor',
    guid: '36687f9e-e3a5-4dbf-b1dc-15eb381c6863',
    label: 'Energy Performance Preference (EPP)',
    kind: 'epp',
    min: 0,
    max: 100,
    readVia: 'power-api',
    note: '0 biases the CPU toward performance and 100 toward energy savings. Windows applies this through HWP/Speed Shift when the CPU and firmware expose it; it is a frequency/energy hint, not thread placement.',
  },
  'usb-selective-suspend': {
    subgroup: 'usb',
    guid: '48e6b7a6-50f5-4782-a5d4-53bb8f07e226',
    label: 'USB selective suspend',
    kind: 'toggle',
    min: 0,
    max: 1,
    note: 'Disabling prevents USB devices (including some mice and audio interfaces) from suspending.',
  },
  'pcie-link-state': {
    subgroup: 'pcie',
    guid: 'ee12f906-d277-404b-b6da-e5fa1a576df5',
    label: 'PCI Express link state power management',
    kind: 'enum',
    min: 0,
    max: 2,
    note: '0 = off. Reduces GPU/SSD wake latency at the cost of idle power.',
  },
  'disk-idle-timeout': {
    subgroup: 'disk',
    guid: '6738e2c4-e8a5-4a42-b16a-e040e769756e',
    label: 'Turn off hard disk after',
    kind: 'seconds',
    min: 0,
    max: 86400,
    note: '0 means never. Only meaningful for spinning disks; SSDs ignore it.',
  },
};

export function powerSettingValueRange(setting: PowerSettingId): { min: number; max: number } {
  const meta = POWER_SETTINGS[setting];
  return { min: meta.min, max: meta.max };
}

export function describePowerSetting(setting: PowerSettingId, value: number): string {
  const meta = POWER_SETTINGS[setting];
  switch (meta.kind) {
    case 'percent':
      return `${value}%`;
    case 'toggle':
      return value === 1 ? 'enabled' : 'disabled';
    case 'enum':
      if (setting === 'pcie-link-state') return ['Off', 'Moderate', 'Maximum savings'][value] ?? String(value);
      return String(value);
    case 'seconds':
      return value === 0 ? 'never' : `${value}s`;
    case 'epp': {
      const hex = `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
      if (value === 0) return `0% (${hex}) — maximum performance`;
      if (value === 100) return `100% (${hex}) — maximum energy savings`;
      return `${value}% (${hex})`;
    }
  }
}
