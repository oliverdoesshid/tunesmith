/**
 * Game-specific network route tuning.
 *
 * Discovery is deliberately read-only and independent of preset data: the game's
 * established TCP endpoints and bound UDP endpoints are enumerated by the OS, mapped
 * to the owning adapter's interface GUID, and only then are that interface's current
 * TCP values captured. A profile names TCP values, never an adapter, GUID or registry
 * path.
 *
 * UDP-only titles (some modern shooters use UDP exclusively) do not have a kernel TCP
 * interface setting to tune. In that case only the optional NIC interrupt-moderation
 * property is touched; the UI records an honest skip instead of pretending TCP changed.
 */
import type {
  GameNetworkAdapterState,
  GameNetworkApplyResult,
  GameNetworkEndpoint,
  GameNetworkInterfaceState,
  GameNetworkSettings,
  GameNetworkSnapshot,
  GameNetworkTarget,
} from '../../../shared/game/types';
import { TuneSmithError } from '../../../shared/errors';
import {
  readInterfaceTcp,
  restoreInterfaceTcp,
  writeInterfaceTcp,
  type InterfaceTcpSnapshot,
} from '../interrupts';
import { asArray, psQuote, runPowerShellJson } from '../powershell';

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ADAPTER_NAME_RE = /^[^\u0000-\u001f]{1,256}$/;
const ADDRESS_RE = /^[0-9A-Fa-f:.%]{2,64}$/;
const REGISTRY_KEYWORD_RE = /^(?:\*?InterruptModeration)$/i;
const REGISTRY_VALUE_RE = /^[0-9A-Za-z .,_-]{1,64}$/;
const INTERRUPT_KEYWORDS = new Set(['*interruptmoderation', 'interruptmoderation']);

interface RawEndpoint {
  interfaceGuid?: unknown;
  adapterName?: unknown;
  adapterDescription?: unknown;
  protocol?: unknown;
  localAddress?: unknown;
  localPort?: unknown;
  remoteAddress?: unknown;
  remotePort?: unknown;
}

interface RawEndpointResult {
  endpoints?: RawEndpoint | RawEndpoint[] | null;
}

function checkedText(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TuneSmithError('capture-failed', `Unexpected ${label} from network enumeration`, String(value));
  }
  return value;
}

function checkedPort(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new TuneSmithError('capture-failed', `Unexpected ${label} from network enumeration`, String(value));
  }
  return value;
}

function checkedOptionalAddress(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return checkedText(value, 'remote address', ADDRESS_RE);
}

function endpointFrom(raw: RawEndpoint): { target: GameNetworkTarget; endpoint: GameNetworkEndpoint } {
  const interfaceGuid = checkedText(raw.interfaceGuid, 'interface GUID', GUID_RE);
  const adapterName = checkedText(raw.adapterName, 'adapter name', ADAPTER_NAME_RE);
  const adapterDescription = checkedText(raw.adapterDescription, 'adapter description', ADAPTER_NAME_RE);
  const protocol = raw.protocol === 'tcp' || raw.protocol === 'udp' ? raw.protocol : null;
  if (protocol === null) {
    throw new TuneSmithError('capture-failed', 'Unexpected protocol from network enumeration', String(raw.protocol));
  }
  return {
    target: { interfaceGuid, adapterName, adapterDescription, endpoints: [] },
    endpoint: {
      protocol,
      localAddress: checkedText(raw.localAddress, 'local address', ADDRESS_RE),
      localPort: checkedPort(raw.localPort, 'local port'),
      remoteAddress: protocol === 'tcp' ? checkedOptionalAddress(raw.remoteAddress) : null,
      remotePort: protocol === 'tcp' ? checkedPort(raw.remotePort, 'remote port') : null,
    },
  };
}

/**
 * Enumerate the game process's real server route. Loopback and wildcard addresses are
 * excluded by the script, because they cannot identify an adapter. PowerShell failures
 * are allowed for protocols the OS does not expose (for example UDP on an old build) as
 * long as at least one protocol was readable.
 */
