/**
 * Process priority adapter. The only other PowerShell-based mutation.
 *
 * Priority is volatile by nature: it dies with the process. The journal still records
 * it so an immediate undo works, but the UI labels these steps as non-persistent.
 */
import { TuneSmithError } from '../../shared/errors';
import type { PriorityClass } from '../../shared/types';
import { psQuote, runPowerShellJson } from './powershell';

interface RawPrioritySnapshot {
  running?: boolean;
  instances?: { pid?: number; priority?: string }[] | { pid?: number; priority?: string };
}

export interface ProcessPrioritySnapshot {
  running: boolean;
  instances: { pid: number; priority: string }[];
}

/** Get-Process takes the base name without `.exe`. */
function baseName(processName: string): string {
  return processName.replace(/\.exe$/i, '');
}

function toSnapshot(raw: RawPrioritySnapshot): ProcessPrioritySnapshot {
  const list = raw.instances === undefined ? [] : Array.isArray(raw.instances) ? raw.instances : [raw.instances];
  return {
    running: raw.running === true,
    instances: list
      .filter((i): i is { pid?: number; priority?: string } => i !== null && typeof i === 'object')
      .map((i) => ({ pid: Number(i.pid ?? 0), priority: String(i.priority ?? 'Unknown') }))
      .filter((i) => i.pid > 0),
  };
}

export async function readProcessPriorities(processName: string): Promise<ProcessPrioritySnapshot> {
  const name = psQuote(baseName(processName));
  const raw = await runPowerShellJson<RawPrioritySnapshot>(`
$procs = @(Get-Process -Name ${name} -ErrorAction SilentlyContinue)
$instances = @($procs | ForEach-Object { [pscustomobject]@{ pid = $_.Id; priority = $_.PriorityClass.ToString() } })
[pscustomobject]@{ running = ($procs.Count -gt 0); instances = $instances } | ConvertTo-Json -Depth 3 -Compress
`);
  return toSnapshot(raw);
}

const PRIORITY_ENUM: Record<PriorityClass, string> = {
  Idle: 'Idle',
  BelowNormal: 'BelowNormal',
  Normal: 'Normal',
  AboveNormal: 'AboveNormal',
  High: 'High',
};

/** @returns number of process instances (PIDs) whose priority was changed. */
export async function setProcessPriority(processName: string, priority: PriorityClass): Promise<number> {
  const name = psQuote(baseName(processName));
  const enumValue = PRIORITY_ENUM[priority];

  const raw = await runPowerShellJson<{ changed?: number }>(`
$procs = @(Get-Process -Name ${name} -ErrorAction SilentlyContinue)
$changed = 0
foreach ($p in $procs) {
  try { $p.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::${enumValue}; $changed = $changed + 1 } catch { }
}
[pscustomobject]@{ changed = $changed } | ConvertTo-Json -Compress
`);

  const changed = Number(raw.changed ?? 0);
  if (changed === 0) {
    // Not an error: the process simply is not running. The journal records the step so
    // the UI can explain that it is a no-op until the application starts.
    return 0;
  }
  return changed;
}

export function priorityEnumFor(priority: PriorityClass): string {
  return PRIORITY_ENUM[priority];
}

export async function restorePriorities(processName: string, instances: { pid: number; priority: string }[]): Promise<void> {
  const pairs = instances
    .filter((i) => /^[A-Za-z]+$/.test(i.priority))
    .map((i) => `[pscustomobject]@{ pid = ${Number(i.pid)}; priority = ${psQuote(i.priority)} }`)
    .join(', ');

  if (pairs.length === 0) return;

  const raw = await runPowerShellJson<{ restored?: number }>(`
$targets = @(${pairs})
$restored = 0
foreach ($t in $targets) {
  $p = Get-Process -Id $t.pid -ErrorAction SilentlyContinue
  if ($null -ne $p) {
    try { $p.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::$($t.priority); $restored = $restored + 1 } catch { }
  }
}
[pscustomobject]@{ restored = $restored } | ConvertTo-Json -Compress
`);

  // A result of zero means every target process exited: their priority died with them.
  // Nothing to restore, and nothing to report as a failure.
  void raw.restored;
}

export function assertPrioritySupported(priority: string): asserts priority is PriorityClass {
  if (!(priority in PRIORITY_ENUM)) {
    throw new TuneSmithError('invalid-request', `Unsupported priority class: ${priority}`);
  }
}
