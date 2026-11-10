/**
 * CPU topology, including the P-core / E-core split and Windows processor groups.
 *
 * `EfficiencyClass` from `GetSystemCpuSetInformation` is the only documented source of the
 * hybrid split; `Group` from the same structure is the only source of the processor-group
 * split. Both are emitted by the static script in `scripts.ts`.
 *
 * Everything degrades to a synthetic, single-group topology rather than failing, because
 * affinity control should still work on a machine where the CIM provider or the interop
 * call is unavailable.
 */
import { describeError, TuneSmithError } from '../../../shared/errors';
import type { CpuTopology, ProcessorGroup } from '../../../shared/game/types';
import { runPowerShellJson } from '../powershell';
import { TOPOLOGY_SCRIPT } from './scripts';

interface RawCpuSet {
  cpusets?:
    | { group?: number; logical?: number; core?: number; efficiency?: number }[]
    | { group?: number; logical?: number; core?: number; efficiency?: number }
    | null;
}

interface RawRow {
  group: number;
  logical: number;
  core: number;
  efficiency: number;
}

const CACHE_MS = 10 * 60 * 1000;

let cache: { value: CpuTopology; at: number } | null = null;

function maskHexFor(count: number): string {
  const bits = Math.max(0, Math.min(64, count));
  if (bits === 0) return '0x0';
  const mask = (1n << BigInt(bits)) - 1n;
  return `0x${mask.toString(16).toUpperCase()}`;
}

/** Build a topology when the interop is unavailable: one group, SMT pairs, no hybrid split. */
export function syntheticTopology(cores: number, threads: number): CpuTopology {
  const logical = Math.max(1, Math.min(64, threads > 0 ? threads : cores > 0 ? cores : 1));
  const physical = Math.max(1, cores > 0 ? Math.min(cores, logical) : logical);

  // With SMT, thread i and thread i+physical belong to the same core on every
  // mainstream topology, which is exactly what the scheduler does for the first pass.
  const coreIndices = Array.from({ length: logical }, (_, index) => index % physical);

  return {
    logicalProcessors: logical,
    totalLogicalProcessors: logical,
    groups: [{ index: 0, count: logical, mask: maskHexFor(logical) }],
    physicalCores: physical,
    hybrid: false,
    efficiencyClasses: new Array<number>(logical).fill(0),
    coreIndices,
    source: 'synthetic',
    higherEfficiencyIsFaster: true,
  };
}

/**
 * Normalise raw CPU-set rows into a topology.
 *
 * Rows arrive with a per-group `LogicalProcessorIndex`, which repeats in every group, so
 * they are re-indexed into one global space (group offset + index). That is what keeps a
 * profile's custom core list unambiguous on a 128-thread Threadripper.
 *
 * Windows documents a higher `EfficiencyClass` as more performant. When every class is
 * identical there is no hybrid split to make, so `hybrid` stays false and strategies
 * that depend on it fall back rather than guessing.
 */
export function interpretCpusets(
  rows: readonly { group?: number; logical?: number; core?: number; efficiency?: number }[],
): CpuTopology | null {
  const valid: RawRow[] = rows
    .filter(
      (row) =>
        typeof row.logical === 'number' &&
        row.logical >= 0 &&
        row.logical < 64 &&
        (row.group === undefined || (Number.isInteger(row.group) && row.group >= 0 && row.group < 64)),
    )
    .map((row) => ({
      group: typeof row.group === 'number' ? row.group : 0,
      logical: row.logical as number,
      core: typeof row.core === 'number' ? row.core : (row.logical as number),
      efficiency: typeof row.efficiency === 'number' ? row.efficiency : 0,
    }))
    .sort((a, b) => (a.group === b.group ? a.logical - b.logical : a.group - b.group));

  if (valid.length === 0) return null;

  const groupNumbers = [...new Set(valid.map((row) => row.group))].sort((a, b) => a - b);
  const total = valid.length;
  const efficiencyClasses = new Array<number>(total).fill(0);
  const coreIndices = new Array<number>(total).fill(0);

  const groups: ProcessorGroup[] = [];
  const coreKeys = new Map<string, number>();
  let offset = 0;

  for (const groupNumber of groupNumbers) {
    const inGroup = valid.filter((row) => row.group === groupNumber);
    const present = inGroup.map((row) => row.logical);
    let mask = 0n;
    for (const logical of present) mask |= 1n << BigInt(logical);

    for (const row of inGroup) {
      const global = offset + row.logical;
      efficiencyClasses[global] = row.efficiency;
      const key = `${groupNumber}:${row.core}`;
      let coreId = coreKeys.get(key);
      if (coreId === undefined) {
        coreId = coreKeys.size;
        coreKeys.set(key, coreId);
      }
      coreIndices[global] = coreId;
    }

    groups.push({
      index: groupNumber,
      // The count is the group's *active* processor count, not the highest index + 1:
      // a group can have offline processors, and their indices must not shift the
      // global mapping.
      count: present.length,
      mask: `0x${mask.toString(16).toUpperCase()}`,
    });
    offset += present.length;
  }

  const classes = new Set(efficiencyClasses);

  return {
    logicalProcessors: total,
    totalLogicalProcessors: total,
    groups,
    physicalCores: Math.max(1, coreKeys.size),
    hybrid: classes.size > 1,
    efficiencyClasses,
    coreIndices,
    source: 'cpuset',
    higherEfficiencyIsFaster: true,
  };
}

export async function detectTopology(options: { force?: boolean } = {}): Promise<CpuTopology> {
  if (!options.force && cache !== null && Date.now() - cache.at < CACHE_MS) return cache.value;

  try {
    const raw = await runPowerShellJson<RawCpuSet>(TOPOLOGY_SCRIPT, { timeoutMs: 20_000 });
    const rows = raw.cpusets === null || raw.cpusets === undefined ? [] : Array.isArray(raw.cpusets) ? raw.cpusets : [raw.cpusets];
    const parsed = interpretCpusets(rows);
    if (parsed !== null) {
      cache = { value: parsed, at: Date.now() };
      return parsed;
    }
  } catch (error) {
    throw new TuneSmithError(
      'capture-failed',
      'Could not read the logical processor topology',
      error instanceof TuneSmithError ? error.detail : describeError(error),
    );
  }

  throw new TuneSmithError('capture-failed', 'The CPU-set query returned no logical processors');
}

export function clearTopologyCache(): void {
  cache = null;
}
