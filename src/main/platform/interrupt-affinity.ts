/**
 * Per-device MSI/MSI-X interrupt affinity.
 *
 * Windows documents two registry values under each PCI device's
 * `Device Parameters\Interrupt Management\Affinity Policy` key:
 *
 *   DevicePolicy          REG_DWORD  4 = use AssignmentSetOverride
 *   AssignmentSetOverride  KAFFINITY mask (REG_BINARY, REG_DWORD or REG_QWORD)
 *
 * The engine never names a device from preset/renderer data. Devices are enumerated from
 * PnP at runtime, reduced to GPU / NVMe controller / physical NIC classes, and the
 * instance id is validated before it becomes part of a registry path. Every prior value
 * is captured before the first write, and restoration re-writes the exact prior type and
 * value (or deletes it when it was absent).
 *
 * Important limitation: Windows reads this policy when it assigns a device's resources,
 * which in practice means a device restart or reboot. This module deliberately does not
 * restart a GPU, NVMe controller or NIC during a game; the controller records the staged
 * change and restores it on session exit.
 */
import { TuneSmithError } from '../../shared/errors';
import type {
  GameInterruptAffinityApplyResult,
  GameInterruptAffinityDevice,
  GameInterruptAffinityDeviceState,
  GameInterruptAffinitySnapshot,
  InterruptAffinityDeviceKind,
  InterruptAffinityValueState,
  InterruptAffinityValueType,
} from '../../shared/game/types';
import type { InterruptAffinityPlan } from '../../shared/game/interrupt-affinity';
import { readMsiState } from './interrupts';
import { asArray, psQuote, runPowerShellJson } from './powershell';

const PCI_INSTANCE_RE = /^PCI\\[A-Za-z0-9_&.\-(){} ]+\\[A-Za-z0-9_&.\-(){} ]+$/;
const LABEL_RE = /^[^\u0000-\u001f]{1,200}$/;
const SERVICE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const POLICY_DATA_RE = /^\d{1,20}$/;
const MASK_HEX_RE = /^[0-9A-F]{0,16}$/;

const AFFINITY_SUBKEY = 'Device Parameters\\Interrupt Management\\Affinity Policy';

const WINDOWS_VALUE_TYPE: Record<string, InterruptAffinityValueType> = {
  DWord: 'REG_DWORD',
  QWord: 'REG_QWORD',
  Binary: 'REG_BINARY',
};

interface RawDevice {
  instanceId?: unknown;
  className?: unknown;
  label?: unknown;
  service?: unknown;
}

interface RawDevices {
  devices?: RawDevice | RawDevice[] | null;
}

interface RawValue {
  valueType?: unknown;
  data?: unknown;
}

interface RawAffinity {
  policy?: RawValue | null;
  assignment?: RawValue | null;
}

function checkedInstanceId(raw: unknown): string {
  if (typeof raw !== 'string' || !PCI_INSTANCE_RE.test(raw)) {
    throw new TuneSmithError('capture-failed', 'Unexpected PCI device instance id from enumeration', String(raw));
  }
  return raw;
}

function checkedLabel(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && LABEL_RE.test(raw) ? raw : fallback;
}

function checkedService(raw: unknown): string | null {
  return typeof raw === 'string' && SERVICE_RE.test(raw) ? raw : null;
}

function kindFor(className: string, service: string | null): InterruptAffinityDeviceKind | null {
  if (className === 'Display') return 'gpu';
  if (className === 'Net') return 'network';
  if (className === 'SCSIAdapter' && service?.toLowerCase() === 'stornvme') return 'nvme';
  return null;
}

/**
 * Physical PCI interrupt-producing devices only. Virtual/root devices, USB display
 * mirrors and software adapters are excluded by the PnP instance-id prefix.
 */
export async function inspectInterruptAffinity(): Promise<GameInterruptAffinityDevice[]> {
  const script = [
    "$devices = @(Get-PnpDevice -Status OK -ErrorAction Stop | Where-Object {",
    "  $_.InstanceId -like 'PCI*' -and @('Display','Net','SCSIAdapter') -contains $_.Class",
    '});',
    '$rows = New-Object System.Collections.ArrayList;',
    'foreach ($device in $devices) {',
    '  $service = $null;',
    '  try {',
    "    $service = [string](Get-PnpDeviceProperty -InstanceId $device.InstanceId -KeyName 'DEVPKEY_Device_Service' -ErrorAction Stop).Data;",
    '  } catch {}',
    '  [void]$rows.Add([pscustomobject]@{',
    '    instanceId = [string]$device.InstanceId;',
    '    className = [string]$device.Class;',
    '    label = [string]$device.FriendlyName;',
    '    service = $service',
    '  })',
    '}',
    '[pscustomobject]@{ devices = @($rows) } | ConvertTo-Json -Compress -Depth 4;',
  ].join('\n');

  const result = await runPowerShellJson<RawDevices>(script, { timeoutMs: 30_000 });
  const found: GameInterruptAffinityDevice[] = [];
  const seen = new Set<string>();

  for (const raw of asArray(result.devices)) {
    if (typeof raw.className !== 'string') continue;
    const service = checkedService(raw.service);
    const kind = kindFor(raw.className, service);
    if (kind === null) continue;
    let instanceId: string;
    try {
      instanceId = checkedInstanceId(raw.instanceId);
    } catch {
      continue;
    }
    if (seen.has(instanceId)) continue;
    seen.add(instanceId);
    found.push({
      instanceId,
      kind,
      label: checkedLabel(raw.label, instanceId),
      service,
    });
  }

  return found.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
}

