/**
 * Affinity maths. Pure, testable, and paranoid: a game pinned to zero cores hangs the
 * desktop, so every strategy falls back to "all cores" rather than returning an empty mask.
 *
 * Multi-group support: Windows exposes at most 64 logical processors per processor
 * group, and `SetProcessAffinityMask` only affects the process's primary group. Above 64
 * processors (Threadripper PRO, multi-socket Xeon) the machine is therefore described as
 * several groups, and a selection is expressed as one mask *per group*. Logical processor
 * indices here are global (group offset + index within group), which keeps custom
 * affinity lists in a profile unambiguous.
 */
import type { AffinityGroupMask, AffinityPlan, AffinitySelection, CpuTopology } from './types';

/** A group flattened into the global index space used by every strategy below. */
export interface ResolvedGroup {
  index: number;
  offset: number;
  count: number;
}

// Windows 11 Pro for Workstations supports four groups of 64 logical processors. The
// groups array is capped to the same number so a malformed topology cannot claim more.
const MAX_GROUPS = 4;
const MAX_LOGICAL = MAX_GROUPS * 64;

/**
 * Groups actually present on the machine.
 *
 * Older fixtures and synthetic topologies predate `groups`, so a single implicit group
 * covers `logicalProcessors`. That keeps the single-group path behaving exactly as before.
 */
export function resolveGroups(topology: CpuTopology): ResolvedGroup[] {
  const declared = topology.groups ?? [];
  if (declared.length > 0) {
    const groups: ResolvedGroup[] = [];
    let offset = 0;
    for (const group of declared.slice(0, MAX_GROUPS)) {
      const count = Math.max(0, Math.min(64, Math.floor(group.count)));
      groups.push({ index: group.index, offset, count });
      offset += count;
    }
    return groups;
  }

  const count = Math.max(0, Math.min(64, topology.logicalProcessors));
  return count > 0 ? [{ index: 0, offset: 0, count }] : [];
}

export function totalLogicalProcessors(topology: CpuTopology): number {
  const explicit = topology.totalLogicalProcessors;
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  return resolveGroups(topology).reduce((sum, group) => sum + group.count, 0);
}

function groupForGlobal(groups: readonly ResolvedGroup[], global: number): ResolvedGroup | null {
  for (const group of groups) {
    if (global >= group.offset && global < group.offset + group.count) return group;
  }
  return null;
}

function allLogical(topology: CpuTopology): number[] {
  return Array.from({ length: totalLogicalProcessors(topology) }, (_, index) => index);
}

function classAt(topology: CpuTopology, index: number): number {
  return topology.efficiencyClasses[index] ?? 0;
}

function coreAt(topology: CpuTopology, index: number): number {
  return topology.coreIndices[index] ?? index;
}

/** One logical processor per physical core: avoids SMT contention on latency-bound games. */
function physicalOnly(topology: CpuTopology): number[] {
  const seen = new Set<number>();
  const picked: number[] = [];
  for (const index of allLogical(topology)) {
    const core = coreAt(topology, index);
    if (seen.has(core)) continue;
    seen.add(core);
    picked.push(index);
  }
  return picked;
}

function byEfficiency(topology: CpuTopology, plan: AffinityPlan, wantFastest: boolean): number[] {
  const classes = allLogical(topology).map((index) => classAt(topology, index));
  const highest = Math.max(...classes);
  const lowest = Math.min(...classes);
  if (highest === lowest) return [];

  const preference = plan.performanceClass ?? 'highest';
  const target = wantFastest
    ? preference === 'highest'
      ? highest
      : lowest
    : preference === 'highest'
      ? lowest
      : highest;

  return allLogical(topology).filter((index) => classAt(topology, index) === target);
}

export function maskFromCores(cores: readonly number[]): bigint {
  return cores.reduce((mask, index) => mask | (1n << BigInt(index)), 0n);
}

export function maskToHex(mask: bigint): string {
  return `0x${mask.toString(16).toUpperCase()}`;
}

