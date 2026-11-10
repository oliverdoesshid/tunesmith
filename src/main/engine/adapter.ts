/**
 * The bridge between a planned step and the real machine.
 *
 * Kept behind an interface so the executor can be tested with a fake adapter: the
 * apply/rollback state machine, the crash-recovery behaviour and the "never mutate what
 * you cannot capture" rule are all exercised without touching the host.
 */
import { TuneSmithError } from '../../shared/errors';
import { POWER_PLANS, type PowerSettingId } from '../../shared/power';
import type { CapturedState } from '../../shared/session';
import type { PlannedStep } from '../../shared/preset/compiler';
import { deleteValue, readValue, writeValue } from '../platform/registry';
import { getActiveScheme, applySetting, readSetting, setActiveScheme } from '../platform/power';
import { readProcessPriorities, restorePriorities, setProcessPriority, assertPrioritySupported } from '../platform/processes';
import {
  listActiveInterfaces,
  listPciDevices,
  readInterfaceTcp,
  readIrqPriority,
  readMsiState,
  restoreInterfaceTcp,
  restoreIrqPriority,
  restoreMsiState,
  writeInterfaceTcp,
  writeIrqPriority,
  writeMsiState,
} from '../platform/interrupts';
import { readService, setStartup, startService, stopService, toCapturedState } from '../platform/services';
import type { ServiceStartupMode } from '../../shared/types';

/** Parse an `irq:<n>` journal target back to its number. Journal targets are written by the compiler, but a corrupt journal must still fail loudly, not write somewhere else. */
function actionIrq(target: string): number {
  const match = /^irq:(\d{1,3})$/.exec(target);
  const irq = match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);
  if (!Number.isInteger(irq) || irq < 0 || irq > 255) {
    throw new TuneSmithError('rollback-failed', `Malformed IRQ target ${target}`);
  }
  return irq;
}

/** `sc.exe` reports `Auto`, while the action vocabulary spells it `Automatic`. */
const CAPTURED_TO_MODE: Record<'Auto' | 'Manual' | 'Disabled', ServiceStartupMode> = {
  Auto: 'Automatic',
  Manual: 'Manual',
  Disabled: 'Disabled',
};

export interface StepAdapter {
  capture(step: PlannedStep): Promise<CapturedState>;
  apply(step: PlannedStep, before: CapturedState): Promise<void>;
  restore(state: CapturedState): Promise<void>;
}

export class SystemAdapter implements StepAdapter {
  async capture(step: PlannedStep): Promise<CapturedState> {
    const action = step.action;

    switch (action.kind) {
      case 'registry': {
        const target = `${action.hive}\\${action.path}\\${action.name}`;
        const snapshot = await readValue(action.hive, action.path, action.name);
        if (!snapshot.exists) return { kind: 'registry', target, exists: false };
        return { kind: 'registry', target, exists: true, valueType: snapshot.valueType, data: snapshot.data };
      }
      case 'service': {
        const snapshot = await readService(action.name);
        return toCapturedState(`service:${action.name}`, snapshot);
      }
      case 'priority': {
        const snapshot = await readProcessPriorities(action.process);
        return { kind: 'priority', target: `process:${action.process}`, instances: snapshot.instances };
      }
      case 'power-plan': {
        const scheme = await getActiveScheme();
        return { kind: 'power-plan', target: 'power:plan', schemeGuid: scheme.guid };
      }
      case 'power-setting': {
        const scheme = await getActiveScheme();
        const value = await readSetting(scheme.guid, action.setting);
        return { kind: 'power-setting', target: `power:${action.setting}`, schemeGuid: scheme.guid, value };
      }
      case 'device-interrupt': {
        // Runtime enumeration: the device list cannot be named in a preset file.
        const devices = await listPciDevices(action.deviceClass);
        if (devices.length === 0) {
          throw new TuneSmithError(
            'capture-failed',
            `No PCI ${action.deviceClass === 'gpu' ? 'GPU' : 'network'} device found`,
            'Refusing an interrupt change with no device to apply it to.',
          );
        }
        const states: { path: string; msi: { existed: boolean; data?: number }; limit: { existed: boolean; data?: number } }[] = [];
        for (const instanceId of devices) {
          const snapshot = await readMsiState(instanceId);
          states.push({
            path: instanceId,
            msi: snapshot.msiSupported,
            limit: snapshot.messageLimit,
          });
        }
        return { kind: 'device-interrupt', target: `interrupt:${action.deviceClass}`, devices: states };
      }
      case 'irq-priority': {
        const snapshot = await readIrqPriority(action.irq);
        return { kind: 'irq-priority', target: `irq:${action.irq}`, ...snapshot };
      }
      case 'network': {
        const guids = await listActiveInterfaces();
        if (guids.length === 0) {
          throw new TuneSmithError(
            'capture-failed',
            'No active TCP interface found',
            'Refusing a network change with no interface to apply it to.',
          );
        }
        const interfaces: { guid: string; tcpAckFrequency: number | null; tcpNoDelay: number | null }[] = [];
        for (const guid of guids) {
          interfaces.push(await readInterfaceTcp(guid));
        }
        return { kind: 'network', target: 'network:tcp', interfaces };
      }
    }
  }

