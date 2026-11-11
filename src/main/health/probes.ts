/**
 * Read-only Windows health probes.
 *
 * Nothing here takes a lock or writes to the OS. The only writes in the watchdog are its
 * own baseline under userData and the user-initiated stale-journal cleanup.
 */
import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { release as osRelease } from 'node:os';
import path from 'node:path';
import type {
  HealthFileFingerprint,
  HealthServicingState,
  HealthSnapshot,
} from '../../shared/health/types';
import { keyExists, readValue, valueExists } from '../platform/registry';

const CURRENT_VERSION = 'SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';

export const WATCHED_SYSTEM_FILES = [
  'System32\\ntoskrnl.exe',
  'System32\\ntdll.dll',
  'System32\\advapi32.dll',
  'System32\\powrprof.dll',
] as const;

const MAX_HASHED_BYTES = 256 * 1024 * 1024;

function errorLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 240);
}

async function registryString(
  key: string,
  value: string,
  warnings: string[],
): Promise<string | null> {
  try {
    const snapshot = await readValue('HKLM', key, value);
    if (!snapshot.exists) return null;
    return String(snapshot.data).trim() || null;
  } catch (error) {
    warnings.push(`Could not read ${value}: ${errorLine(error)}`);
    return null;
  }
}

async function registryNumber(
  key: string,
  value: string,
  warnings: string[],
): Promise<number | null> {
  const raw = await registryString(key, value, warnings);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function servicingFlag(
  label: string,
  probe: () => Promise<boolean>,
  warnings: string[],
): Promise<boolean> {
  try {
    return await probe();
  } catch (error) {
    warnings.push(`Could not read ${label}: ${errorLine(error)}`);
    return false;
  }
}

/** Hash one watched system file; symlinks are refused rather than followed. */
export async function fingerprintFile(file: string): Promise<HealthFileFingerprint> {
  const info = await lstat(file);
  if (!info.isFile()) throw new Error('not a regular file');
  if (info.size > MAX_HASHED_BYTES) throw new Error('file is too large to hash safely');

  const bytes = await readFile(file);
  return {
    path: file,
    size: bytes.byteLength,
    mtimeMs: info.mtimeMs,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export interface HealthProbeOptions {
  systemRoot?: string;
  watchedFiles?: readonly string[];
  now?: () => Date;
}

export async function probeHealthSnapshot(options: HealthProbeOptions = {}): Promise<HealthSnapshot> {
  const warnings: string[] = [];
  const now = options.now?.() ?? new Date();
  const systemRoot = options.systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows';

  const [build, revision, displayVersion, rebootPending, packagesPending, windowsUpdateReboot, pendingFileRename] =
    await Promise.all([
      registryString(CURRENT_VERSION, 'CurrentBuildNumber', warnings),
      registryNumber(CURRENT_VERSION, 'UBR', warnings),
      registryString(CURRENT_VERSION, 'DisplayVersion', warnings),
      servicingFlag(
        'component servicing restart state',
        () => keyExists('HKLM', 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending'),
        warnings,
      ),
      servicingFlag(
        'component packages state',
        () => keyExists('HKLM', 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\PackagesPending'),
        warnings,
      ),
      servicingFlag(
        'Windows Update restart state',
        () => keyExists('HKLM', 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'),
        warnings,
      ),
      servicingFlag(
        'pending file rename state',
        () => valueExists('HKLM', 'SYSTEM\\CurrentControlSet\\Control\\Session Manager', 'PendingFileRenameOperations'),
        warnings,
      ),
    ]);

  const watched = options.watchedFiles ?? WATCHED_SYSTEM_FILES;
  const files: HealthFileFingerprint[] = [];
  for (const relative of watched) {
    const file = path.join(systemRoot, relative);
    try {
      files.push(await fingerprintFile(file));
    } catch (error) {
      warnings.push(`Could not fingerprint ${path.basename(file)}: ${errorLine(error)}`);
    }
  }

  const release = osRelease();
  const fallbackBuild = release.split('.').filter((part) => part.length > 0).at(-1) ?? release;
  const servicing: HealthServicingState = {
    rebootPending,
    packagesPending,
    windowsUpdateReboot,
    pendingFileRename,
  };

  return {
    schemaVersion: 1,
    capturedAt: now.toISOString(),
    os: {
      build: build ?? fallbackBuild,
      revision,
      displayVersion,
    },
    servicing,
    files,
    warnings: [...new Set(warnings)].slice(0, 20),
  };
}
