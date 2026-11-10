/**
 * Process and graphics controls used by the game engine.
 *
 * Priority and affinity are pure .NET (`System.Diagnostics.Process`), so they need no
 * `Add-Type` compile and are fast enough to apply the moment a game takes focus.
 * Suspension needs `ntdll` and is batched into one process to amortise the compile.
 */
import { describeError, TuneSmithError } from '../../../shared/errors';
import type { AffinityGroupMask, GamePriority } from '../../../shared/game/types';
import type { PriorityClass, RegistryHive } from '../../../shared/types';
import { psQuote, runPowerShellJson } from '../powershell';
import { deleteValue, readValue, writeValue } from '../registry';
import { GROUP_AFFINITY_SCRIPT, PURGE_STANDBY_SCRIPT, SUSPEND_BATCH_SCRIPT } from './scripts';

const GPU_PREFERENCE_KEY = 'SOFTWARE\\Microsoft\\DirectX\\UserGpuPreferences';
const GPU_PREFERENCE_HIVE: RegistryHive = 'HKCU';

/** `2` is "High performance", `1` is "Power saving" in the Windows Graphics Settings UI. */
const GPU_PREFERENCE_VALUES = {
  'high-performance': 'GpuPreference=2;',
  'power-saving': 'GpuPreference=1;',
} as const;

export type GpuPreference = keyof typeof GPU_PREFERENCE_VALUES;

export interface ProcessOutcome {
  pid: number;
  ok: boolean;
}

/**
 * Set affinity and priority in one call.
 *
 * Both are same-user operations: `PROCESS_SET_INFORMATION` is granted to the owner, so
 * game mode works without elevation. Protected processes still refuse and surface as an
 * error rather than being retried forever.
 */
export async function applyAffinityAndPriority(
  pid: number,
  maskHex: string,
  priority: GamePriority | null,
  groups: readonly AffinityGroupMask[] = [],
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) throw new TuneSmithError('invalid-request', 'Invalid process id');
  if (!/^0x[0-9A-F]{1,16}$/i.test(maskHex)) throw new TuneSmithError('invalid-request', 'Invalid affinity mask');

  const setPriority =
    priority === null
      ? '$priorityApplied = $false'
      : `$proc.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::${priority}; $priorityApplied = $true`;

  // One group is the classic case: `ProcessorAffinity` is cheaper and has no interop
  // compile. Several groups need SetThreadGroupAffinity on every thread, because
  // SetProcessAffinityMask only ever affects the process's primary group.
  if (groups.length <= 1) {
    const singleMask = groups[0]?.mask ?? maskHex;
    const script = String.raw`
$targetPid = ${pid}
$mask = [Convert]::ToInt64(${psQuote(singleMask)}, 16)
try {
  $proc = Get-Process -Id $targetPid -ErrorAction Stop
  $proc.ProcessorAffinity = [IntPtr]$mask
  ${setPriority}
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
[pscustomobject]@{ ok = $true; priorityApplied = $priorityApplied } | ConvertTo-Json -Compress
`;

    try {
      await runPowerShellJson<{ ok: boolean }>(script, { timeoutMs: 15_000 });
    } catch (error) {
      throw new TuneSmithError(
        'apply-failed',
        `Could not set affinity for process ${pid}`,
        error instanceof TuneSmithError ? error.detail : describeError(error),
      );
    }
    return;
  }

  for (const group of groups) {
    if (!Number.isInteger(group.index) || group.index < 0 || group.index > 63) {
      throw new TuneSmithError('invalid-request', 'Invalid processor group index');
    }
    if (!/^0x[0-9A-F]{1,16}$/i.test(group.mask)) throw new TuneSmithError('invalid-request', 'Invalid group affinity mask');
  }

  // Masks become decimal UInt64 literals; the script can only ever see numbers here.
  const masks = groups.map((group) => BigInt(group.mask).toString()).join(', ');
  const indices = groups.map((group) => group.index).join(', ');
  const script = GROUP_AFFINITY_SCRIPT.replace('PID', String(pid))
    .replace('MASKS', masks)
    .replace('GROUPS', indices)
    .replace('PRIORITY_LINE', setPriority);

  try {
    await runPowerShellJson<{ ok: boolean }>(script, { timeoutMs: 20_000 });
  } catch (error) {
    throw new TuneSmithError(
      'apply-failed',
      `Could not set group affinity for process ${pid}`,
      error instanceof TuneSmithError ? error.detail : describeError(error),
    );
  }
}

