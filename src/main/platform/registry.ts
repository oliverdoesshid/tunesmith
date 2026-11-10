/**
 * Registry adapter built on `reg.exe` with argv arrays only.
 *
 * Capture-before-mutate is the contract: `readValue` must be able to describe the
 * current state exactly, or the engine refuses to touch the value. In particular, a
 * value whose current type is outside the vocabulary (REG_BINARY, REG_MULTI_SZ, …)
 * cannot be restored, so reading it throws instead of reporting "absent".
 */
import { TuneSmithError } from '../../shared/errors';
import type { RegData, RegistryHive, RegType } from '../../shared/types';
import { oneLine, runExe } from './exec';

export type RegistrySnapshot =
  | { exists: false }
  | { exists: true; valueType: RegType; data: RegData };

const SUPPORTED_TYPES: readonly string[] = ['REG_SZ', 'REG_EXPAND_SZ', 'REG_DWORD', 'REG_QWORD'];

function keyPath(hive: RegistryHive, pathValue: string): string {
  return `${hive}\\${pathValue}`;
}

function parseQueryOutput(stdout: string, valueName: string): RegistrySnapshot | null {
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    // "    ValueName    REG_DWORD    0x1"
    const match = /^ {4}(.+?) {2,}(REG_[A-Z_]+)(?: {2,}(.*))?$/.exec(line);
    if (!match) continue;
    const name = match[1]?.trim() ?? '';
    if (name.toLowerCase() !== valueName.toLowerCase()) continue;

    const type = match[2] ?? '';
    const raw = (match[3] ?? '').trim();

    if (!SUPPORTED_TYPES.includes(type)) {
      throw new TuneSmithError(
        'capture-failed',
        `Cannot snapshot ${valueName} of type ${type}: rollback would be impossible`,
        'Only REG_SZ, REG_EXPAND_SZ, REG_DWORD and REG_QWORD values can be modified safely.',
      );
    }

    const regType = type as RegType;
    if (regType === 'REG_DWORD' || regType === 'REG_QWORD') {
      const hex = /^0x([0-9a-f]+)$/i.exec(raw);
      if (!hex?.[1]) {
        throw new TuneSmithError('parse-failed', `Unexpected ${type} encoding for ${valueName}`, oneLine(raw));
      }
      return { exists: true, valueType: regType, data: Number.parseInt(hex[1], 16) };
    }
    return { exists: true, valueType: regType, data: raw };
  }
  return null;
}

export async function readValue(hive: RegistryHive, pathValue: string, valueName: string): Promise<RegistrySnapshot> {
  const result = await runExe('reg.exe', ['query', keyPath(hive, pathValue), '/v', valueName]);

  if (result.code !== 0) {
    // reg.exe uses exit code 1 both for "not found" and for genuine errors, so the
    // message is the only discriminator. Anything else is fatal: we must not record a
    // state we did not actually observe.
    if (/unable to find/i.test(result.stderr)) return { exists: false };
    throw new TuneSmithError('capture-failed', `Could not read ${valueName}`, oneLine(result.stderr));
  }

  const snapshot = parseQueryOutput(result.stdout, valueName);
  if (snapshot === null) {
    throw new TuneSmithError('parse-failed', `reg.exe output did not contain ${valueName}`, oneLine(result.stdout));
  }
  return snapshot;
}

export async function writeValue(
  hive: RegistryHive,
  pathValue: string,
  valueName: string,
  type: RegType,
  data: RegData,
): Promise<void> {
  const encoded = typeof data === 'number' ? String(data) : data;
  const result = await runExe('reg.exe', [
    'add',
    keyPath(hive, pathValue),
    '/v',
    valueName,
    '/t',
    type,
    '/d',
    encoded,
    '/f',
  ]);

  if (result.code !== 0) {
    throw new TuneSmithError('apply-failed', `Could not write ${valueName}`, oneLine(result.stderr));
  }
}

/**
 * Direct child key names of a key. Used to enumerate per-device and per-interface
 * state (PCI Enum entries, TCP interfaces) that cannot be named in a preset file
 * because the names differ on every machine. Output lines are full key paths.
 */
export async function listSubkeys(hive: RegistryHive, pathValue: string): Promise<string[]> {
  const prefix = `${keyPath(hive, pathValue)}\\`.toLowerCase();
  const result = await runExe('reg.exe', ['query', keyPath(hive, pathValue)]);
  if (result.code !== 0) {
    throw new TuneSmithError('capture-failed', `Could not enumerate ${pathValue}`, oneLine(result.stderr));
  }

  const names = new Set<string>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().startsWith(prefix)) continue;
    const rest = trimmed.slice(prefix.length);
    const child = rest.split('\\')[0]?.trim() ?? '';
    if (child.length > 0) names.add(child);
  }
  return [...names].sort();
}

/**
 * Presence check that never throws on exotic value types: some interface values are
 * REG_MULTI_SZ, which `readValue` deliberately refuses to snapshot. Callers use this
 * to decide whether an interface is configured, then snapshot only DWORD values.
 */
export async function valueExists(hive: RegistryHive, pathValue: string, valueName: string): Promise<boolean> {
  const result = await runExe('reg.exe', ['query', keyPath(hive, pathValue), '/v', valueName]);
  if (result.code !== 0) {
    if (/unable to find/i.test(result.stderr)) return false;
    throw new TuneSmithError('capture-failed', `Could not read ${valueName}`, oneLine(result.stderr));
  }
  return true;
}

export async function deleteValue(hive: RegistryHive, pathValue: string, valueName: string): Promise<void> {
  const result = await runExe('reg.exe', ['delete', keyPath(hive, pathValue), '/v', valueName, '/f']);
  // Deleting an already-absent value is success: rollback must be idempotent.
  if (result.code !== 0 && !/unable to find/i.test(result.stderr)) {
    throw new TuneSmithError('apply-failed', `Could not delete ${valueName}`, oneLine(result.stderr));
  }
}
