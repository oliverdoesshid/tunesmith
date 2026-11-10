/**
 * Service adapter built on `sc.exe` with argv arrays.
 *
 * `sc config <name> start= <mode>` requires the `start=` token and the value as
 * separate arguments; that shape was verified against a live host (a bogus service
 * name returns 1060 "does not exist", not a syntax error).
 *
 * Raw registry writes to `HKLM\...\Services` are blocked by policy, so every service
 * change goes through SCM, which keeps dependency and driver checks intact.
 */
import { TuneSmithError } from '../../shared/errors';
import type { ServiceStartupMode } from '../../shared/types';
import type { CapturedState, ServiceStartType } from '../../shared/session';
import { oneLine, runExe } from './exec';

export interface ServiceSnapshot {
  exists: boolean;
  startType: ServiceStartType;
  running: boolean;
}

const SC_TO_START_TYPE: Record<string, ServiceStartType> = { '2': 'Auto', '3': 'Manual', '4': 'Disabled' };

const START_MODE_TO_SC: Record<ServiceStartupMode, string> = {
  Automatic: 'auto',
  Manual: 'demand',
  Disabled: 'disabled',
};

const ERROR_SERVICE_DOES_NOT_EXIST = 1060;
const ERROR_SERVICE_NOT_ACTIVE = 1062;

export async function readService(name: string): Promise<ServiceSnapshot> {
  const config = await runExe('sc.exe', ['qc', name]);
  if (config.code !== 0) {
    if (config.code === ERROR_SERVICE_DOES_NOT_EXIST) {
      return { exists: false, startType: 'Unknown', running: false };
    }
    throw new TuneSmithError('capture-failed', `Could not query service ${name}`, oneLine(config.stderr));
  }

  const startLine = /START_TYPE\s*:\s*(\d+)/.exec(config.stdout);
  if (!startLine?.[1]) {
    throw new TuneSmithError('parse-failed', `Could not parse start type for ${name}`, oneLine(config.stdout));
  }
  const startType = SC_TO_START_TYPE[startLine[1]] ?? 'Unknown';

  const state = await runExe('sc.exe', ['query', name]);
  const stateLine = /STATE\s*:\s*(\d+)/.exec(state.stdout);
  const running = stateLine?.[1] === '4';

  return { exists: true, startType, running };
}

export async function setStartup(name: string, mode: ServiceStartupMode, delayedStart: boolean): Promise<void> {
  const scMode = delayedStart && mode === 'Automatic' ? 'delayed-auto' : START_MODE_TO_SC[mode];
  const result = await runExe('sc.exe', ['config', name, 'start=', scMode]);
  if (result.code !== 0) {
    throw new TuneSmithError('apply-failed', `Could not set startup of ${name}`, oneLine(result.stderr));
  }
}

export async function stopService(name: string): Promise<void> {
  const result = await runExe('sc.exe', ['stop', name]);
  if (result.code === 0 || result.code === ERROR_SERVICE_NOT_ACTIVE) return;
  throw new TuneSmithError('apply-failed', `Could not stop ${name}`, oneLine(result.stderr));
}

export async function startService(name: string): Promise<void> {
  const result = await runExe('sc.exe', ['start', name]);
  // 1056 = already running.
  if (result.code === 0 || result.code === 1056) return;
  throw new TuneSmithError('apply-failed', `Could not start ${name}`, oneLine(result.stderr));
}

/** Build the journal payload for a service target. */
export function toCapturedState(target: string, snapshot: ServiceSnapshot): CapturedState {
  if (!snapshot.exists) return { kind: 'service', target, exists: false };
  return { kind: 'service', target, exists: true, startType: snapshot.startType, running: snapshot.running };
}
