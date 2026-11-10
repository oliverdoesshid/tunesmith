/**
 * Compiler: preset + machine -> ordered, deduplicated, typed execution plan.
 *
 * This is the only place where preset JSON becomes actions, and the transformation
 * is total: every emitted step is one of the six shapes in `PresetAction`. The
 * executor never re-reads preset JSON.
 */
import { describePowerSetting, POWER_PLANS } from '../power';
import type { HardwareSpec, PresetAction } from '../types';
import type { Preset, PresetProfile } from './schema';
import { evaluateCompatibility, evaluateCondition, type CompatibilityResult } from './matcher';
import { evaluatePresetPolicy, summarizeFindings, type PolicyFinding } from './policy';

export type StepGroup = 'Registry' | 'Services' | 'Priorities' | 'Power';

export interface PlannedStep {
  /** Stable dedupe key: a later profile overrides an earlier step with the same key. */
  key: string;
  group: StepGroup;
  label: string;
  /** Canonical target, used by the journal and shown in the diff. */
  target: string;
  detail: string;
  /** True when the change is not persisted across process or system restarts. */
  volatile: boolean;
  action: PresetAction;
  profileId: string;
}

export interface CompiledPlan {
  presetId: string;
  presetName: string;
  presetVersion: string;
  risk: Preset['risk'];
  signature: string;
  compatibility: CompatibilityResult;
  activeProfiles: { id: string; name: string; conditional: boolean }[];
  steps: PlannedStep[];
  findings: PolicyFinding[];
  blocked: boolean;
  needsConsent: boolean;
  warnings: string[];
  restorePoint: 'required' | 'preferred' | 'none';
  summary: Record<StepGroup, number>;
  /** Number of steps replaced because a later profile targeted the same thing. */
  overrides: number;
}

const GROUP_ORDER: Record<StepGroup, number> = { Registry: 0, Services: 1, Priorities: 2, Power: 3 };
const ACTION_ORDER: Record<PresetAction['kind'], number> = {
  registry: 0,
  service: 1,
  priority: 2,
  'power-plan': 3,
  'power-setting': 4,
  // Registry-backed latency actions run after the raw registry writes they resemble.
  'device-interrupt': 5,
  'irq-priority': 6,
  network: 7,
};

function stepKey(action: PresetAction): string {
  switch (action.kind) {
    case 'registry':
      return `reg|${action.hive}\\${action.path}\\${action.name}`.toLowerCase();
    case 'service':
      return `svc|${action.name}`.toLowerCase();
    case 'priority':
      return `pri|${action.process}`.toLowerCase();
    case 'power-plan':
      return 'power|plan';
    case 'power-setting':
      return `power|${action.setting}`;
    case 'device-interrupt':
      return `msi|${action.deviceClass}`;
    case 'irq-priority':
      return `irq|${action.irq}`;
    case 'network':
      return 'network|tcp';
  }
}

function groupOf(action: PresetAction): StepGroup {
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
    // Interrupt and TCP tweaks are registry-backed; they render in the Registry
    // group so the plan summary and the UI diff need no new sections.
    case 'device-interrupt':
    case 'irq-priority':
    case 'network':
      return 'Registry';
  }
}

function formatRegData(type: string, data: string | number): string {
  return type === 'REG_DWORD' || type === 'REG_QWORD' ? `${data} (0x${Number(data).toString(16)})` : JSON.stringify(data);
}

function toStep(profileId: string, action: PresetAction): PlannedStep {
  const group = groupOf(action);
  const base = { key: stepKey(action), group, profileId, action };

  switch (action.kind) {
    case 'registry': {
      const target = `${action.hive}\\${action.path}\\${action.name}`;
      const isSet = action.op === 'set';
      return {
        ...base,
        target,
        label: isSet ? `Set ${action.name}` : `Delete ${action.name}`,
        detail: isSet ? `${formatRegData(action.type, action.data)} · ${action.type}` : 'remove value (restored on rollback)',
        volatile: false,
      };
    }
    case 'service': {
      const parts: string[] = [];
      if (action.startup) parts.push(`startup -> ${action.startup}${action.delayedStart ? ' (delayed)' : ''}`);
      if (action.stop) parts.push('stop now');
      return {
        ...base,
        target: `service:${action.name}`,
        label: action.name,
        detail: parts.join(' · '),
        volatile: false,
      };
    }
    case 'priority':
      return {
        ...base,
        target: `process:${action.process}`,
        label: action.process,
        detail: `priority -> ${action.priority}`,
        volatile: true,
      };
    case 'power-plan':
      return {
        ...base,
        target: 'power:plan',
        label: 'Active power plan',
        detail: `-> ${POWER_PLANS[action.plan].label}`,
        volatile: false,
      };
    case 'power-setting': {
      const label = describePowerSetting(action.setting, action.value);
      return {
        ...base,
        target: `power:${action.setting}`,
        label: action.setting,
        detail: `-> ${label}`,
        volatile: false,
      };
    }
    case 'device-interrupt': {
      const what = action.deviceClass === 'gpu' ? 'GPU' : 'network adapters';
      return {
        ...base,
        target: `interrupt:${action.deviceClass}`,
        label: `Enable MSI-X (${what})`,
        detail:
          action.messageLimit !== undefined
            ? `MSISupported -> 1 · MessageNumberLimit -> ${action.messageLimit}`
            : 'MSISupported -> 1 on every PCI device of this class',
        volatile: false,
      };
    }
    case 'irq-priority':
      return {
        ...base,
        target: `irq:${action.irq}`,
        label: `IRQ ${action.irq} priority`,
        detail: `-> ${action.priority === 'high' ? 'High' : 'Normal'} (every device on the line)`,
        volatile: false,
      };
    case 'network': {
      const parts: string[] = [];
      if (action.tcpAckFrequency !== undefined) parts.push(`TcpAckFrequency=${action.tcpAckFrequency}`);
      if (action.tcpNoDelay !== undefined) parts.push(`TCPNoDelay=${action.tcpNoDelay}`);
      return {
        ...base,
        target: 'network:tcp',
        label: 'TCP latency (all active interfaces)',
        detail: parts.join(' · '),
        volatile: false,
      };
    }
  }
}

