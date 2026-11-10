/**
 * The single process-spawning primitive used by the whole main process.
 *
 * Rules enforced here, once:
 *   - never a shell (`shell: false`), so nothing is ever string-parsed by cmd.exe
 *   - arguments are always an array, so no quoting or metacharacter handling is needed
 *   - bounded time and output, so a hung system tool cannot wedge the app
 */
import { execFile } from 'node:child_process';
import { TuneSmithError } from '../../shared/errors';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  maxBuffer?: number;
}

export async function runExe(file: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs ?? 15_000,
        maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
          return;
        }

        const err = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };

        // A string `code` means the process never started (ENOENT, EACCES…).
        if (typeof err.code === 'string') {
          reject(new TuneSmithError('spawn-failed', `Could not launch ${file}`, `${err.code}: ${err.message}`));
          return;
        }

        if (err.killed === true) {
          reject(new TuneSmithError('unexpected-exit', `${file} timed out`, (stderr ?? '').trim()));
          return;
        }

        resolve({
          code: typeof err.code === 'number' ? err.code : -1,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        });
      },
    );
  });
}

/** Collapse tool output to one log-safe line. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 400);
}
