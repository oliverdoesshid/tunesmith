/**
 * Crash/log correlation and bundle assembly.
 *
 * The native minidump is treated as opaque bytes: TuneSmith does not embed a debugger.
 * Instead this module correlates the dump timestamp with the durable session journal and
 * the rotating log tail, producing a human-readable report that a maintainer can read
 * alongside the dump. Nothing is uploaded or sent automatically.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CrashKind, DiagnosticsExportRequest, DiagnosticsExportResult } from '../../shared/diagnostics/types';
import type { SessionSummary } from '../../shared/session';
import type { CrashIncident } from './crash-collector';
import { createRedactor, type RedactionIdentity } from './redact';
import { createZip, type ZipEntry } from './zip';

export interface DiagnosticsServiceOptions {
  crashDir: string;
  logDir: string;
  getJournal: () => Promise<SessionSummary[]>;
  /** Injected in tests; production reads the current Windows account. */
  identity?: RedactionIdentity;
  appVersion?: string;
  electronVersion?: string;
  now?: () => Date;
}

interface LocatedIncident {
  file: string;
  incident: CrashIncident;
}

interface DumpFile {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: number;
}

const MAX_REPORTS = 50;
const MAX_ZIP_DUMP_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_LOG_BYTES = 2 * 1024 * 1024;

function kindLabel(kind: CrashKind): string {
  switch (kind) {
    case 'renderer':
      return 'Renderer process crash';
    case 'child-process':
      return 'Electron child process crash';
    case 'main-process':
      return 'Main process exception';
    case 'unclean-shutdown':
      return 'Unexpected shutdown';
  }
}

function asIncident(raw: unknown): CrashIncident | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.id !== 'string' ||
    !/^[A-Za-z0-9-]{8,64}$/.test(record.id) ||
    typeof record.at !== 'string' ||
    typeof record.kind !== 'string'
  ) {
    return null;
  }
  const kinds: CrashKind[] = ['renderer', 'child-process', 'main-process', 'unclean-shutdown'];
  if (!kinds.includes(record.kind as CrashKind)) return null;
  return {
    schemaVersion: 1,
    id: record.id.slice(0, 64),
    at: record.at,
    kind: record.kind as CrashKind,
    appVersion: typeof record.appVersion === 'string' ? record.appVersion : 'unknown',
    electronVersion: typeof record.electronVersion === 'string' ? record.electronVersion : 'unknown',
    platform: typeof record.platform === 'string' ? record.platform : 'unknown',
    arch: typeof record.arch === 'string' ? record.arch : 'unknown',
    processType: typeof record.processType === 'string' ? record.processType : undefined,
    reason: typeof record.reason === 'string' ? record.reason : undefined,
    exitCode: typeof record.exitCode === 'number' ? record.exitCode : undefined,
    webContentsId: typeof record.webContentsId === 'number' ? record.webContentsId : undefined,
    details: typeof record.details === 'string' ? record.details : undefined,
  };
}

async function listFilesRecursive(root: string, extension: string, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(full, extension, depth + 1)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) {
      files.push(full);
    }
  }
  return files;
}

async function readIncidents(crashDir: string): Promise<LocatedIncident[]> {
  const files = await listFilesRecursive(path.join(crashDir, 'incidents'), '.json');
  const incidents: LocatedIncident[] = [];
  for (const file of files) {
    try {
      const parsed = asIncident(JSON.parse(await readFile(file, 'utf8')) as unknown);
      if (parsed !== null) incidents.push({ file, incident: parsed });
    } catch {
      // A partially written incident is ignored; it must never break the diagnostics UI.
    }
  }
  return incidents.sort((a, b) => Date.parse(b.incident.at) - Date.parse(a.incident.at)).slice(0, MAX_REPORTS);
}

async function readDumps(crashDir: string): Promise<DumpFile[]> {
  const files = await listFilesRecursive(crashDir, '.dmp');
  const dumps: DumpFile[] = [];
  for (const file of files) {
    try {
      const info = await stat(file);
      dumps.push({ path: file, name: path.basename(file), sizeBytes: info.size, modifiedAt: info.mtimeMs });
    } catch {
      // A dump can disappear while Crashpad rotates it. Ignore that one.
    }
  }
  return dumps.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/** Correlate dumps by filesystem time; Crashpad filenames are opaque UUIDs. */
function dumpsForIncident(incident: CrashIncident, dumps: DumpFile[]): DumpFile[] {
  const at = Date.parse(incident.at);
  if (!Number.isFinite(at)) return [];
  const window = incident.kind === 'unclean-shutdown' ? 24 * 60 * 60 * 1000 : 10 * 60 * 1000;
  return dumps.filter((dump) => Math.abs(dump.modifiedAt - at) <= window);
}

async function readLogTail(logDir: string): Promise<string> {
  const files = await listFilesRecursive(logDir, '.log');
  if (files.length === 0) return '';
  const withStats = await Promise.all(
    files.map(async (file) => {
      try {
        return { file, info: await stat(file) };
      } catch {
        return { file, info: null };
      }
    }),
  );
  const latest = withStats
    .filter((entry) => entry.info !== null)
    .sort((a, b) => (b.info?.mtimeMs ?? 0) - (a.info?.mtimeMs ?? 0))
    .slice(0, 2);

  const chunks: string[] = [];
  for (const entry of latest) {
    if (entry.info === null) continue;
    try {
      const text = await readFile(entry.file, 'utf8');
      chunks.push(text.length > MAX_TEXT_LOG_BYTES ? text.slice(-MAX_TEXT_LOG_BYTES) : text);
    } catch {
      // A rotated-away log is optional context.
    }
  }
  const lines = chunks.join('\n').split(/\r?\n/);
  return lines.slice(-300).join('\n');
}

function journalSummary(sessions: SessionSummary[]): Record<string, unknown> {
  const interrupted = sessions.filter((session) => session.interrupted);
  return {
    total: sessions.length,
    interrupted: interrupted.length,
    pendingRollback: sessions.reduce((sum, session) => sum + session.pendingRollback, 0),
    recent: sessions.slice(0, 8).map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      presetId: session.presetId,
      status: session.status,
      interrupted: session.interrupted,
      pendingRollback: session.pendingRollback,
    })),
  };
}