export function describeCores(cores: readonly number[]): string {
  if (cores.length === 0) return 'none';
  if (cores.length > 12) return `${cores.length} logical processors`;
  return cores.join(', ');
}

/** Split global indices into one mask per processor group. */
export function groupMasksFromCores(
  cores: readonly number[],
  groups: readonly ResolvedGroup[],
): AffinityGroupMask[] {
  const byGroup = new Map<number, bigint>();

  for (const global of cores) {
    const group = groupForGlobal(groups, global);
    if (group === null) continue;
    const local = global - group.offset;
    if (local < 0 || local >= 64) continue;
    byGroup.set(group.index, (byGroup.get(group.index) ?? 0n) | (1n << BigInt(local)));
  }

  return [...byGroup.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, mask]) => ({ index, mask: maskToHex(mask) }));
}

/**
 * Resolve a plan against the detected topology.
 *
 * `reason` is surfaced in the UI and the session log, because "pinned to 0,2,4,6" is the
 * kind of change a user must be able to see and dispute.
 */
export function computeAffinityMask(topology: CpuTopology, plan: AffinityPlan): AffinitySelection {
  const groups = resolveGroups(topology);
  const total = totalLogicalProcessors(topology);

  if (groups.length === 0 || total < 1 || total > MAX_LOGICAL) {
    return {
      mask: 0n,
      cores: [],
      groups: [],
      reason: `Unsupported processor count (${total}); this build supports 1-${MAX_LOGICAL} logical processors across ${MAX_GROUPS} groups.`,
    };
  }

  const build = (cores: number[], reason: string): AffinitySelection => {
    const masks = groupMasksFromCores(cores, groups);
    return {
      mask: maskFromCores(cores.filter((index) => index < 64)),
      cores,
      groups: masks,
      reason,
    };
  };

  const groupSuffix = groups.length > 1 ? ` across ${groups.length} processor groups` : '';

  const fallback = (why: string): AffinitySelection => build(allLogical(topology), why);

  switch (plan.strategy) {
    case 'all-cores':
      return fallback(`All logical processors${groupSuffix}.`);

    case 'physical-cores': {
      const cores = physicalOnly(topology);
      if (cores.length === 0) return fallback('Could not resolve physical cores; using every processor.');
      return build(cores, `One thread per physical core (${cores.length} of ${total})${groupSuffix}.`);
    }

    case 'performance-cores': {
      if (!topology.hybrid) return fallback('CPU is not hybrid; there are no separate performance cores.');
      const cores = byEfficiency(topology, plan, true);
      if (cores.length === 0) return fallback('No performance cores matched the reported efficiency classes.');
      return build(cores, `Performance cores only (${cores.length} of ${total} logical processors${groupSuffix}).`);
    }

    case 'efficiency-cores': {
      if (!topology.hybrid) return fallback('CPU is not hybrid; there are no separate efficiency cores.');
      const cores = byEfficiency(topology, plan, false);
      if (cores.length === 0) return fallback('No efficiency cores matched the reported efficiency classes.');
      return build(cores, `Efficiency cores only (${cores.length} of ${total} logical processors${groupSuffix}).`);
    }

    case 'custom': {
      const requested = plan.cores ?? [];
      const valid = [...new Set(requested)].filter(
        (index) => Number.isInteger(index) && index >= 0 && index < total,
      );
      if (valid.length === 0) return fallback('No valid logical processors were requested; using every processor.');
      const dropped = requested.length - valid.length;
      return build(
        valid,
        dropped > 0
          ? `${valid.length} requested processors (${dropped} invalid index/indices ignored)${groupSuffix}.`
          : `${valid.length} requested processors${groupSuffix}.`,
      );
    }
  }
}

/** A mask is usable when it selects at least one logical processor that exists. */
export function isUsableMask(selection: AffinitySelection, topology: CpuTopology): boolean {
  if (selection.groups.length === 0 && selection.mask === 0n) return false;
  const total = totalLogicalProcessors(topology);
  return selection.cores.some((index) => index >= 0 && index < total);
}
