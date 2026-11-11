/**
 * Per-machine adaptation of game profiles.
 *
 * A profile is authored for a class of machines, not for the exact machine in front of it.
 * This module narrows it at activation time using facts the detector already produced —
 * core count, hybrid split, RAM and GPU kind — with no model, no network and no background
 * process. The result is deterministic, explainable, and costs nothing while a game runs.
 *
 * Rules are intentionally conservative: adaptation can only *reduce* aggressiveness
 * (fall back to all cores, drop extra suspensions, switch off the timer hold, skip a GPU
 * preference that does nothing). It never invents an action the profile did not contain.
 */
import type { HardwareSpec } from '../types';
import type { BackgroundRule, CpuTopology, GameProfile, GameProfileActions } from './types';

export type MachineTier = 'low' | 'mid' | 'high';

export interface MachineProfile {
  tier: MachineTier;
  logicalProcessors: number;
  physicalCores: number;
  hybrid: boolean;
  /** RAM tier in GB, or null when detection could not read it. */
  memoryGb: number | null;
  gpuKind: 'discrete' | 'integrated' | 'virtual' | 'none' | 'unknown';
  reasons: string[];
}

export interface AdaptationChange {
  code: string;
  target: string;
  message: string;
}

/** Fallback machine profile when hardware detection is unavailable (tests, early boot). */
export function describeMachine(spec: HardwareSpec | null, topology: CpuTopology): MachineProfile {
  const threads =
    spec !== null && spec.cpu.threads > 0 ? spec.cpu.threads : topology.logicalProcessors;
  const cores = spec !== null && spec.cpu.cores > 0 ? spec.cpu.cores : topology.physicalCores;
  const memoryGb = spec?.memory.bucketGb ?? null;
  const gpuKind: MachineProfile['gpuKind'] =
    spec === null ? 'unknown' : spec.primaryGpu === null ? 'none' : spec.primaryGpu.kind;

  const low = threads <= 4 || (memoryGb !== null && memoryGb <= 8);
  const high =
    !low && threads >= 16 && (memoryGb === null || memoryGb >= 32) && gpuKind === 'discrete';
  const tier: MachineTier = low ? 'low' : high ? 'high' : 'mid';

  const reasons = [
    `${threads} logical processor(s)`,
    memoryGb === null ? 'RAM tier unknown' : `${memoryGb} GB RAM tier`,
    gpuKind === 'unknown' ? 'GPU kind unknown' : `${gpuKind} GPU`,
  ];

  return {
    tier,
    logicalProcessors: threads,
    physicalCores: cores,
    hybrid: topology.hybrid,
    memoryGb,
    gpuKind,
    reasons,
  };
}

function suspendCap(machine: MachineProfile): number {
  if (machine.logicalProcessors <= 4) return 2;
  if (machine.logicalProcessors <= 8) return 6;
  return 12;
}

/** Clone only the fields that adaptation may touch; everything else stays by reference. */
function cloneActions(actions: GameProfileActions): GameProfileActions {
  return {
    ...actions,
    ...(actions.affinity !== undefined ? { affinity: { ...actions.affinity } } : {}),
    ...(actions.backgroundRules !== undefined
      ? { backgroundRules: actions.backgroundRules.map((rule) => ({ ...rule })) }
      : {}),
  };
}

export function adaptGameProfile(
  profile: Pick<GameProfile, 'actions'>,
  machine: MachineProfile,
): { actions: GameProfileActions; changes: AdaptationChange[] } {
  const actions = cloneActions(profile.actions);
  const changes: AdaptationChange[] = [];

  const strategy = actions.affinity?.strategy;
  if ((strategy === 'performance-cores' || strategy === 'physical-cores') && machine.logicalProcessors <= 6) {
    actions.affinity = { strategy: 'all-cores' };
    changes.push({
      code: 'affinity-all-cores',
      target: 'affinity',
      message: `${machine.logicalProcessors} logical processors: pinning ${strategy} would leave too little for Windows and input, so all cores are used.`,
    });
  }

  const rules = actions.backgroundRules;
  if (rules !== undefined) {
    const cap = suspendCap(machine);
    let suspended = 0;
    let dropped = 0;
    const kept: BackgroundRule[] = [];
    for (const rule of rules) {
      if (rule.action !== 'suspend') {
        kept.push(rule);
        continue;
      }
      if (suspended < cap) {
        suspended += 1;
        kept.push(rule);
      } else {
        dropped += 1;
      }
    }
    if (dropped > 0) {
      actions.backgroundRules = kept;
      changes.push({
        code: 'suspend-cap',
        target: 'background suspension',
        message: `${machine.logicalProcessors} logical processors: suspending more than ${cap} background processes can starve the game's own launcher or voice chat, so ${dropped} rule(s) were dropped.`,
      });
    } else {
      actions.backgroundRules = kept;
    }
  }

  if (actions.timerHold === true && machine.tier === 'low') {
    actions.timerHold = false;
    changes.push({
      code: 'timer-hold-off',
      target: 'global timer',
      message: 'The 0.5 ms timer hold is not enabled on a low-tier machine: its power and heat cost outweighs the scheduling benefit there.',
    });
  }

  if (
    actions.gpuPreference === 'high-performance' &&
    machine.gpuKind !== 'unknown' &&
    machine.gpuKind !== 'discrete'
  ) {
    delete actions.gpuPreference;
    changes.push({
      code: 'gpu-preference-skip',
      target: 'GPU preference',
      message: `No discrete GPU is present (${machine.gpuKind}); a high-performance preference would have no effect and is skipped.`,
    });
  }

  return { actions, changes };
}
