/**
 * Local-only crash diagnostics contract.
 *
 * No field in this module is uploaded anywhere. A report is assembled from files in the
 * app's own userData directory and handed to the renderer only for review/export.
 */

export type CrashKind = 'renderer' | 'child-process' | 'main-process' | 'unclean-shutdown';

export interface DiagnosticsReportSummary {
  id: string;
  at: string;
  kind: CrashKind;
  title: string;
  summary: string;
  dumpFiles: { name: string; sizeBytes: number }[];
  reportBytes: number;
}

export interface DiagnosticsStatus {
  /** Absolute local directory; shown so the user can audit where data lives. */
  crashDir: string;
  reportCount: number;
  dumpCount: number;
  totalDumpBytes: number;
  reports: DiagnosticsReportSummary[];
  message: string | null;
}

export interface DiagnosticsExportRequest {
  reportIds: string[];
  /** Replace the home directory, username and hostname in text artifacts. */
  redact: boolean;
  /** Minidumps are memory images and cannot be redacted. Explicit opt-in only. */
  includeDumps: boolean;
}

export interface DiagnosticsExportResult {
  saved: boolean;
  path: string | null;
  fileCount: number;
  bytes: number;
  message: string;
}