/** Restore a priority after the session ends. Affinity dies with the process. */
export async function setProcessPriority(pid: number, priority: PriorityClass): Promise<void> {
  const script = String.raw`
$targetPid = ${pid}
try {
  $proc = Get-Process -Id $targetPid -ErrorAction Stop
  $proc.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::${priority}
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
[pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
`;
  await runPowerShellJson<{ ok: boolean }>(script, { timeoutMs: 15_000 });
}

export async function readProcessPriority(pid: number): Promise<PriorityClass | null> {
  const script = String.raw`
$targetPid = ${pid}
try {
  $proc = Get-Process -Id $targetPid -ErrorAction Stop
  $name = $proc.PriorityClass.ToString()
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
[pscustomobject]@{ priority = $name } | ConvertTo-Json -Compress
`;
  try {
    const result = await runPowerShellJson<{ priority?: string }>(script, { timeoutMs: 10_000 });
    const raw = result.priority;
    if (raw === undefined) return null;
    const known: PriorityClass[] = ['Idle', 'BelowNormal', 'Normal', 'AboveNormal', 'High'];
    return known.find((value) => value.toLowerCase() === raw.toLowerCase()) ?? null;
  } catch {
    return null;
  }
}

async function batchSuspend(mode: 'suspend' | 'resume', pids: readonly number[]): Promise<ProcessOutcome[]> {
  const safe = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (safe.length === 0) return [];

  const script = SUSPEND_BATCH_SCRIPT.replace('MODE', psQuote(mode)).replace('PIDS', safe.join(', '));
  const result = await runPowerShellJson<{ results?: ProcessOutcome[] | ProcessOutcome | null }>(script, { timeoutMs: 30_000 });
  const rows = result.results === null || result.results === undefined ? [] : Array.isArray(result.results) ? result.results : [result.results];

  const byPid = new Map<number, boolean>();
  for (const row of rows) {
    if (typeof row.pid === 'number') byPid.set(row.pid, row.ok === true);
  }
  return safe.map((pid) => ({ pid, ok: byPid.get(pid) === true }));
}

export function suspendProcesses(pids: readonly number[]): Promise<ProcessOutcome[]> {
  return batchSuspend('suspend', pids);
}

export function resumeProcesses(pids: readonly number[]): Promise<ProcessOutcome[]> {
  return batchSuspend('resume', pids);
}

/** Purge the standby list. Requires elevation; returns false instead of throwing. */
export async function purgeStandbyList(): Promise<boolean> {
  try {
    const result = await runPowerShellJson<{ ok?: boolean }>(PURGE_STANDBY_SCRIPT, { timeoutMs: 30_000 });
    return result.ok === true;
  } catch {
    return false;
  }
}

/** Current per-app GPU preference string, or null when the app has no entry. */
export async function readGpuPreference(exePath: string): Promise<string | null> {
  const snapshot = await readValue(GPU_PREFERENCE_HIVE, GPU_PREFERENCE_KEY, exePath);
  if (!snapshot.exists) return null;
  return typeof snapshot.data === 'string' ? snapshot.data : String(snapshot.data);
}

export async function writeGpuPreference(exePath: string, preference: GpuPreference): Promise<void> {
  await writeValue(GPU_PREFERENCE_HIVE, GPU_PREFERENCE_KEY, exePath, 'REG_SZ', GPU_PREFERENCE_VALUES[preference]);
}

export async function restoreGpuPreference(exePath: string, previous: string | null): Promise<void> {
  if (previous === null) {
    await deleteValue(GPU_PREFERENCE_HIVE, GPU_PREFERENCE_KEY, exePath);
    return;
  }
  await writeValue(GPU_PREFERENCE_HIVE, GPU_PREFERENCE_KEY, exePath, 'REG_SZ', previous);
}

/** Exposed for tests: priority order is what "lower" means in a background rule. */
export const PRIORITY_ORDER: readonly PriorityClass[] = ['Idle', 'BelowNormal', 'Normal', 'AboveNormal', 'High'];

export function isLowerPriority(candidate: PriorityClass, reference: PriorityClass): boolean {
  return PRIORITY_ORDER.indexOf(candidate) < PRIORITY_ORDER.indexOf(reference);
}

