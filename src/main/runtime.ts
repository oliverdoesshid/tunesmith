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
import { logger } from './logging';

let elevationCache: boolean | null = null;

export async function isElevated(force = false): Promise<boolean> {
  if (!force && elevationCache !== null) return elevationCache;

  const raw = await runPowerShellJson<{ elevated?: boolean }>(`
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($id)
[pscustomobject]@{ elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress
`);

  elevationCache = raw.elevated === true;
  logger.info('elevation', 'integrity check', { elevated: elevationCache, force });
  return elevationCache;
}

export function invalidateElevationCache(): void {
  elevationCache = null;
}

/**
 * Ask Windows to relaunch this executable with administrator rights.
 * The caller is expected to quit immediately on success.
 */
export async function relaunchElevated(execPath: string, args: readonly string[]): Promise<number | null> {
  if (process.platform !== 'win32') {
    throw new TuneSmithError('not-supported', 'Elevation is only implemented for Windows.');
  }

  // Passing an empty array to -ArgumentList is rejected by some PowerShell hosts. Omit the
  // parameter entirely for a packaged relaunch, which has no forwarded arguments.
  const argumentClause =
    args.length === 0 ? '' : ` -ArgumentList @(${args.map((a) => psQuote(a)).join(', ')})`;
  const workingDirectory = process.cwd();
  logger.info('elevation', 'requesting Windows RunAs', {
    execPath,
    args,
    workingDirectory,
  });

  const raw = await runPowerShellJson<{ launched?: boolean; pid?: number; detail?: string }>(`
try {
  $process = Start-Process -FilePath ${psQuote(execPath)}${argumentClause} -WorkingDirectory ${psQuote(workingDirectory)} -Verb RunAs -PassThru -ErrorAction Stop
  [pscustomobject]@{ launched = $true; pid = $process.Id; detail = 'elevated instance started' } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ launched = $false; pid = $null; detail = [string]$_.Exception.Message } | ConvertTo-Json -Compress
}
`);

  if (raw.launched !== true) {
    logger.warn('elevation', 'Windows RunAs was declined or failed', { detail: raw.detail ?? null });
    throw new TuneSmithError('not-elevated', 'Elevation was declined or failed.', String(raw.detail ?? ''));
  }

  const pid = typeof raw.pid === 'number' ? raw.pid : null;
  logger.info('elevation', 'elevated child process started', { pid, detail: raw.detail ?? null });
  return pid;
}
