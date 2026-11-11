/**
 * Read-only SCM registry inventory used by the plan preview.
 *
 * Windows keeps the service/driver dependency declarations in
 * `HKLM\SYSTEM\CurrentControlSet\Services`. This adapter deliberately reads the
 * whole tree in one fixed PowerShell pass, validates and normalises every row,
 * and never accepts a service name or registry path from the renderer. The data
 * is advisory: the executor still reads SCM through `sc.exe` and captures state
 * before every mutation.
 */
import { z } from 'zod';
import { TuneSmithError } from '../../shared/errors';
import type { ServiceGraphStart, ServiceRegistryEntry } from '../../shared/service-graph';
import { runPowerShellJson } from './powershell';

const SERVICE_NAME_RE = /^[A-Za-z0-9_. -]{1,128}$/;
const GROUP_NAME_RE = /^[A-Za-z0-9_. -]{1,128}$/;

const stringList = z
  .union([z.string(), z.array(z.string()), z.null()])
  .optional();

const recordSchema = z.object({
  name: z.string().max(256),
  displayName: z.string().max(512).nullable().optional(),
  start: z.number().int().min(-1).max(4).nullable().optional(),
  dependsOn: stringList,
  dependsOnGroups: stringList,
});

const registrySchema = z.array(recordSchema).max(4096);

const START_TYPES: Readonly<Record<number, ServiceGraphStart>> = {
  [-1]: 'Unknown',
  0: 'Boot',
  1: 'System',
  2: 'Auto',
  3: 'Manual',
  4: 'Disabled',
};

/**
 * The script is fixed text with no interpolated values. `-InputObject` is
 * important: piping `@($out)` would invoke `ConvertTo-Json` once per service and
 * emit concatenated JSON documents instead of one array.
 */
export const SERVICE_REGISTRY_SCRIPT = [
  "$root = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services';",
  '$out = foreach ($item in (Get-ChildItem -LiteralPath $root -ErrorAction Stop)) {',
  '  $properties = Get-ItemProperty -LiteralPath $item.PSPath -ErrorAction SilentlyContinue;',
  '  if ($null -eq $properties) { continue; }',
  '  [pscustomobject]@{',
  '    name = [string]$item.PSChildName;',
  '    displayName = [string]$properties.DisplayName;',
  '    start = $(if ($null -eq $properties.Start) { -1 } else { [int]$properties.Start });',
  '    dependsOn = @($properties.DependOnService | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | ForEach-Object { [string]$_ });',
  '    dependsOnGroups = @($properties.DependOnGroup | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | ForEach-Object { [string]$_ });',
  '  }',
  '}',
  'ConvertTo-Json -InputObject @($out) -Depth 4 -Compress;',
].join('\n');

function normaliseList(value: string | string[] | null | undefined, pattern: RegExp): string[] {
  const values = value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of values) {
    const name = item.trim();
    if (!pattern.test(name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

/** Pure parser kept separate so the SCM fixture can be tested without PowerShell. */
export function parseServiceRegistryOutput(raw: unknown): ServiceRegistryEntry[] {
  const parsed = registrySchema.safeParse(raw);
  if (!parsed.success) {
    throw new TuneSmithError(
      'parse-failed',
      'Could not parse the service control manager registry.',
      parsed.error.issues[0]?.message ?? 'invalid shape',
    );
  }

  const seen = new Set<string>();
  const records: ServiceRegistryEntry[] = [];
  for (const row of parsed.data) {
    const name = row.name.trim();
    if (!SERVICE_NAME_RE.test(name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const displayName = row.displayName?.trim() ?? '';
    records.push({
      name,
      // Registry display names are often indirect resource strings
      // (`@%SystemRoot%\...\x.dll,-1000`); showing the raw path in the tree is noise.
      displayName: displayName.startsWith('@') ? '' : displayName.slice(0, 256),
      start: START_TYPES[row.start ?? -1] ?? 'Unknown',
      dependsOn: normaliseList(row.dependsOn, SERVICE_NAME_RE),
      dependsOnGroups: normaliseList(row.dependsOnGroups, GROUP_NAME_RE),
    });
  }
  return records;
}

export async function readServiceRegistry(): Promise<ServiceRegistryEntry[]> {
  const raw = await runPowerShellJson<unknown>(SERVICE_REGISTRY_SCRIPT, { timeoutMs: 25_000 });
  return parseServiceRegistryOutput(raw);
}
