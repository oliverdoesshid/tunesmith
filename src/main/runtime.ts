/**
 * Process-level runtime concerns: elevation detection and self-relaunch.
 *
 * Applying presets needs administrator rights. Rather than failing with a cryptic
 * access-denied deep inside `reg.exe`, the UI asks the OS for elevation explicitly and
 * relaunches the whole app elevated, so every subsequent call runs in one consistent
 * security context.
 */
import { psQuote, runPowerShellJson } from './platform/powershell';
import { TuneSmithError } from '../shared/errors';

let elevationCache: boolean | null = null;

export async function isElevated(force = false): Promise<boolean> {
  if (!force && elevationCache !== null) return elevationCache;

  const raw = await runPowerShellJson<{ elevated?: boolean }>(`
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($id)
[pscustomobject]@{ elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress
`);

  elevationCache = raw.elevated === true;
  return elevationCache;
}

export function invalidateElevationCache(): void {
  elevationCache = null;
}

/**
 * Ask Windows to relaunch this executable with administrator rights.
 * The caller is expected to quit immediately on success.
 */
export async function relaunchElevated(execPath: string, args: readonly string[]): Promise<void> {
  if (process.platform !== 'win32') {
    throw new TuneSmithError('not-supported', 'Elevation is only implemented for Windows.');
  }

  const argList = args.length === 0 ? '@()' : `@(${args.map((a) => psQuote(a)).join(', ')})`;
  const raw = await runPowerShellJson<{ launched?: boolean; detail?: string }>(`
try {
  Start-Process -FilePath ${psQuote(execPath)} -ArgumentList ${argList} -Verb RunAs -ErrorAction Stop
  [pscustomobject]@{ launched = $true; detail = 'elevated instance started' } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ launched = $false; detail = [string]$_.Exception.Message } | ConvertTo-Json -Compress
}
`);

  if (raw.launched !== true) {
    throw new TuneSmithError('not-elevated', 'Elevation was declined or failed.', String(raw.detail ?? ''));
  }
}