function checkedValueType(raw: unknown): InterruptAffinityValueType {
  if (typeof raw !== 'string') {
    throw new TuneSmithError('capture-failed', 'Affinity value has no registry type', String(raw));
  }
  const mapped = WINDOWS_VALUE_TYPE[raw];
  if (mapped === undefined) {
    throw new TuneSmithError(
      'capture-failed',
      `Unsupported affinity registry type ${raw}`,
      'Only DWORD, QWORD and BINARY affinity values can be restored exactly.',
    );
  }
  return mapped;
}

function checkedValueState(raw: RawValue | null | undefined, label: string): InterruptAffinityValueState {
  if (raw === null || raw === undefined) return { existed: false };
  const valueType = checkedValueType(raw.valueType);
  const text = typeof raw.data === 'string' ? raw.data : String(raw.data ?? '');

  if (valueType === 'REG_BINARY') {
    if (!MASK_HEX_RE.test(text) || text.length % 2 !== 0 || text.length > 16) {
      throw new TuneSmithError('capture-failed', `Unexpected ${label} binary mask`, text);
    }
    return { existed: true, valueType, data: text.toUpperCase() };
  }

  if (!POLICY_DATA_RE.test(text)) {
    throw new TuneSmithError('capture-failed', `Unexpected ${label} numeric value`, text);
  }
  const parsed = BigInt(text);
  if (valueType === 'REG_DWORD' && parsed > 0xffffffffn) {
    throw new TuneSmithError('capture-failed', `${label} is outside the 32-bit DWORD range`);
  }
  if (valueType === 'REG_QWORD' && parsed > 0xffffffffffffffffn) {
    throw new TuneSmithError('capture-failed', `${label} is outside the 64-bit QWORD range`);
  }
  return { existed: true, valueType, data: text };
}

async function readAffinityState(instanceId: string): Promise<{
  policy: InterruptAffinityValueState;
  assignment: InterruptAffinityValueState;
}> {
  const keyPath = `HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\${instanceId}\\${AFFINITY_SUBKEY}`;
  const script = [
    `$keyPath = ${psQuote(keyPath)};`,
    '$key = Get-Item -LiteralPath $keyPath -ErrorAction SilentlyContinue;',
    '$policy = $null;',
    '$assignment = $null;',
    'if ($null -ne $key) {',
    '  $names = @($key.GetValueNames());',
    "  if ($names -contains 'DevicePolicy') {",
    "    $kind = $key.GetValueKind('DevicePolicy').ToString();",
    "    $value = $key.GetValue('DevicePolicy');",
    '    $policy = [pscustomobject]@{ valueType = $kind; data = [string]$value };',
    '  }',
    "  if ($names -contains 'AssignmentSetOverride') {",
    "    $kind = $key.GetValueKind('AssignmentSetOverride').ToString();",
    "    $value = $key.GetValue('AssignmentSetOverride');",
    "    if ($kind -eq 'Binary') {",
    '      $bytes = [byte[]]$value;',
    "      $text = (($bytes | ForEach-Object { $_.ToString('X2') }) -join '');",
    '    } else {',
    '      $text = [string]$value;',
    '    }',
    '    $assignment = [pscustomobject]@{ valueType = $kind; data = $text };',
    '  }',
    '}',
    '[pscustomobject]@{ policy = $policy; assignment = $assignment } | ConvertTo-Json -Compress -Depth 4;',
  ].join('\n');

  const parsed = await runPowerShellJson<RawAffinity>(script, { timeoutMs: 20_000 });
  const policy = checkedValueState(parsed.policy, 'DevicePolicy');
  if (policy.existed && policy.valueType !== 'REG_DWORD') {
    throw new TuneSmithError(
      'capture-failed',
      'DevicePolicy is not a REG_DWORD',
      'Refusing to replace an affinity policy whose prior type cannot be restored exactly.',
    );
  }
  return { policy, assignment: checkedValueState(parsed.assignment, 'AssignmentSetOverride') };
}

