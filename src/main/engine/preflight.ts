/**
 * Preflight: everything that must be true before the engine is allowed to mutate the OS.
 *
 * Checks are additive and never throw: a failed probe becomes a `fail` check, which
 * makes the whole report not-ready. The UI shows the list verbatim, so the user always
 * knows exactly why applying is disabled.
 */
import { describeError } from '../../shared/errors';
import type { PreflightCheck, PreflightReport } from '../../shared/session';
import type { HardwareSpec } from '../../shared/types';
import type { JournalStore } from './journal';
import type { SystemRestoreProbe } from '../platform/restore-point';

/** Windows 10 2004. Older builds lack several of the settings the vocabulary uses. */
export const MINIMUM_OS_BUILD = 19041;

export interface PreflightDeps {
  journal: JournalStore;
  getSpec: (force?: boolean) => Promise<HardwareSpec>;
  isElevated: () => Promise<boolean>;
  probeRestore: () => Promise<SystemRestoreProbe>;
  lockHolder: () => Promise<{ pid: number } | null>;
}

function check(id: string, label: string, status: PreflightCheck['status'], detail: string): PreflightCheck {
  return { id, label, status, detail };
}

export async function runPreflight(deps: PreflightDeps): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];
  let spec: HardwareSpec | null = null;
  let isElevated = false;

  checks.push(
    process.platform === 'win32'
      ? check('platform', 'Windows', 'ok', 'Running on Windows.')
      : check('platform', 'Windows', 'fail', `Unsupported platform: ${process.platform}.`),
  );

  try {
    spec = await deps.getSpec();
    const build = spec.os.build;
    checks.push(
      build >= MINIMUM_OS_BUILD
        ? check('os-build', 'Windows version', 'ok', `${spec.os.caption} (build ${build}).`)
        : check('os-build', 'Windows version', 'fail', `Build ${build} is older than ${MINIMUM_OS_BUILD}.`),
    );
    checks.push(
      spec.signature.length > 0
        ? check('signature', 'Hardware signature', 'ok', spec.signature)
        : check('signature', 'Hardware signature', 'fail', 'Hardware signature could not be built.'),
    );
  } catch (err) {
    checks.push(check('os-build', 'Windows version', 'fail', `Hardware detection failed: ${describeError(err)}`));
    checks.push(check('signature', 'Hardware signature', 'fail', 'Hardware signature is unavailable.'));
  }

  try {
    isElevated = await deps.isElevated();
  } catch (err) {
    checks.push(check('elevation', 'Administrator rights', 'fail', `Could not determine elevation: ${describeError(err)}`));
  }
  if (checks.every((c) => c.id !== 'elevation')) {
    checks.push(
      isElevated
        ? check('elevation', 'Administrator rights', 'ok', 'Running elevated; system changes are permitted.')
        : check(
            'elevation',
            'Administrator rights',
            'fail',
            'Not elevated. Restart with administrator rights to apply presets (browsing still works).',
          ),
    );
  }

  const writable = await deps.journal.isWritable();
  checks.push(
    writable.ok
      ? check('journal', 'Rollback journal', 'ok', writable.detail)
      : check('journal', 'Rollback journal', 'fail', `Journal is not writable: ${writable.detail}`),
  );

  try {
    const restore = await deps.probeRestore();
    checks.push(
      restore.available
        ? check('system-restore', 'System Restore', 'ok', restore.detail)
        : check('system-restore', 'System Restore', 'warn', `${restore.detail} Rollback will rely on the journal only.`),
    );
    if (restore.available && restore.frequencyMinutes !== null && restore.frequencyMinutes > 0) {
      checks.push(
        check(
          'restore-throttle',
          'Checkpoint throttle',
          'warn',
          `Windows creates at most one checkpoint every ${restore.frequencyMinutes} minute(s); a recent checkpoint may cause this one to be skipped.`,
        ),
      );
    }
  } catch (err) {
    checks.push(check('system-restore', 'System Restore', 'warn', `Probe failed: ${describeError(err)}`));
  }

  let inFlight: string | null = null;
  try {
    const holder = await deps.lockHolder();
    if (holder !== null) {
      inFlight = String(holder.pid);
      checks.push(check('engine-idle', 'Engine state', 'fail', `Another session is running (pid ${holder.pid}).`));
    } else {
      checks.push(check('engine-idle', 'Engine state', 'ok', 'No other session is running.'));
    }
  } catch (err) {
    inFlight = null;
    checks.push(check('engine-idle', 'Engine state', 'warn', `Lock probe failed: ${describeError(err)}`));
  }

  return {
    checks,
    ready: checks.every((c) => c.status !== 'fail'),
    isElevated,
    signature: spec?.signature ?? '',
    inFlightSession: inFlight,
  };
}
