/**
 * PowerShell invocation, restricted to two narrowly-scoped operations that have no
 * `reg.exe`/`sc.exe` equivalent: process priority and System Restore checkpoints.
 *
 * Script text always comes from this codebase. Preset values reach it only through
 * `psQuote`, and only for values that were already constrained by the schema regexes.
 * The script is passed as base64 (`-EncodedCommand`), so no Windows argv quoting rules
 * apply to the body at all.
 */
import { TuneSmithError } from '../../shared/errors';
import { oneLine, runExe } from './exec';

const POWERSHELL = 'powershell.exe';

/** Without this, non-ASCII GPU or preset names come back mangled through the pipeline. */
export const PREAMBLE = [
  "$ErrorActionPreference = 'Stop';",
  "$ProgressPreference = 'SilentlyContinue';",
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);',
  '$OutputEncoding = [Console]::OutputEncoding;',
].join(' ');

export function psQuote(value: string): string {
  if (/[\u0000-\u001f]/.test(value)) {
    throw new TuneSmithError('invalid-request', 'PowerShell parameter contains control characters');
  }
  return `'${value.replace(/'/g, "''")}'`;
}

export interface PowerShellOptions {
  timeoutMs?: number;
}

/** Run a script whose last statement produces JSON, and parse the result. */
export async function runPowerShellJson<T>(body: string, options: PowerShellOptions = {}): Promise<T> {
  const script = `${PREAMBLE}\n${body}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  const result = await runExe(
    POWERSHELL,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeoutMs: options.timeoutMs ?? 30_000 },
  );

  if (result.code !== 0) {
    throw new TuneSmithError('powershell-failed', 'PowerShell script failed', oneLine(result.stderr) || `exit ${result.code}`);
  }

  const text = result.stdout.replace(/^\uFEFF/, '').trim();
  if (text.length === 0) {
    throw new TuneSmithError('parse-failed', 'PowerShell returned no output');
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new TuneSmithError('parse-failed', 'PowerShell returned malformed JSON', oneLine(text));
  }
}

/** `ConvertTo-Json` emits an object rather than an array for a single element. */
export function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