  async apply(step: PlannedStep, before: CapturedState): Promise<void> {
    const action = step.action;

    switch (action.kind) {
      case 'registry': {
        if (action.op === 'set') {
          await writeValue(action.hive, action.path, action.name, action.type, action.data);
        } else {
          await deleteValue(action.hive, action.path, action.name);
        }
        return;
      }
      case 'service': {
        if (action.startup !== undefined) {
          await setStartup(action.name, action.startup, action.delayedStart === true);
        }
        if (action.stop === true) {
          await stopService(action.name);
        }
        return;
      }
      case 'priority': {
        assertPrioritySupported(action.priority);
        await setProcessPriority(action.process, action.priority);
        return;
      }
      case 'power-plan': {
        await setActiveScheme(POWER_PLANS[action.plan].guid);
        return;
      }
      case 'device-interrupt': {
        // Devices are re-enumerated at apply time, but only captured devices are
        // touched: a device that appeared between capture and apply is left alone.
        const wanted = new Set(before.kind === 'device-interrupt' ? before.devices.map((entry) => entry.path) : []);
        const devices = (await listPciDevices(action.deviceClass)).filter((id) => wanted.has(id));
        for (const instanceId of devices) {
          await writeMsiState(instanceId, action.messageLimit);
        }
        return;
      }
      case 'irq-priority': {
        await writeIrqPriority(action.irq, action.priority);
        return;
      }
      case 'network': {
        // Same rule as MSI: only interfaces present at capture time are written.
        const wanted = new Set(before.kind === 'network' ? before.interfaces.map((entry) => entry.guid) : []);
        const guids = (await listActiveInterfaces()).filter((guid) => wanted.has(guid));
        for (const guid of guids) {
          await writeInterfaceTcp(guid, { tcpAckFrequency: action.tcpAckFrequency, tcpNoDelay: action.tcpNoDelay });
        }
        return;
      }
      case 'power-setting': {
        // Apply to the scheme that was captured from, not to "whatever is active now".
        const schemeGuid = before.kind === 'power-setting' ? before.schemeGuid : (await getActiveScheme()).guid;
        if (before.kind === 'power-setting' && before.value === null) {
          throw new TuneSmithError(
            'capture-failed',
            `Cannot read the current value of ${action.setting}`,
            'Refusing to change a power setting whose prior value is unknown, because it could not be restored.',
          );
        }
        await applySetting(schemeGuid, action.setting, action.value);
        return;
      }
    }
  }

  async restore(state: CapturedState): Promise<void> {
    switch (state.kind) {
      case 'registry': {
        const [hive, ...rest] = state.target.split('\\');
        const valueName = rest.pop();
        if (hive === undefined || valueName === undefined) {
          throw new TuneSmithError('rollback-failed', `Malformed registry target ${state.target}`);
        }
        const pathValue = rest.join('\\');
        if (!state.exists) {
          await deleteValue(hive as 'HKCU' | 'HKLM', pathValue, valueName);
        } else {
          await writeValue(hive as 'HKCU' | 'HKLM', pathValue, valueName, state.valueType, state.data);
        }
        return;
      }
      case 'service': {
        if (!state.exists) {
          // System services are never created by a preset, so there is nothing to undo.
          return;
        }
        const name = state.target.replace(/^service:/, '');
        if (state.startType !== 'Unknown') {
          await setStartup(name, CAPTURED_TO_MODE[state.startType], false);
        }
        if (state.running) await startService(name);
        else await stopService(name);
        return;
      }
      case 'priority': {
        const processName = state.target.replace(/^process:/, '');
        await restorePriorities(processName, state.instances);
        return;
      }
      case 'power-plan': {
        if (state.schemeGuid !== null) await setActiveScheme(state.schemeGuid);
        return;
      }
      case 'power-setting': {
        if (state.value === null) return;
        const setting = state.target.replace(/^power:/, '') as PowerSettingId;
        await applySetting(state.schemeGuid, setting, state.value);
        return;
      }
      case 'device-interrupt': {
        for (const entry of state.devices) {
          await restoreMsiState(entry.path, { msiSupported: entry.msi, messageLimit: entry.limit });
        }
        return;
      }
      case 'irq-priority': {
        await restoreIrqPriority(actionIrq(state.target), { existed: state.existed, value: state.value });
        return;
      }
      case 'network': {
        for (const entry of state.interfaces) {
          await restoreInterfaceTcp(entry.guid, entry);
        }
        return;
      }
    }
  }
}
