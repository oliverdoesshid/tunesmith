/**
 * Low-level latency primitives: MSI-X enablement, IRQ priority and per-interface
 * TCP tweaks (requirement 8).
 *
 * Three rules keep this module reviewable:
 *
 * 1. **No preset-supplied paths.** Every registry key is derived at runtime from
 *    OS enumeration (`Get-PnpDevice`, TCP interface subkeys). A preset only says
 *    \"the GPU\" or \"IRQ 8\", never a key.
 * 2. **Capture before mutate.** Every value written is read first, including
 *    absence (`existed: false`), so rollback restores the exact prior state.
 * 3. **Fail closed.** An unreadable target, a denied Enum write, or an exotic
 *    value type aborts the step instead of mutating blindly.
 *
 * Verified live on the reference machine: both the RTX 3060 and the Realtek NIC
 * expose `...Device Parameters\Interrupt Management\MessageSignaledInterruptProperties`
 * with `MSISupported` and `MessageNumberLimit` REG_DWORD values, and the PnP
 * instance id maps 1:1 onto the Enum key path.
 */
import { TuneSmithError } from '../../shared/errors';
import { deleteValue, listSubkeys, readValue, valueExists, writeValue } from './registry';
import { runPowerShellJson } from './powershell';

const ENUM_ROOT = 'SYSTEM\\CurrentControlSet\\Enum';
const MSI_SUBKEY = 'Device Parameters\\Interrupt Management\\MessageSignaledInterruptProperties';
const PRIORITY_CONTROL_PATH = 'SYSTEM\\CurrentControlSet\\Control\\PriorityControl';
const TCP_INTERFACES_PATH = 'SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces';

const PNP_CLASS: Record<'gpu' | 'network', 'Display' | 'Net'> = {
  gpu: 'Display',
  network: 'Net',
};

/**
 * A PnP instance id becomes part of a registry path, so it is validated even
 * though it comes from the OS and travels via argv (never a shell): anything
 * that is not a well-formed `PCI\<device>\<instance>` id is refused rather than
 * written somewhere unexpected.
 */
const PCI_ID_RE = /^PCI\\[A-Za-z0-9_&.\-(){} ]+\\[A-Za-z0-9_&.\-(){} ]+$/;

function checkedInstanceId(raw: unknown): string {
  if (typeof raw !== 'string' || !PCI_ID_RE.test(raw)) {
    throw new TuneSmithError('capture-failed', 'Unexpected PCI device id from enumeration', String(raw));
  }
  return raw;
}

export function msiKeyPath(instanceId: string): string {
  return `${ENUM_ROOT}\\${instanceId}\\${MSI_SUBKEY}`;
}

/** PCI devices of a class, e.g. every physical GPU or NIC. Never USB/ROOT mirrors. */
export async function listPciDevices(deviceClass: 'gpu' | 'network'): Promise<string[]> {
  const pnpClass = PNP_CLASS[deviceClass];
  const script = [
    `Get-PnpDevice -Class '${pnpClass}' -Status OK -ErrorAction Stop`,
    `  | Where-Object { $_.InstanceId -like 'PCI*' }`,
    '  | Select-Object -ExpandProperty InstanceId',
    '  | ConvertTo-Json -Compress',
  ].join('\n');

  const ids = await runPowerShellJson<string | string[] | null>(script, { timeoutMs: 30_000 });
  const list = ids === null || ids === undefined ? [] : Array.isArray(ids) ? ids : [ids];
  return list.map(checkedInstanceId).sort();
}

export interface MsiSnapshot {
  msiSupported: { existed: boolean; data?: number };
  messageLimit: { existed: boolean; data?: number };
}

async function snapshotDword(path: string, name: string): Promise<{ existed: boolean; data?: number }> {
  const snapshot = await readValue('HKLM', path, name);
  if (!snapshot.exists) return { existed: false };
  if (snapshot.valueType !== 'REG_DWORD' || typeof snapshot.data !== 'number') {
    throw new TuneSmithError(
      'capture-failed',
      `Cannot snapshot ${name} of type ${snapshot.valueType}: rollback would be impossible`,
      'Only REG_DWORD interrupt values are managed.',
    );
  }
  return { existed: true, data: snapshot.data };
}

export async function readMsiState(instanceId: string): Promise<MsiSnapshot> {
  const path = msiKeyPath(instanceId);
  return {
    msiSupported: await snapshotDword(path, 'MSISupported'),
    messageLimit: await snapshotDword(path, 'MessageNumberLimit'),
  };
}

export async function writeMsiState(instanceId: string, messageLimit?: number): Promise<void> {
  const path = msiKeyPath(instanceId);
  await writeValue('HKLM', path, 'MSISupported', 'REG_DWORD', 1);
  if (messageLimit !== undefined) {
    await writeValue('HKLM', path, 'MessageNumberLimit', 'REG_DWORD', messageLimit);
  }
}

export async function restoreMsiState(instanceId: string, snapshot: MsiSnapshot): Promise<void> {
  const path = msiKeyPath(instanceId);
  if (snapshot.msiSupported.existed) {
    await writeValue('HKLM', path, 'MSISupported', 'REG_DWORD', snapshot.msiSupported.data ?? 1);
  } else {
    await deleteValue('HKLM', path, 'MSISupported');
  }
  if (snapshot.messageLimit.existed) {
    await writeValue('HKLM', path, 'MessageNumberLimit', 'REG_DWORD', snapshot.messageLimit.data ?? 1);
  } else {
    await deleteValue('HKLM', path, 'MessageNumberLimit');
  }
}