function reportMarkdown(
  incident: CrashIncident,
  dumps: DumpFile[],
  logs: string,
  journal: Record<string, unknown>,
  redact: (text: string) => string,
): string {
  const lines = [
    '# TuneSmith diagnostic report',
    '',
    `- Type: ${kindLabel(incident.kind)}`,
    `- Incident: ${incident.kind}`,
    `- Recorded: ${incident.at}`,
    `- App: ${incident.appVersion}`,
    `- Electron: ${incident.electronVersion}`,
    `- Platform: ${incident.platform}/${incident.arch}`,
    incident.reason === undefined ? null : `- Reason: ${incident.reason}`,
    incident.exitCode === undefined ? null : `- Exit code: ${String(incident.exitCode)}`,
    incident.webContentsId === undefined ? null : `- WebContents: ${String(incident.webContentsId)}`,
    '',
    '## What happened',
    '',
    'TuneSmith local crash collector recorded this incident. Native minidumps are opaque',
    'to the app; the correlated journal and log tail below are the human-readable evidence.',
    '',
    `Minidumps in window: ${dumps.length === 0 ? 'none' : dumps.map((dump) => `${dump.name} (${String(dump.sizeBytes)} bytes)`).join(', ')}`,
    '',
    '## Durable journal summary',
    '',
    '```json',
    JSON.stringify(journal, null, 2),
    '```',
    '',
    '## Log tail',
    '',
    '```text',
    logs.length === 0 ? '(no log file found)' : logs,
    '```',
    '',
    '## Details',
    '',
    '```json',
    incident.details ?? '{}',
    '```',
    '',
    'No data was uploaded by TuneSmith. Review this report before attaching it to an issue.',
    '',
  ];
  return redact(lines.filter((line): line is string => line !== null).join('\n'));
}

function defaultIdentity(): RedactionIdentity {
  let username = 'unknown';
  let homeDir = '';
  let hostname = 'unknown';
  try {
    username = os.userInfo().username;
    homeDir = os.homedir();
    hostname = os.hostname();
  } catch {
    // A service account without a profile still gets generic path redaction.
  }
  return { username, homeDir, hostname };
}

export class DiagnosticsService {
  readonly crashDir: string;
  private readonly options: DiagnosticsServiceOptions;
  private readonly identity: RedactionIdentity;

  constructor(options: DiagnosticsServiceOptions) {
    this.options = options;
    this.crashDir = path.resolve(options.crashDir);
    this.identity = options.identity ?? defaultIdentity();
  }

  private redactor(redact: boolean): (text: string) => string {
    return redact ? createRedactor(this.identity) : (text: string) => text;
  }

  /**
   * Materialize redacted, human-readable reports on disk. Called once after the app is
   * ready, so a reboot after a hard crash leaves a report the user can inspect even
   * before opening the diagnostics drawer.
   */
  async materializeReports(): Promise<number> {
    const incidents = await readIncidents(this.crashDir);
    if (incidents.length === 0) return 0;
    const [dumps, logs, sessions] = await Promise.all([
      readDumps(this.crashDir),
      readLogTail(this.options.logDir),
      this.options.getJournal().catch(() => [] as SessionSummary[]),
    ]);
    const reportsDir = path.join(this.crashDir, 'reports');
    await mkdir(reportsDir, { recursive: true });
    const redact = this.redactor(true);
    let written = 0;
    for (const { incident } of incidents) {
      const related = dumpsForIncident(incident, dumps);
      const markdown = reportMarkdown(incident, related, logs, journalSummary(sessions), redact);
      await writeFile(path.join(reportsDir, `${incident.id}.md`), markdown, { encoding: 'utf8', mode: 0o600 });
      written += 1;
    }
    return written;
  }

