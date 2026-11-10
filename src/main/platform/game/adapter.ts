/**
 * The real implementation of the controller's `GameAdapter`.
 *
 * Kept as a one-line-per-operation binding so the controller never imports a platform
 * module directly, and tests can substitute a fake without touching `node:child_process`.
 */
import type { GameAdapter } from '../../engine/game/controller';
import {
  applyAffinityAndPriority,
  purgeStandbyList,
  readGpuPreference,
  readProcessPriority,
  restoreGpuPreference,
  resumeProcesses,
  setProcessPriority,
  suspendProcesses,
  writeGpuPreference,
} from './control';
import { setEcoMode } from './eco';
import { startTimerHold } from './timer';
import { resolvePackage } from './packages';
import { detectTopology } from './topology';

export function createSystemGameAdapter(): GameAdapter {
  return {
    topology: () => detectTopology(),
    applyAffinityAndPriority,
    readProcessPriority,
    setProcessPriority,
    suspendProcesses,
    resumeProcesses,
    setEcoMode,
    startTimerHold,
    purgeStandbyList,
    readGpuPreference,
    writeGpuPreference,
    restoreGpuPreference,
    resolvePackage,
  };
}