export async function inspectGameNetwork(pid: number): Promise<GameNetworkTarget[]> {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TuneSmithError('invalid-request', 'Game network inspection needs a running process id.');
  }

  const script = [
    `$targetPid = ${pid};`,
    '$rows = New-Object System.Collections.ArrayList;',
    '$adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue);',
    '$ips = @(Get-NetIPAddress -ErrorAction SilentlyContinue);',
    'try {',
    '  Get-NetTCPConnection -OwningProcess $targetPid -State Established -ErrorAction Stop | ForEach-Object {',
    '    $connection = $_;',
    "    $remote = [string]$connection.RemoteAddress;",
    "    if ($remote -eq '' -or $remote -eq '0.0.0.0' -or $remote -eq '::' -or $remote -match '^(127\\.|::1$)') { return };",
    '    $ip = $ips | Where-Object { $_.IPAddress -eq [string]$connection.LocalAddress } | Select-Object -First 1;',
    '    if ($null -eq $ip) { return };',
    '    $adapter = $adapters | Where-Object { $_.ifIndex -eq $ip.InterfaceIndex } | Select-Object -First 1;',
    '    if ($null -eq $adapter) { return };',
    '    [void]$rows.Add([pscustomobject]@{',
    '      interfaceGuid = [string]$adapter.InterfaceGuid;',
    '      adapterName = [string]$adapter.Name;',
    '      adapterDescription = [string]$adapter.InterfaceDescription;',
    "      protocol = 'tcp';",
    '      localAddress = [string]$connection.LocalAddress;',
    '      localPort = [int]$connection.LocalPort;',
    '      remoteAddress = $remote;',
    '      remotePort = [int]$connection.RemotePort',
    '    })',
    '  }',
    '} catch {}',
    'try {',
    '  Get-NetUDPEndpoint -OwningProcess $targetPid -ErrorAction Stop | ForEach-Object {',
    '    $endpoint = $_;',
    "    $local = [string]$endpoint.LocalAddress;",
    "    if ($local -eq '' -or $local -eq '0.0.0.0' -or $local -eq '::' -or $local -match '^(127\\.|::1$)') { return };",
    '    $ip = $ips | Where-Object { $_.IPAddress -eq $local } | Select-Object -First 1;',
    '    if ($null -eq $ip) { return };',
    '    $adapter = $adapters | Where-Object { $_.ifIndex -eq $ip.InterfaceIndex } | Select-Object -First 1;',
    '    if ($null -eq $adapter) { return };',
    '    [void]$rows.Add([pscustomobject]@{',
    '      interfaceGuid = [string]$adapter.InterfaceGuid;',
    '      adapterName = [string]$adapter.Name;',
    '      adapterDescription = [string]$adapter.InterfaceDescription;',
    "      protocol = 'udp';",
    '      localAddress = $local;',
    '      localPort = [int]$endpoint.LocalPort;',
    '      remoteAddress = $null;',
    '      remotePort = $null',
    '    })',
    '  }',
    '} catch {}',
    '[pscustomobject]@{ endpoints = @($rows) } | ConvertTo-Json -Compress -Depth 4;',
  ].join('\n');

  const result = await runPowerShellJson<RawEndpointResult>(script, { timeoutMs: 20_000 });
  const groups = new Map<string, GameNetworkTarget>();
  const seen = new Set<string>();

  for (const raw of asArray(result.endpoints)) {
    const { target, endpoint } = endpointFrom(raw);
    const key = [
      endpoint.protocol,
      endpoint.localAddress,
      endpoint.localPort,
      endpoint.remoteAddress ?? '',
      endpoint.remotePort ?? '',
      target.interfaceGuid,
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);

    const existing = groups.get(target.interfaceGuid);
    if (existing !== undefined) {
      existing.endpoints.push(endpoint);
    } else {
      groups.set(target.interfaceGuid, { ...target, endpoints: [endpoint] });
    }
  }

  return [...groups.values()].sort((a, b) => a.adapterName.localeCompare(b.adapterName));
}

interface RawInterruptResult {
  available?: boolean;
  registryKeyword?: unknown;
  registryValue?: unknown;
  displayName?: unknown;
}

