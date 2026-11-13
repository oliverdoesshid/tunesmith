/**
 * Local crash listener.
 *
 * Crashpad is configured with `uploadToServer: false`; minidumps are written to the
 * app's own userData `crashes` directory and never leave the machine. Every unexpected
 * process exit also gets a small JSON incident file so the correlator has a timestamp,
 * reason and version context even when no minidump was produced (for example a JS
 * exception in the renderer).
 *
 * A run marker distinguishes a clean quit from a hard kill/power loss. The marker is
 * removed in `will-quit`; a marker found at the next startup becomes an
 * "unclean-shutdown" report.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, crashReporter } from 'electron';
import type { CrashKind } from '../../shared/diagnostics/types';

export interface CrashIncident {
  schemaVersion: 1;
  id: string;
  at: string;
  kind: CrashKind;
  appVersion: string;
  electronVersion: string;
  platform: string;
  arch: string;
  processType?: string;
  reason?: string;
  exitCode?: number;
  webContentsId?: number;
  details?: string;
}

export interface CrashCollectorOptions {
  crashDir: string;
  appVersion: string;
  electronVersion: string;
  platform: string;
  arch: string;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface CrashCollector {
  readonly crashDir: string;
  record(kind: CrashKind, details: Record<string, unknown>): string | null;
  markCleanExit(): void;
}

interface RuntimeMarker {
  schemaVersion: 1;
  startedAt: string;
  pid: number;
}

function safeDetails(details: Record<string, unknown>): string | undefined {
  try {
    const text = JSON.stringify(details, (_key, value: unknown) => {
      if (value instanceof Error) return value.stack ?? value.message;
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'string') return value.slice(0, 2_000);
      return value;
    });
    return text.length > 8_000 ? `${text.slice(0, 8_000)}…[truncated]` : text;
  } catch {
    return undefined;
  }
}

export function startCrashCollector(options: CrashCollectorOptions): CrashCollector {
  const crashDir = path.resolve(options.crashDir);
  const incidentsDir = path.join(crashDir, 'incidents');
  mkdirSync(incidentsDir, { recursive: true });
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});

  // Crashpad needs the dump directory before the first renderer exists. This is a path
  // in the current user's profile; no upload URL is ever contacted because
  // `uploadToServer` stays false.
  app.setPath('crashDumps', crashDir);
  crashReporter.start({
    companyName: 'TuneSmith',
    productName: 'TuneSmith',
    submitURL: 'https://tunesmith.invalid/local-only-crash-upload',
    uploadToServer: false,
    compress: false,
    rateLimit: false,
  });

  const markerPath = path.join(crashDir, 'runtime.json');
  let previousMarker: RuntimeMarker | null = null;
  try {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as Partial<RuntimeMarker>;
    if (parsed.schemaVersion === 1 && typeof parsed.startedAt === 'string') {
      previousMarker = {
        schemaVersion: 1,
        startedAt: parsed.startedAt,
        pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
      };
    }
  } catch {
    // First run, or an unreadable marker. The latter still means the previous run did
    // not clear it, so it is reported below as an unclean shutdown.
    if (existsSync(markerPath)) previousMarker = { schemaVersion: 1, startedAt: 'unknown', pid: 0 };
  }

  const collector: CrashCollector = {
    crashDir,
    record(kind, details): string | null {
      try {
        const at = now().toISOString();
        const incident: CrashIncident = {
          schemaVersion: 1,
          id: `crash-${String(Date.now())}-${randomUUID().slice(0, 8)}`,
          at,
          kind,
          appVersion: options.appVersion,
          electronVersion: options.electronVersion,
          platform: options.platform,
          arch: options.arch,
          details: safeDetails(details),
        };
        const file = path.join(incidentsDir, `${incident.id}.json`);
        writeFileSync(file, `${JSON.stringify(incident, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        log(`[crash] recorded ${kind} incident ${incident.id}`);
        return incident.id;
      } catch (error) {
        log(`[crash] could not record ${kind} incident: ${String(error)}`);
        return null;
      }
    },
    markCleanExit(): void {
      try {
        if (existsSync(markerPath)) unlinkSync(markerPath);
      } catch (error) {
        log(`[crash] could not clear the run marker: ${String(error)}`);
      }
    },
  };

  if (previousMarker !== null) {
    collector.record('unclean-shutdown', {
      previousStartedAt: previousMarker.startedAt,
      previousPid: previousMarker.pid,
      detectedAt: now().toISOString(),
    });
  }

  try {
    const marker: RuntimeMarker = { schemaVersion: 1, startedAt: now().toISOString(), pid: process.pid };
    writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    log(`[crash] could not write the run marker: ${String(error)}`);
  }

  app.on('render-process-gone', (_event, contents, details) => {
    if (details.reason === 'clean-exit') return;
    collector.record('renderer', {
      webContentsId: contents.id,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    collector.record('child-process', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName,
      name: details.name,
    });
  });

  process.on('uncaughtExceptionMonitor', (error, origin) => {
    collector.record('main-process', {
      origin,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  });

  return collector;
}