/* ------------------------------------------------------------------ *
 * IRQ priority (`PriorityControl\IRQ<n>Priority`)
 * ------------------------------------------------------------------ */

export function irqValueName(irq: number): string {
  return `IRQ${irq}Priority`;
}

/** IRQ numbers are validated by the schema (0-255); the value written is fixed. */
export async function readIrqPriority(irq: number): Promise<{ existed: boolean; value?: number }> {
  const snapshot = await readValue('HKLM', PRIORITY_CONTROL_PATH, irqValueName(irq));
  if (!snapshot.exists) return { existed: false };
  if (snapshot.valueType !== 'REG_DWORD' || typeof snapshot.data !== 'number') {
    throw new TuneSmithError(
      'capture-failed',
      `Cannot snapshot ${irqValueName(irq)} of type ${snapshot.valueType}: rollback would be impossible`,
      'Only REG_DWORD IRQ priorities are managed.',
    );
  }
  return { existed: true, value: snapshot.data };
}

export async function writeIrqPriority(irq: number, priority: 'high' | 'normal'): Promise<void> {
  await writeValue('HKLM', PRIORITY_CONTROL_PATH, irqValueName(irq), 'REG_DWORD', priority === 'high' ? 1 : 0);
}

export async function restoreIrqPriority(irq: number, snapshot: { existed: boolean; value?: number }): Promise<void> {
  if (snapshot.existed) {
    await writeValue('HKLM', PRIORITY_CONTROL_PATH, irqValueName(irq), 'REG_DWORD', snapshot.value ?? 0);
  } else {
    await deleteValue('HKLM', PRIORITY_CONTROL_PATH, irqValueName(irq));
  }
}

/* ------------------------------------------------------------------ *
 * Per-interface TCP latency
 * ------------------------------------------------------------------ */

export interface InterfaceTcpSnapshot {
  guid: string;
  tcpAckFrequency: number | null;
  tcpNoDelay: number | null;
}

/**
 * Pure activity test, exported for unit tests: an interface counts as active when
 * it has a real DHCP lease or a statically configured address. `0.0.0.0` means
 * \"media disconnected\", not \"active\".
 */
export function interfaceIsActive(values: { dhcpIp: string | null; hasStaticIp: boolean }): boolean {
  if (values.hasStaticIp) return true;
  return values.dhcpIp !== null && values.dhcpIp !== '' && values.dhcpIp !== '0.0.0.0';
}

async function readTcpDword(guid: string, name: 'TcpAckFrequency' | 'TCPNoDelay'): Promise<number | null> {
  const snapshot = await readValue('HKLM', `${TCP_INTERFACES_PATH}\\${guid}`, name);
  if (!snapshot.exists) return null;
  if (snapshot.valueType !== 'REG_DWORD' || typeof snapshot.data !== 'number') {
    throw new TuneSmithError(
      'capture-failed',
      `Cannot snapshot ${name} on ${guid} of type ${snapshot.valueType}: rollback would be impossible`,
      'Only REG_DWORD TCP values are managed.',
    );
  }
  return snapshot.data;
}

/** GUIDs of interfaces that are actually configured. Disconnected and virtual-but-idle interfaces are skipped. */
export async function listActiveInterfaces(): Promise<string[]> {
  const guids = await listSubkeys('HKLM', TCP_INTERFACES_PATH);
  const active: string[] = [];
  for (const guid of guids) {
    const path = `${TCP_INTERFACES_PATH}\\${guid}`;
    let dhcpIp: string | null = null;
    try {
      const snapshot = await readValue('HKLM', path, 'DhcpIPAddress');
      if (snapshot.exists) dhcpIp = String(snapshot.data);
    } catch {
      // An unreadable lease value means \"not provably active\"; the interface is skipped, not mutated.
      continue;
    }
    const hasStaticIp = await valueExists('HKLM', path, 'IPAddress');
    if (interfaceIsActive({ dhcpIp, hasStaticIp })) active.push(guid);
  }
  return active;
}

export async function readInterfaceTcp(guid: string): Promise<InterfaceTcpSnapshot> {
  return {
    guid,
    tcpAckFrequency: await readTcpDword(guid, 'TcpAckFrequency'),
    tcpNoDelay: await readTcpDword(guid, 'TCPNoDelay'),
  };
}

export async function writeInterfaceTcp(
  guid: string,
  values: { tcpAckFrequency?: 0 | 1 | 2; tcpNoDelay?: 0 | 1 },
): Promise<void> {
  const path = `${TCP_INTERFACES_PATH}\\${guid}`;
  if (values.tcpAckFrequency !== undefined) {
    await writeValue('HKLM', path, 'TcpAckFrequency', 'REG_DWORD', values.tcpAckFrequency);
  }
  if (values.tcpNoDelay !== undefined) {
    await writeValue('HKLM', path, 'TCPNoDelay', 'REG_DWORD', values.tcpNoDelay);
  }
}

export async function restoreInterfaceTcp(guid: string, snapshot: InterfaceTcpSnapshot): Promise<void> {
  const path = `${TCP_INTERFACES_PATH}\\${guid}`;
  if (snapshot.tcpAckFrequency === null) {
    await deleteValue('HKLM', path, 'TcpAckFrequency');
  } else {
    await writeValue('HKLM', path, 'TcpAckFrequency', 'REG_DWORD', snapshot.tcpAckFrequency);
  }
  if (snapshot.tcpNoDelay === null) {
    await deleteValue('HKLM', path, 'TCPNoDelay');
  } else {
    await writeValue('HKLM', path, 'TCPNoDelay', 'REG_DWORD', snapshot.tcpNoDelay);
  }
}