/**
 * Capture every eligible device before writing anything. MSI-disabled devices are
 * skipped: a line-based, potentially shared IRQ cannot be pinned independently.
 */
export async function captureInterruptAffinity(
  devices: readonly GameInterruptAffinityDevice[],
  plan: InterruptAffinityPlan,
): Promise<GameInterruptAffinitySnapshot> {
  if (plan.maskBytes.length !== 8 || plan.cores.length === 0) {
    throw new TuneSmithError('capture-failed', 'Interrupt-affinity plan has no usable processor mask.');
  }

  const states: GameInterruptAffinityDeviceState[] = [];
  for (const device of devices) {
    const instanceId = checkedInstanceId(device.instanceId);
    const msi = await readMsiState(instanceId);
    if (msi.msiSupported.existed !== true || msi.msiSupported.data !== 1) continue;
    const state = await readAffinityState(instanceId);
    states.push({ device: { ...device, instanceId }, ...state });
  }

  if (states.length === 0) {
    throw new TuneSmithError(
      'capture-failed',
      'No MSI/MSI-X-enabled GPU, NVMe controller or physical NIC was found',
      'Interrupt affinity is only meaningful for a device using message-signaled interrupts.',
    );
  }

  return {
    capturedAt: new Date().toISOString(),
    mask: plan.mask,
    cores: [...plan.cores],
    devices: states,
  };
}

function bytesLiteral(bytes: readonly number[]): string {
  return `[byte[]]@(${bytes.map((byte) => `0x${(byte & 0xff).toString(16).padStart(2, '0')}`).join(',')})`;
}

async function writeAffinityPolicy(instanceId: string, plan: InterruptAffinityPlan): Promise<void> {
  const keyPath = `HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\${instanceId}\\${AFFINITY_SUBKEY}`;
  const parentPath = `HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\${instanceId}`;
  const script = [
    `$parentPath = ${psQuote(parentPath)};`,
    `$keyPath = ${psQuote(keyPath)};`,
    'if (-not (Test-Path -LiteralPath $parentPath)) {',
    '  throw "The target PCI device is no longer present.";',
    '}',
    'if (-not (Test-Path -LiteralPath $keyPath)) {',
    '  New-Item -Path $keyPath -Force -ErrorAction Stop | Out-Null;',
    '}',
    "New-ItemProperty -LiteralPath $keyPath -Name 'DevicePolicy' -PropertyType DWord -Value 4 -Force -ErrorAction Stop | Out-Null;",
    `$mask = ${bytesLiteral(plan.maskBytes)};`,
    "New-ItemProperty -LiteralPath $keyPath -Name 'AssignmentSetOverride' -PropertyType Binary -Value $mask -Force -ErrorAction Stop | Out-Null;",
    '[pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress;',
  ].join('\n');
  await runPowerShellJson<{ ok?: boolean }>(script, { timeoutMs: 20_000 });
}

/** Apply the same documented policy to every captured device; continue on failure. */
export async function applyInterruptAffinity(
  snapshot: GameInterruptAffinitySnapshot,
): Promise<GameInterruptAffinityApplyResult> {
  const failures: string[] = [];
  let applied = 0;
  const maskBytes = maskBytesFromSnapshot(snapshot);
  if (snapshot.cores.length === 0 || maskBytes.every((byte) => byte === 0)) {
    return {
      ok: false,
      applied: 0,
      skipped: snapshot.devices.length,
      message: 'Refusing to stage an empty interrupt-affinity mask.',
    };
  }

  for (const state of snapshot.devices) {
    try {
      const instanceId = checkedInstanceId(state.device.instanceId);
      await writeAffinityPolicy(instanceId, {
        cores: snapshot.cores,
        mask: snapshot.mask,
        maskBytes,
        reason: '',
      });
      applied += 1;
    } catch (error) {
      failures.push(`${state.device.label}: ${String(error)}`);
    }
  }

  const skipped = snapshot.devices.length - applied;
  return {
    ok: applied > 0 && failures.length === 0,
    applied,
    skipped,
    message:
      failures.length === 0
        ? `Staged interrupt affinity for ${applied} device(s) on ${snapshot.mask}; Windows applies it when each device next starts.`
        : `Staged interrupt affinity for ${applied} device(s); ${skipped} failed. ${failures[0] ?? ''}`.trim(),
  };
}

function maskBytesFromSnapshot(snapshot: GameInterruptAffinitySnapshot): number[] {
  const bytes = new Array<number>(8).fill(0);
  for (const core of snapshot.cores) {
    if (!Number.isInteger(core) || core < 0 || core > 63) continue;
    bytes[Math.floor(core / 8)] = (bytes[Math.floor(core / 8)] ?? 0) | (1 << (core % 8));
  }
  return bytes;
}