/** The NIC advanced property is optional; a driver that does not expose it is not an error. */
async function readInterruptModeration(adapterName: string): Promise<GameNetworkAdapterState | undefined> {
  checkedText(adapterName, 'adapter name', ADAPTER_NAME_RE);
  const script = [
    `$adapter = Get-NetAdapter -Name ${psQuote(adapterName)} -ErrorAction Stop;`,
    "$property = @(Get-NetAdapterAdvancedProperty -Name $adapter.Name -ErrorAction SilentlyContinue | Where-Object { $_.RegistryKeyword -match '^\\*?InterruptModeration$' } | Select-Object -First 1);",
    'if ($property.Count -eq 0) {',
    '  [pscustomobject]@{ available = $false } | ConvertTo-Json -Compress;',
    '  return;',
    '}',
    '  [pscustomobject]@{',
    '    available = $true;',
    '    registryKeyword = [string]$property[0].RegistryKeyword;',
    '    registryValue = [string]$property[0].RegistryValue;',
    '    displayName = [string]$property[0].DisplayName',
    '  } | ConvertTo-Json -Compress;',
  ].join('\n');

  let result: RawInterruptResult;
  try {
    result = await runPowerShellJson<RawInterruptResult>(script, { timeoutMs: 20_000 });
  } catch {
    return undefined;
  }
  if (result.available !== true) return undefined;

  const registryKeyword = checkedText(result.registryKeyword, 'interrupt-moderation keyword', REGISTRY_KEYWORD_RE);
  if (!INTERRUPT_KEYWORDS.has(registryKeyword.toLowerCase())) return undefined;
  return {
    adapterName,
    registryKeyword,
    previousRegistryValue: checkedText(
      result.registryValue,
      'interrupt-moderation value',
      REGISTRY_VALUE_RE,
    ),
    displayName: checkedText(result.displayName, 'interrupt-moderation display name', ADAPTER_NAME_RE),
  };
}

/** Capture every prior value before the controller writes any of them. */
export async function captureGameNetwork(targets: readonly GameNetworkTarget[]): Promise<GameNetworkSnapshot> {
  if (targets.length === 0) {
    throw new TuneSmithError('capture-failed', 'No active game network interface was discovered.');
  }

  const interfaces: GameNetworkInterfaceState[] = [];
  for (const target of targets) {
    const tcp: InterfaceTcpSnapshot = await readInterfaceTcp(target.interfaceGuid);
    interfaces.push({
      ...target,
      tcpAckFrequency: tcp.tcpAckFrequency,
      tcpNoDelay: tcp.tcpNoDelay,
    });
  }

  const interruptModeration = await readInterruptModeration(interfaces[0].adapterName);
  return {
    capturedAt: new Date().toISOString(),
    interfaces,
    ...(interruptModeration === undefined ? {} : { interruptModeration }),
  };
}

/**
 * Apply requested values. TCP is written only for interfaces that actually carry an
 * established TCP flow for this game. Interrupt moderation is a single-adapter property
 * and is applied to the first discovered route adapter.
 */
