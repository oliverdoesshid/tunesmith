/**
 * Microsoft Store / UWP package resolution.
 *
 * AppContainer titles are awkward to target for three reasons:
 *   1. their install paths are virtualised, so `pathPrefix` cannot be used;
 *   2. the executable can differ between game builds and launcher shells;
 *   3. `Get-Process` reports the image name but nothing about the package.
 *
 * The package family name (PFN) is the stable identity, and the foreground watcher reads
 * it directly with `GetPackageFamilyName`. This module resolves a PFN to the manifest
 * facts the engine needs: the executables to watch, and the capabilities the package
 * declares (recorded for the session log — they are never modified).
 *
 * Read-only: nothing here mutates the machine, and `Get-AppxPackage` needs no elevation.
 */
import { describeError, TuneSmithError } from '../../../shared/errors';
import type { GamePackageInfo } from '../../../shared/game/types';
import { asArray, psQuote, runPowerShellJson } from '../powershell';

const PACKAGE_FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

interface RawPackage {
  found?: boolean;
  familyName?: string;
  installLocation?: string | null;
  executables?: string[] | string | null;
  capabilities?: string[] | string | null;
  signatureKind?: string | null;
  error?: string | null;
}

function basename(executable: string): string {
  const trimmed = executable.trim();
  const parts = trimmed.split(/[\\/]/);
  return (parts[parts.length - 1] ?? trimmed).toLowerCase();
}

/** Only image names are accepted; the manifest is untrusted input like any other. */
function normaliseExecutables(raw: RawPackage): string[] {
  const names = new Set<string>();
  for (const entry of asArray(raw.executables)) {
    if (typeof entry !== 'string' || entry.trim().length === 0) continue;
    const name = basename(entry);
    if (/^[a-z0-9][a-z0-9 ._-]*\.exe$/.test(name)) names.add(name);
  }
  return [...names].sort();
}

function normaliseCapabilities(raw: RawPackage): string[] {
  const names = new Set<string>();
  for (const entry of asArray(raw.capabilities)) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    // Capability names are identifiers; anything else is a malformed manifest.
    if (name.length > 0 && name.length <= 80 && /^[A-Za-z0-9._-]+$/.test(name)) names.add(name);
  }
  return [...names].sort();
}

/**
 * Resolve a PFN for the current user. Returns null when the package is not installed —
 * that is a normal state for a shared profile file, not an error.
 */
export async function resolvePackage(familyName: string): Promise<GamePackageInfo | null> {
  if (!PACKAGE_FAMILY_RE.test(familyName)) {
    throw new TuneSmithError('invalid-request', 'Invalid package family name');
  }

  let raw: RawPackage;
  try {
    raw = await runPowerShellJson<RawPackage>(
      String.raw`
$family = ${psQuote(familyName)}
$package = Get-AppxPackage -PackageFamilyName $family -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $package) {
  [pscustomobject]@{ found = $false } | ConvertTo-Json -Compress
  exit 0
}

$executables = @()
$capabilities = @()
try {
  $manifest = Get-AppxPackageManifest -Package $package
  foreach ($application in @($manifest.Package.Applications.Application)) {
    if ($null -ne $application.Executable) { $executables += [string]$application.Executable }
  }
  foreach ($capability in @($manifest.Package.Capabilities.Capability)) {
    if ($null -ne $capability.Name) { $capabilities += [string]$capability.Name }
  }
  foreach ($device in @($manifest.Package.Capabilities.DeviceCapability)) {
    if ($null -ne $device.Name) { $capabilities += [string]$device.Name }
  }
} catch {
  # A manifest that cannot be read is not fatal: the package still exists and its
  # executable can be discovered from the process list at runtime.
}

[pscustomobject]@{
  found           = $true
  familyName      = [string]$package.PackageFamilyName
  installLocation = [string]$package.InstallLocation
  signatureKind   = [string]$package.SignatureKind
  executables     = @($executables)
  capabilities    = @($capabilities)
} | ConvertTo-Json -Depth 5 -Compress
`,
      { timeoutMs: 30_000 },
    );
  } catch (error) {
    throw new TuneSmithError(
      'capture-failed',
      `Could not resolve package ${familyName}`,
      error instanceof TuneSmithError ? error.detail : describeError(error),
    );
  }

  if (raw.found !== true) return null;

  return {
    familyName: typeof raw.familyName === 'string' && raw.familyName.length > 0 ? raw.familyName : familyName,
    installLocation: typeof raw.installLocation === 'string' && raw.installLocation.length > 0 ? raw.installLocation : null,
    executables: normaliseExecutables(raw),
    capabilities: normaliseCapabilities(raw),
    signatureKind: typeof raw.signatureKind === 'string' && raw.signatureKind.length > 0 ? raw.signatureKind : null,
  };
}

/** Exported for tests: manifest values are normalised, never passed through blindly. */
export const __test = { normaliseExecutables, normaliseCapabilities, basename };
