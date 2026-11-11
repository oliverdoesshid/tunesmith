import path from 'node:path';
import type {
  HealthFileFingerprint,
  HealthServicingState,
  HealthSignal,
  HealthSnapshot,
} from '../../shared/health/types';

function osLabel(os: HealthSnapshot['os']): string {
  return `${os.build}${os.revision === null ? '' : `.${os.revision}`}`;
}

function changedFiles(baseline: readonly HealthFileFingerprint[], current: readonly HealthFileFingerprint[]): string[] {
  const before = new Map(baseline.map((file) => [file.path.toLowerCase(), file]));
  const after = new Map(current.map((file) => [file.path.toLowerCase(), file]));
  const changed: string[] = [];

  for (const [key, old] of before) {
    const next = after.get(key);
    if (next === undefined || next.sha256 !== old.sha256 || next.size !== old.size) {
      changed.push(path.basename(old.path));
    }
  }

  return changed.sort((a, b) => a.localeCompare(b));
}

const SERVICING_LABEL: Record<keyof HealthServicingState, string> = {
  rebootPending: 'component servicing restart pending',
  packagesPending: 'component packages pending',
  windowsUpdateReboot: 'Windows Update restart required',
  pendingFileRename: 'pending file rename operation',
};

/**
 * Explain what changed since the accepted baseline. A build/UBR change subsumes file
 * changes: a cumulative update is allowed to replace system files, and reporting both
 * would double the noise. A file change with the same build is the tamper/unexpected case.
 */
export function compareHealth(baseline: HealthSnapshot, current: HealthSnapshot): HealthSignal[] {
  const signals: HealthSignal[] = [];
  const buildChanged =
    baseline.os.build !== current.os.build || baseline.os.revision !== current.os.revision;

  if (buildChanged) {
    signals.push({
      id: 'os-update',
      kind: 'os-update',
      severity: 'warning',
      title: 'Windows build changed',
      detail: `Detected ${osLabel(baseline.os)} → ${osLabel(current.os)}. Re-apply the pinned preset after reviewing its plan, or roll back unfinished sessions before rebooting again.`,
    });
  }

  const newlyPending = (Object.keys(SERVICING_LABEL) as (keyof HealthServicingState)[]).filter(
    (key) => current.servicing[key] && !baseline.servicing[key],
  );
  if (newlyPending.length > 0) {
    signals.push({
      id: `servicing-${newlyPending.join('-')}`,
      kind: 'servicing',
      severity: 'warning',
      title: 'Windows servicing state changed',
      detail: `New: ${newlyPending.map((key) => SERVICING_LABEL[key]).join(', ')}. A cumulative update or pending restart may overwrite tuning values.`,
    });
  }

  if (!buildChanged) {
    const files = changedFiles(baseline.files, current.files);
    if (files.length > 0) {
      signals.push({
        id: 'system-file',
        kind: 'system-file',
        severity: 'warning',
        title: 'Core system files changed',
        detail: `${files.join(', ')} changed without a Windows build change. Verify the update source; existing journals may no longer describe the current system.`,
      });
    }
  }

  return signals;
}