function checkedRestoreState(state: InterruptAffinityValueState, label: string): InterruptAffinityValueState {
  if (!state.existed) return { existed: false };
  const valueType = state.valueType;
  if (valueType !== 'REG_DWORD' && valueType !== 'REG_QWORD' && valueType !== 'REG_BINARY') {
    throw new TuneSmithError('rollback-failed', `${label} has an unsupported value type`);
  }
  const data = state.data ?? '';
  if (valueType === 'REG_BINARY') {
    if (!MASK_HEX_RE.test(data) || data.length % 2 !== 0 || data.length > 16) {
      throw new TuneSmithError('rollback-failed', `${label} has an invalid binary mask`);
    }
  } else if (!POLICY_DATA_RE.test(data)) {
    throw new TuneSmithError('rollback-failed', `${label} has an invalid numeric value`);
  } else if (valueType === 'REG_DWORD' && BigInt(data) > 0xffffffffn) {
    throw new TuneSmithError('rollback-failed', `${label} is outside the DWORD range`);
  } else if (valueType === 'REG_QWORD' && BigInt(data) > 0xffffffffffffffffn) {
    throw new TuneSmithError('rollback-failed', `${label} is outside the QWORD range`);
  }
  return { existed: true, valueType, data };
}

function valueRestoreLines(label: 'DevicePolicy' | 'AssignmentSetOverride', state: InterruptAffinityValueState): string[] {
  const name = psQuote(label);
  if (!state.existed) {
    return [`Remove-ItemProperty -LiteralPath $keyPath -Name ${name} -ErrorAction SilentlyContinue;`];
  }
  const data = state.data ?? '';
  if (state.valueType === 'REG_BINARY') {
    const bytes = data.match(/.{2}/g) ?? [];
    return [
      `$mask = [byte[]]@(${bytes.map((byte) => `0x${byte}`).join(',')});`,
      `New-ItemProperty -LiteralPath $keyPath -Name ${name} -PropertyType Binary -Value $mask -Force -ErrorAction Stop | Out-Null;`,
    ];
  }
  if (state.valueType === 'REG_DWORD') {
    return [
      `New-ItemProperty -LiteralPath $keyPath -Name ${name} -PropertyType DWord -Value ([uint32]${data}) -Force -ErrorAction Stop | Out-Null;`,
    ];
  }
  return [
    `New-ItemProperty -LiteralPath $keyPath -Name ${name} -PropertyType QWord -Value ([uint64]${data}) -Force -ErrorAction Stop | Out-Null;`,
  ];
}

async function restoreAffinityPolicy(instanceId: string, state: GameInterruptAffinityDeviceState): Promise<void> {
  const parentPath = `HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\${instanceId}`;
  const keyPath = `HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\${instanceId}\\${AFFINITY_SUBKEY}`;
  const policy = checkedRestoreState(state.policy, 'DevicePolicy');
  const assignment = checkedRestoreState(state.assignment, 'AssignmentSetOverride');
  const needsKey = policy.existed || assignment.existed;
  const script = [
    `$parentPath = ${psQuote(parentPath)};`,
    `$keyPath = ${psQuote(keyPath)};`,
    'if (-not (Test-Path -LiteralPath $parentPath)) {',
    '  throw "The target PCI device is no longer present.";',
    '}',
    'if (-not (Test-Path -LiteralPath $keyPath)) {',
    ...(needsKey
      ? ['  New-Item -Path $keyPath -Force -ErrorAction Stop | Out-Null;']
      : ['  Remove-ItemProperty -LiteralPath $keyPath -Name "DevicePolicy" -ErrorAction SilentlyContinue;',
         '  Remove-ItemProperty -LiteralPath $keyPath -Name "AssignmentSetOverride" -ErrorAction SilentlyContinue;',
         '  [pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress;',
         '  return;']),
    '}',
    ...valueRestoreLines('DevicePolicy', policy),
    ...valueRestoreLines('AssignmentSetOverride', assignment),
    '[pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress;',
  ].join('\n');
  await runPowerShellJson<{ ok?: boolean }>(script, { timeoutMs: 20_000 });
}

/** Restore every captured value, continuing after a single device failure. */
export async function restoreInterruptAffinity(snapshot: GameInterruptAffinitySnapshot): Promise<string[]> {
  const problems: string[] = [];
  for (const state of snapshot.devices) {
    try {
      const instanceId = checkedInstanceId(state.device.instanceId);
      await restoreAffinityPolicy(instanceId, state);
    } catch (error) {
      problems.push(`interrupt affinity on ${state.device.label}: ${String(error)}`);
    }
  }
  return problems;
}
