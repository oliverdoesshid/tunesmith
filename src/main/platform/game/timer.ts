/**
 * Global Windows timer resolution hold for game sessions.
 *
 * Why a child process instead of a DLL call in the main process: the timer request
 * is process-scoped, so if this app crashes the request must die with it — otherwise
 * the machine keeps its 0.5 ms floor (and the idle power draw that comes with it)
 * until the next reboot with no owner to blame. The holder therefore watches its
 * parent pid and exits when the parent is gone; restore additionally stops it
 * explicitly. Either path releases the request.
 *
 * The mechanism is `NtSetTimerResolution(5000, TRUE)`: 5000 × 100 ns = 0.5 ms, the
 * documented floor on most HALs. If the platform negotiates coarser, Windows keeps
 * the closest achievable value and the holder keeps re-requesting it so driver
 * activity cannot silently widen the quantum mid-match.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { TuneSmithError } from '../../../shared/errors';

/** The floor requested while a game session is active. Not user-tunable by design. */
export const TIMER_HOLD_PERIOD_MS = 0.5;

export interface TimerHoldHandle {
  stop(): Promise<void>;
}

/** Build the holder script. Exported for tests: pid interpolation is the injection boundary. */
export function buildTimerHoldScript(parentPid: number, periodMs: number): string {
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    throw new TuneSmithError('invalid-request', 'Timer holder requires a positive parent pid');
  }
  if (!Number.isFinite(periodMs) || periodMs <= 0 || periodMs > 16) {
    throw new TuneSmithError('invalid-request', 'Timer period is out of range');
  }
  const units = Math.round(periodMs * 10_000);
  return [
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class TsTimer {',
    '  [DllImport("ntdll.dll")]',
    '  public static extern int NtSetTimerResolution(uint desired, bool set, out uint current);',
    '}',
    '"@ | Out-Null',
    `$parentPid = ${parentPid}`,
    `$desired = ${units}`,
    '$current = 0',
    '[void][TsTimer]::NtSetTimerResolution($desired, $true, [ref]$current)',
    'while (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) {',
    '  [void][TsTimer]::NtSetTimerResolution($desired, $true, [ref]$current)',
    '  Start-Sleep -Seconds 5',
    '}',
  ].join('\n');
}

/**
 * Start the holder as a detached child of this process. Resolves once the child
 * has been spawned (not once the resolution is confirmed — confirmation happens
 * asynchronously in the child and a slow Add-Type compile must not stall a game
 * launch; the adjustment is recorded with the requested value).
 */
export async function startTimerHold(periodMs: number = TIMER_HOLD_PERIOD_MS): Promise<TimerHoldHandle> {
  const script = buildTimerHoldScript(process.pid, periodMs);

  let child: ChildProcess;
  try {
    child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      detached: true,
      stdio: 'ignore',
    });
  } catch (error) {
    throw new TuneSmithError('unavailable', 'Could not start the timer holder', String(error));
  }
  child.unref();
  if (child.pid === undefined) {
    throw new TuneSmithError('unavailable', 'The timer holder exited immediately');
  }

  return {
    async stop(): Promise<void> {
      try {
        child.kill();
      } catch {
        // The holder already exited (e.g. its parent watch fired first). The timer
        // request dies with the holder process, so there is nothing left to undo.
      }
    },
  };
}
