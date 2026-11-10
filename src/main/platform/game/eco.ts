/**
 * Windows 11 Efficiency Mode (EcoQoS) for background processes.
 *
 * Two mechanisms, one batched call:
 *  1. **Process throttling.** `SetProcessInformation(hProcess, ProcessPowerThrottling, …)`
 *     with `PROCESS_POWER_THROTTLING_EXECUTION_SPEED |
 *     PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION`. The scheduler prefers
 *     efficiency cores for the process and stops letting it pin the timer resolution.
 *  2. **Thread deprioritisation.** Every thread of the process is opened via a
 *     Toolhelp32 thread snapshot and parked with
 *     `SetThreadPriority(h, THREAD_MODE_BACKGROUND_BEGIN)`, which drops CPU, I/O and
 *     memory priority together. `THREAD_MODE_BACKGROUND_END` restores them, which is
 *     what makes this reversible — and why it is offered where `TerminateProcess`
 *     never is.
 *
 * Naming note: `ProcessLeapSecondInformation` is a different information class
 * (leap-second data) and has nothing to do with EcoQoS. The power knobs are
 * `ProcessPowerThrottling` for processes and `ThreadPowerThrottling` /
 * `THREAD_MODE_BACKGROUND_*` for threads.
 *
 * Batched per call so the ~500 ms `Add-Type` compile happens once per activation,
 * mirroring the suspend/resume batching in `control.ts`.
 */
import { psQuote, runPowerShellJson } from '../powershell';
import type { ProcessOutcome } from './control';

const ECO_MODE_SCRIPT = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TsEco {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetProcessInformation(IntPtr hProcess, int infoClass, IntPtr info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool Thread32First(IntPtr snap, ref THREADENTRY32 te);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool Thread32Next(IntPtr snap, ref THREADENTRY32 te);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenThread(uint access, bool inherit, uint tid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetThreadPriority(IntPtr hThread, int prio);

  [StructLayout(LayoutKind.Sequential)]
  struct THREADENTRY32 {
    public uint dwSize; public uint cntUsage; public uint threadId; public uint ownerPid;
    public int basePri; public int deltaPri; public uint flags;
  }

  const uint PROCESS_SET_INFORMATION = 0x0200;
  const int PROCESS_POWER_THROTTLING = 4;
  const uint POWER_THROTTLING_EXECUTION_SPEED = 0x1;
  const uint POWER_THROTTLING_IGNORE_TIMER_RESOLUTION = 0x4;
  const uint TH32CS_SNAPTHREAD = 0x00000004;
  const uint THREAD_ACCESS = 0x0020 | 0x0040;
  const int BACKGROUND_BEGIN = 0x10000;
  const int BACKGROUND_END = 0x20000;

  static bool ApplyPowerThrottling(IntPtr handle, bool enable) {
    IntPtr state = Marshal.AllocHGlobal(12);
    try {
      Marshal.WriteInt32(state, 0, 1);
      Marshal.WriteInt32(state, 4, (int)(POWER_THROTTLING_EXECUTION_SPEED | POWER_THROTTLING_IGNORE_TIMER_RESOLUTION));
      Marshal.WriteInt32(state, 8, enable
        ? (int)(POWER_THROTTLING_EXECUTION_SPEED | POWER_THROTTLING_IGNORE_TIMER_RESOLUTION)
        : 0);
      return SetProcessInformation(handle, PROCESS_POWER_THROTTLING, state, 12);
    } finally { Marshal.FreeHGlobal(state); }
  }

  static void ApplyThreads(int pid, bool enable) {
    IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return;
    try {
      THREADENTRY32 te = new THREADENTRY32();
      te.dwSize = (uint)Marshal.SizeOf(typeof(THREADENTRY32));
      if (!Thread32First(snap, ref te)) return;
      do {
        if (te.ownerPid != (uint)pid) continue;
        IntPtr thread = OpenThread(THREAD_ACCESS, false, te.threadId);
        if (thread == IntPtr.Zero) continue;
        try { SetThreadPriority(thread, enable ? BACKGROUND_BEGIN : BACKGROUND_END); }
        finally { CloseHandle(thread); }
      } while (Thread32Next(snap, ref te));
    } finally { CloseHandle(snap); }
  }

  public static bool Set(int pid, bool enable) {
    IntPtr handle = OpenProcess(PROCESS_SET_INFORMATION, false, pid);
    if (handle == IntPtr.Zero) return false;
    try {
      if (!ApplyPowerThrottling(handle, enable)) return false;
      ApplyThreads(pid, enable);
      return true;
    } finally { CloseHandle(handle); }
  }
}
"@ | Out-Null

$mode = MODE
$results = @()
foreach ($processId in @(PIDS)) {
  try {
    $ok = [TsEco]::Set([int]$processId, ($mode -eq 'on'))
    $results += [pscustomobject]@{ pid = $processId; ok = [bool]$ok }
  } catch {
    $results += [pscustomobject]@{ pid = $processId; ok = $false }
  }
}

[pscustomobject]@{ results = @($results) } | ConvertTo-Json -Depth 4 -Compress
`;

/** Build the command. Exported for tests: the quoting is the security boundary. */
export function buildEcoModeScript(pids: readonly number[], enabled: boolean): string {
  return ECO_MODE_SCRIPT.replace('MODE', psQuote(enabled ? 'on' : 'off')).replace('PIDS', pids.join(', '));
}

/**
 * Switch Efficiency Mode on or off for a batch of pids.
 *
 * Same-user processes only: `PROCESS_SET_INFORMATION` is granted to the owner, so this
 * works without elevation. Anything else — a protected process, an exited pid — comes
 * back as `ok: false` and is recorded, never retried.
 */
export async function setEcoMode(pids: readonly number[], enabled: boolean): Promise<ProcessOutcome[]> {
  const safe = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (safe.length === 0) return [];

  const script = buildEcoModeScript(safe, enabled);
  const result = await runPowerShellJson<{ results?: ProcessOutcome[] | ProcessOutcome | null }>(script, {
    timeoutMs: 30_000,
  });
  const rows =
    result.results === null || result.results === undefined
      ? []
      : Array.isArray(result.results)
        ? result.results
        : [result.results];

  const byPid = new Map<number, boolean>();
  for (const row of rows) {
    if (typeof row.pid === 'number') byPid.set(row.pid, row.ok === true);
  }
  return safe.map((pid) => ({ pid, ok: byPid.get(pid) === true }));
}