export async function applyGameNetwork(
  snapshot: GameNetworkSnapshot,
  settings: GameNetworkSettings,
): Promise<GameNetworkApplyResult> {
  const wantsTcp = settings.tcpAckFrequency !== undefined || settings.tcpNoDelay !== undefined;
  const tcpTargets = snapshot.interfaces.filter((candidate) =>
    candidate.endpoints.some((endpoint) => endpoint.protocol === 'tcp'),
  );

  let tcpInterfaces = 0;
  if (wantsTcp) {
    for (const target of tcpTargets) {
      await writeInterfaceTcp(target.interfaceGuid, {
        ...(settings.tcpAckFrequency === undefined ? {} : { tcpAckFrequency: settings.tcpAckFrequency }),
        ...(settings.tcpNoDelay === undefined ? {} : { tcpNoDelay: settings.tcpNoDelay }),
      });
      tcpInterfaces += 1;
    }
  }

  let adapter: GameNetworkApplyResult['adapter'] = 'not-requested';
  if (settings.interruptModeration !== undefined) {
    if (snapshot.interruptModeration === undefined) {
      adapter = 'unavailable';
    } else {
      try {
        const enabled = settings.interruptModeration === 'enabled';
        const script = [
          `Set-NetAdapterAdvancedProperty -Name ${psQuote(snapshot.interruptModeration.adapterName)}`,
          `  -RegistryKeyword ${psQuote(snapshot.interruptModeration.registryKeyword)}`,
          `  -RegistryValue ${enabled ? '1' : '0'} -NoRestart -ErrorAction Stop;`,
          "[pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress;",
        ].join('\n');
        await runPowerShellJson<{ ok?: boolean }>(script, { timeoutMs: 20_000 });
        adapter = 'applied';
      } catch {
        adapter = 'failed';
      }
    }
  }

  const ok = tcpInterfaces > 0 || adapter === 'applied';
  if (ok) {
    const changes: string[] = [];
    if (tcpInterfaces > 0) changes.push(`${tcpInterfaces} TCP interface(s)`);
    if (adapter === 'applied') changes.push('NIC interrupt moderation');
    return {
      ok: true,
      tcpInterfaces,
      adapter,
      message:
        `Applied ${changes.join(' and ')} for the game's discovered route.` +
        (adapter === 'failed' ? ' The NIC refused interrupt moderation; all applied values will still be restored on exit.' : ''),
    };
  }

  if (wantsTcp && tcpTargets.length === 0) {
    return {
      ok: false,
      tcpInterfaces: 0,
      adapter,
      message:
        adapter === 'unavailable'
          ? 'This title has no established TCP server flow and its adapter exposes no interrupt-moderation property. Nothing was changed.'
          : 'This title has no established TCP server flow; TCP tuning needs a server connection that is already open.',
    };
  }

  return {
    ok: false,
    tcpInterfaces,
    adapter,
    message:
      adapter === 'failed'
        ? 'The NIC refused the interrupt-moderation property. TCP values, if any, were applied and will be restored.'
        : 'The requested network values could not be applied.',
  };
}

/** Restore every captured value, even if an earlier interface failed. */
export async function restoreGameNetwork(snapshot: GameNetworkSnapshot): Promise<string[]> {
  const problems: string[] = [];
  for (const target of snapshot.interfaces) {
    const guid = typeof target.interfaceGuid === 'string' && GUID_RE.test(target.interfaceGuid) ? target.interfaceGuid : null;
    const ack =
      target.tcpAckFrequency === null || [0, 1, 2].includes(target.tcpAckFrequency ?? -1)
        ? target.tcpAckFrequency
        : undefined;
    const noDelay =
      target.tcpNoDelay === null || [0, 1].includes(target.tcpNoDelay ?? -1) ? target.tcpNoDelay : undefined;
    if (guid === null || ack === undefined || noDelay === undefined) {
      problems.push('network snapshot contained an invalid TCP interface entry; that entry was not restored.');
      continue;
    }
    try {
      await restoreInterfaceTcp(guid, {
        guid,
        tcpAckFrequency: ack,
        tcpNoDelay: noDelay,
      });
    } catch (error) {
      problems.push(`TCP interface ${target.adapterName}: ${String(error)}`);
    }
  }

  if (snapshot.interruptModeration !== undefined) {
    if (
      !ADAPTER_NAME_RE.test(snapshot.interruptModeration.adapterName) ||
      !REGISTRY_KEYWORD_RE.test(snapshot.interruptModeration.registryKeyword) ||
      !INTERRUPT_KEYWORDS.has(snapshot.interruptModeration.registryKeyword.toLowerCase()) ||
      !REGISTRY_VALUE_RE.test(snapshot.interruptModeration.previousRegistryValue)
    ) {
      problems.push('network snapshot contained an invalid interrupt-moderation entry; it was not restored.');
      return problems;
    }
    try {
      const script = [
        `Set-NetAdapterAdvancedProperty -Name ${psQuote(snapshot.interruptModeration.adapterName)}`,
        `  -RegistryKeyword ${psQuote(snapshot.interruptModeration.registryKeyword)}`,
        `  -RegistryValue ${psQuote(snapshot.interruptModeration.previousRegistryValue)}`,
        '  -NoRestart -ErrorAction Stop;',
        "[pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress;",
      ].join('\n');
      await runPowerShellJson<{ ok?: boolean }>(script, { timeoutMs: 20_000 });
    } catch (error) {
      problems.push(`interrupt moderation on ${snapshot.interruptModeration.adapterName}: ${String(error)}`);
    }
  }

  return problems;
}
