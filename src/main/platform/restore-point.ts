/**
 * System Restore integration.
 *
 * A restore point is the *second* line of defence, not the first. The journal is what
 * makes every change reversible in seconds; System Restore covers the case where the
 * machine will not boot far enough to run the app again.
 *
 * Windows throttles checkpoints (`SystemRestorePointCreationFrequency`, 1440 minutes by
 * default). When the throttle bites we report it and continue with journal-only
 * rollback for `preferred` presets; a `required` preset fails closed. We deliberately
 * do not disable the throttle ourselves: that would quietly weaken a safety net the
 * user may be relying on.
 */
import { TuneSmithError } from '../../shared/errors';
import type { RestorePointInfo } from '../../shared/session';
import { psQuote, runPowerShellJson } from './powershell';

export interface SystemRestoreProbe {
  available: boolean;
  vssStatus: string;
  srDisabled: boolean;
  frequencyMinutes: number | null;
  detail: string;
}

interface RawProbe {
  vss?: string;
  srDisabled?: boolean;
  frequency?: number | null;
}

export async function probeSystemRestore(): Promise<SystemRestoreProbe> {
  const raw = await runPowerShellJson<RawProbe>(`
$vss = 'Missing'
try { $vss = (Get-Service -Name VSS -ErrorAction Stop).Status.ToString() } catch { $vss = 'Missing' }
$key = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\SystemRestore'
$props = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
$disabled = $false
$freq = $null
if ($null -ne $props) {
  if ($null -ne $props.DisableSR) { $disabled = ([int]$props.DisableSR -ne 0) }
  if ($null -ne $props.SystemRestorePointCreationFrequency) { $freq = [int]$props.SystemRestorePointCreationFrequency }
}
[pscustomobject]@{ vss = $vss; srDisabled = $disabled; frequency = $freq } | ConvertTo-Json -Compress
`);

  const vssStatus = String(raw.vss ?? 'Missing');
  const srDisabled = raw.srDisabled === true;
  const frequencyMinutes = raw.frequency === null || raw.frequency === undefined ? null : Number(raw.frequency);

  let detail: string;
  if (vssStatus === 'Missing') detail = 'Volume Shadow Copy service is not installed; restore points are unavailable.';
  else if (srDisabled) detail = 'System Protection is disabled for this system.';
  else if (frequencyMinutes !== null && frequencyMinutes > 0) {
    detail = `Available, but Windows throttles checkpoints to one every ${frequencyMinutes} minute(s).`;
  } else detail = 'System Protection is available.';

  return {
    available: vssStatus !== 'Missing' && !srDisabled,
    vssStatus,
    srDisabled,
    frequencyMinutes,
    detail,
  };
}

const DESCRIPTION_RE = /^[A-Za-z0-9 ._:()\-[\]]{1,120}$/;

export async function createRestorePoint(description: string): Promise<RestorePointInfo> {
  if (!DESCRIPTION_RE.test(description)) {
    throw new TuneSmithError('invalid-request', 'Restore point description contains unsupported characters');
  }

  const raw = await runPowerShellJson<{ ok?: boolean; detail?: string }>(
    `
$drive = $env:SystemDrive + '\\'
$enableError = $null
try { Enable-ComputerRestore -Drive $drive -ErrorAction Stop } catch { $enableError = $_.Exception.Message }

if ($null -ne $enableError) {
  [pscustomobject]@{ ok = $false; detail = ('could not enable System Restore: ' + [string]$enableError) } | ConvertTo-Json -Compress
} else {
  try {
    Checkpoint-Computer -Description ${psQuote(description)} -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop
    [pscustomobject]@{ ok = $true; detail = 'Restore point created.' } | ConvertTo-Json -Compress
  } catch {
    [pscustomobject]@{ ok = $false; detail = [string]$_.Exception.Message } | ConvertTo-Json -Compress
  }
}
`,
    { timeoutMs: 180_000 },
  );

  return {
    attempted: true,
    ok: raw.ok === true,
    detail: String(raw.detail ?? 'No detail reported.'),
  };
}