/**
 * Profiles active on this machine, in declaration order.
 *
 * A conditional profile is active when its `when` clause matches AND (if it declares
 * `extends`) the profile it extends is itself active. That gives presets a clean way
 * to ship variants without repeating the base tuning.
 */
export function resolveActiveProfiles(preset: Preset, spec: HardwareSpec): PresetProfile[] {
  const active: PresetProfile[] = [];
  const activeIds = new Set<string>();

  for (const profile of preset.profiles) {
    const conditionResult = profile.when ? evaluateCondition(profile.when, spec) : { active: true, reasons: [] };
    const extendsOk = profile.extends === undefined || activeIds.has(profile.extends);
    if (conditionResult.active && extendsOk) {
      active.push(profile);
      activeIds.add(profile.id);
    }
  }

  return active;
}

export function compilePlan(preset: Preset, spec: HardwareSpec): CompiledPlan {
  const findings = evaluatePresetPolicy(preset);
  const policy = summarizeFindings(findings);
  const compatibility = evaluateCompatibility(preset.compatibility, spec);
  const profiles = resolveActiveProfiles(preset, spec);

  const byKey = new Map<string, PlannedStep>();
  let overrides = 0;

  for (const profile of profiles) {
    const actions: PresetAction[] = [];

    for (const entry of profile.actions.registry ?? []) {
      if (entry.op === 'delete') {
        actions.push({ kind: 'registry', op: 'delete', hive: entry.hive, path: entry.path, name: entry.name });
      } else if (entry.type !== undefined && entry.data !== undefined) {
        actions.push({
          kind: 'registry',
          op: 'set',
          hive: entry.hive,
          path: entry.path,
          name: entry.name,
          type: entry.type,
          data: entry.data,
        });
      }
    }
    for (const entry of profile.actions.services ?? []) {
      actions.push({
        kind: 'service',
        name: entry.name,
        ...(entry.startup !== undefined ? { startup: entry.startup } : {}),
        ...(entry.delayedStart !== undefined ? { delayedStart: entry.delayedStart } : {}),
        ...(entry.stop !== undefined ? { stop: entry.stop } : {}),
      });
    }
    for (const entry of profile.actions.priorities ?? []) {
      actions.push({ kind: 'priority', process: entry.process, priority: entry.priority });
    }
    if (profile.actions.power?.plan) {
      actions.push({ kind: 'power-plan', plan: profile.actions.power.plan });
    }
    for (const entry of profile.actions.power?.settings ?? []) {
      actions.push({ kind: 'power-setting', setting: entry.setting, value: entry.value });
    }
    for (const entry of profile.actions.deviceInterrupts ?? []) {
      actions.push({
        kind: 'device-interrupt',
        deviceClass: entry.deviceClass,
        ...(entry.messageLimit !== undefined ? { messageLimit: entry.messageLimit } : {}),
      });
    }
    for (const entry of profile.actions.irqPriorities ?? []) {
      actions.push({ kind: 'irq-priority', irq: entry.irq, priority: entry.priority });
    }
    for (const entry of profile.actions.network ?? []) {
      actions.push({
        kind: 'network',
        ...(entry.tcpAckFrequency !== undefined ? { tcpAckFrequency: entry.tcpAckFrequency } : {}),
        ...(entry.tcpNoDelay !== undefined ? { tcpNoDelay: entry.tcpNoDelay } : {}),
      });
    }

    for (const action of actions) {
      const step = toStep(profile.id, action);
      if (byKey.has(step.key)) overrides += 1;
      byKey.set(step.key, step);
    }
  }

  const steps = [...byKey.values()].sort((a, b) => {
    const g = GROUP_ORDER[a.group] - GROUP_ORDER[b.group];
    if (g !== 0) return g;
    // Within Power, switch the plan before writing its per-setting values.
    return ACTION_ORDER[a.action.kind] - ACTION_ORDER[b.action.kind];
  });

  const summary: Record<StepGroup, number> = { Registry: 0, Services: 0, Priorities: 0, Power: 0 };
  for (const step of steps) summary[step.group] += 1;

  return {
    presetId: preset.id,
    presetName: preset.name,
    presetVersion: preset.version,
    risk: preset.risk,
    signature: spec.signature,
    compatibility,
    activeProfiles: profiles.map((p) => ({ id: p.id, name: p.name, conditional: p.when !== undefined })),
    steps,
    findings,
    blocked: policy.blocked,
    needsConsent: policy.needsConsent,
    warnings: policy.warningsList,
    restorePoint: preset.requires?.restorePoint ?? 'preferred',
    summary,
    overrides,
  };
}