  async status(): Promise<{
    crashDir: string;
    reportCount: number;
    dumpCount: number;
    totalDumpBytes: number;
    reports: {
      id: string;
      at: string;
      kind: CrashKind;
      title: string;
      summary: string;
      dumpFiles: { name: string; sizeBytes: number }[];
      reportBytes: number;
    }[];
    message: string | null;
  }> {
    const [incidents, dumps] = await Promise.all([readIncidents(this.crashDir), readDumps(this.crashDir)]);
    const reports = incidents.map(({ incident }) => {
      const related = dumpsForIncident(incident, dumps);
      const title = `${kindLabel(incident.kind)} · ${incident.at}`;
      const summary =
        incident.kind === 'unclean-shutdown'
          ? 'The previous run exited without a clean shutdown marker.'
          : `${incident.reason ?? 'unknown reason'}${incident.exitCode === undefined ? '' : ` · exit ${String(incident.exitCode)}`}`;
      return {
        id: incident.id,
        at: incident.at,
        kind: incident.kind,
        title,
        summary,
        dumpFiles: related.map((dump) => ({ name: dump.name, sizeBytes: dump.sizeBytes })),
        reportBytes: title.length + summary.length,
      };
    });
    const dumpBytes = dumps.reduce((sum, dump) => sum + dump.sizeBytes, 0);
    return {
      crashDir: this.crashDir,
      reportCount: reports.length,
      dumpCount: dumps.length,
      totalDumpBytes: dumpBytes,
      reports,
      message: reports.length === 0 ? 'No local crash reports were recorded.' : null,
    };
  }

  async exportBundle(request: DiagnosticsExportRequest, destination: string): Promise<DiagnosticsExportResult> {
    const incidents = await readIncidents(this.crashDir);
    const byId = new Map(incidents.map((entry) => [entry.incident.id, entry]));
    const selected = request.reportIds.length === 0 ? incidents : request.reportIds.map((id) => byId.get(id)).filter((entry): entry is LocatedIncident => entry !== undefined);
    if (selected.length === 0) {
      return { saved: false, path: null, fileCount: 0, bytes: 0, message: 'No matching local crash reports were found.' };
    }

    const [dumps, logs, sessions] = await Promise.all([
      readDumps(this.crashDir),
      readLogTail(this.options.logDir),
      this.options.getJournal().catch(() => [] as SessionSummary[]),
    ]);
    const redact = this.redactor(request.redact);
    const journal = journalSummary(sessions);
    const entries: ZipEntry[] = [];
    const includedDumps = new Set<string>();
    const warnings: string[] = [];

    for (const { incident } of selected) {
      const related = dumpsForIncident(incident, dumps);
      const markdown = reportMarkdown(incident, related, logs, journal, redact);
      entries.push({ name: `reports/${incident.id}.md`, data: Buffer.from(markdown, 'utf8') });
      const incidentJson = JSON.stringify(incident, null, 2);
      entries.push({
        name: `incidents/${incident.id}.json`,
        data: Buffer.from(redact(incidentJson), 'utf8'),
      });
      if (request.includeDumps) {
        for (const dump of related) {
          if (includedDumps.has(dump.path)) continue;
          if (dump.sizeBytes > MAX_ZIP_DUMP_BYTES) {
            warnings.push(`${dump.name} was skipped because it is larger than 64 MB.`);
            continue;
          }
          try {
            entries.push({ name: `dumps/${dump.name}`, data: await readFile(dump.path) });
            includedDumps.add(dump.path);
          } catch {
            warnings.push(`${dump.name} disappeared before it could be exported.`);
          }
        }
      }
    }

    entries.push({
      name: 'logs/tunesmith-tail.log',
      data: Buffer.from(redact(logs.length === 0 ? '(no log file found)' : logs), 'utf8'),
    });
    entries.push({
      name: 'journal-summary.json',
      data: Buffer.from(redact(JSON.stringify(journal, null, 2)), 'utf8'),
    });
    entries.push({
      name: 'README.txt',
      data: Buffer.from(
        [
          'TuneSmith local diagnostics bundle',
          '',
          'This archive was assembled locally by TuneSmith. No data was uploaded.',
          'Review every file before attaching it to a public issue. Minidumps contain',
          'process memory and cannot be redacted; they are included only when explicitly selected.',
          '',
          ...(warnings.length === 0 ? [] : ['Export warnings:', ...warnings.map((warning) => `- ${warning}`)]),
        ].join('\n'),
        'utf8',
      ),
    });

    const zip = createZip(entries);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, zip, { mode: 0o600 });
    return {
      saved: true,
      path: destination,
      fileCount: entries.length,
      bytes: zip.length,
      message:
        warnings.length === 0
          ? 'Diagnostics bundle exported locally.'
          : `Diagnostics bundle exported with ${String(warnings.length)} warning(s).`,
    };
  }
}

/** Test-only helper for deterministic temporary bundles. */
export function diagnosticBundleName(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `TuneSmith-diagnostics-${stamp}-${randomUUID().slice(0, 6)}.zip`;
}

export { readIncidents, readDumps, dumpsForIncident, readLogTail, reportMarkdown };
