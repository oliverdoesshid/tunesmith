/**
 * Power adapter built on `powercfg.exe`.
 *
 * Two deliberate constraints:
 *   1. Only the AC index is written. DC (battery) behaviour is left alone, so a
 *      tuning preset cannot quietly destroy a laptop's runtime.
 *   2. Every setting is resolved to a friendly id in shared/power.ts. A preset can
 *      never hand us a raw GUID.
 *
 * Note that `powercfg -setacvalueindex` only stages a value; the scheme must be made
 * active again before the change takes effect. That is why `applySetting` always
 * follows with `-setactive`.
 */
import { TuneSmithError } from '../../shared/errors';
import { POWER_SETTINGS, POWER_SUBGROUPS, type PowerSettingId } from '../../shared/power';
import { oneLine, runExe } from './exec';

export interface ActiveScheme {
  guid: string;
  name: string;
}

export async function getActiveScheme(): Promise<ActiveScheme> {
  const result = await runExe('powercfg.exe', ['-getactivescheme']);
  if (result.code !== 0) {
    throw new TuneSmithError('capture-failed', 'Could not read the active power scheme', oneLine(result.stderr));
  }
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(result.stdout);
  if (!match?.[1]) {
    throw new TuneSmithError('parse-failed', 'Power scheme output did not contain a GUID', oneLine(result.stdout));
  }
  const nameMatch = /\(([^)]+)\)\s*$/.exec(result.stdout.trim());
  return { guid: match[1].toLowerCase(), name: nameMatch?.[1]?.trim() ?? 'Unknown' };
}

/**
 * Read the current AC value of one curated setting.
 *
 * Returns null when the setting is not reported. That happens for hidden settings,
 * and the engine treats null as "cannot be captured" and refuses to write it rather
 * than risk an unrestorable change.
 */
export async function readSetting(schemeGuid: string, setting: PowerSettingId): Promise<number | null> {
  const meta = POWER_SETTINGS[setting];
  const subgroup = POWER_SUBGROUPS[meta.subgroup];
  const result = await runExe('powercfg.exe', ['-query', schemeGuid, subgroup, meta.guid]);
  if (result.code !== 0) {
    throw new TuneSmithError('capture-failed', `Could not read power setting ${setting}`, oneLine(result.stderr));
  }
  const match = /Current AC Power Setting Index:\s*0x([0-9a-f]+)/i.exec(result.stdout);
  if (!match?.[1]) return null;
  return Number.parseInt(match[1], 16);
}

export async function setActiveScheme(schemeGuid: string): Promise<void> {
  const result = await runExe('powercfg.exe', ['-setactive', schemeGuid]);
  if (result.code !== 0) {
    throw new TuneSmithError('apply-failed', 'Could not activate the power scheme', oneLine(result.stderr));
  }
}

export async function applySetting(schemeGuid: string, setting: PowerSettingId, value: number): Promise<void> {
  const meta = POWER_SETTINGS[setting];

  // Defence in depth: the policy layer already rejected out-of-range values.
  if (!Number.isInteger(value) || value < meta.min || value > meta.max) {
    throw new TuneSmithError('invalid-request', `Value ${value} is outside ${meta.label} (${meta.min}-${meta.max})`);
  }

  const subgroup = POWER_SUBGROUPS[meta.subgroup];
  const staged = await runExe('powercfg.exe', [
    '-setacvalueindex',
    schemeGuid,
    subgroup,
    meta.guid,
    String(value),
  ]);
  if (staged.code !== 0) {
    throw new TuneSmithError('apply-failed', `Could not set ${meta.label}`, oneLine(staged.stderr));
  }

  await setActiveScheme(schemeGuid);
}
