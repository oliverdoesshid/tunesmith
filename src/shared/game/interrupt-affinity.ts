/**
 * Interrupt-affinity planning.
 *
 * Windows exposes a documented per-device policy (`DevicePolicy` +
 * `AssignmentSetOverride`) that restricts the processors which may service a device's
 * interrupts. The mask is a KAFFINITY for one processor group, so this planner is
 * deliberately strict: it refuses multi-group machines rather than writing a mask that
 * would target the wrong group.
 *
 * The selected set is one logical processor per physical performance core. Choosing the
 * SMT sibling too would let the same physical core receive two interrupt streams, which
 * defeats the point of pinning; choosing every P-core gives Windows a small, consistent
 * target set while leaving E-cores and most background scheduling outside it.
 */
import { computeAffinityMask, maskFromCores, maskToHex, resolveGroups, totalLogicalProcessors } from './affinity';
import type { CpuTopology } from './types';

export interface InterruptAffinityPlan {
  /** One logical processor per selected physical core. */
  cores: number[];
  /** Hex mask for group 0, e.g. `0x55`. */
  mask: string;
  /** Little-endian bytes accepted by the registry's REG_BINARY value. */
  maskBytes: number[];
  reason: string;
}

export type InterruptAffinityPlanResult =
  | { plan: InterruptAffinityPlan; reason: null }
  | { plan: null; reason: string };

/** A 64-bit KAFFINITY little-endian byte sequence; bit N means logical processor N. */
export function interruptMaskBytes(cores: readonly number[]): number[] {
  const bytes = new Array<number>(8).fill(0);
  for (const core of cores) {
    if (!Number.isInteger(core) || core < 0 || core > 63) continue;
    bytes[Math.floor(core / 8)] = (bytes[Math.floor(core / 8)] ?? 0) | (1 << (core % 8));
  }
  return bytes;
}

/**
 * Resolve a safe interrupt target set. The caller must not write anything when this
 * returns `plan: null`.
 */
export function planInterruptAffinity(topology: CpuTopology): InterruptAffinityPlanResult {
  const groups = resolveGroups(topology);
  const total = totalLogicalProcessors(topology);

  if (groups.length > 1 || total > 64) {
    return {
      plan: null,
      reason:
        'Per-device interrupt affinity uses one 64-bit processor-group mask. This machine spans multiple processor groups, so the engine will not guess which group a device belongs to.',
    };
  }
  if (groups.length === 0 || total < 1) {
    return { plan: null, reason: 'The CPU topology reported no usable logical processors.' };
  }

  // Prefer the performance class on hybrid CPUs; otherwise use one thread per physical
  // core. computeAffinityMask falls back to all cores when a class cannot be resolved,
  // and the physical-core deduplication below keeps that fallback safe.
  const selection = computeAffinityMask(topology, {
    strategy: topology.hybrid ? 'performance-cores' : 'physical-cores',
  });

  const seenPhysical = new Set<number>();
  const cores: number[] = [];
  for (const logical of selection.cores) {
    if (!Number.isInteger(logical) || logical < 0 || logical >= total) continue;
    const physical = topology.coreIndices[logical] ?? logical;
    if (seenPhysical.has(physical)) continue;
    seenPhysical.add(physical);
    cores.push(logical);
  }

  if (cores.length === 0) {
    return { plan: null, reason: 'No physical performance cores could be resolved for interrupt affinity.' };
  }

  const mask = maskFromCores(cores);
  const target = topology.hybrid ? 'physical performance' : 'physical';
  return {
    plan: {
      cores,
      mask: maskToHex(mask),
      maskBytes: interruptMaskBytes(cores),
      reason: `Pinned to ${cores.length} ${target} core${cores.length === 1 ? '' : 's'} (${cores.join(', ')}).`,
    },
    reason: null,
  };
}
