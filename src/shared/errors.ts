/** Typed application errors. The `code` is what the UI branches on; messages are for logs. */

export type ErrorCode =
  | 'spawn-failed'
  | 'powershell-failed'
  | 'unexpected-exit'
  | 'not-supported'
  | 'parse-failed'
  | 'not-elevated'
  | 'capture-failed'
  | 'apply-failed'
  | 'rollback-failed'
  | 'locked'
  | 'invalid-request'
  | 'preset-invalid'
  | 'integrity-failed'
  | 'unavailable';

export class TuneSmithError extends Error {
  readonly code: ErrorCode;
  /** Optional operator-facing context. Never contains secrets. */
  readonly detail: string | undefined;

  constructor(code: ErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'TuneSmithError';
    this.code = code;
    this.detail = detail;
  }
}

export function isTuneSmithError(err: unknown): err is TuneSmithError {
  return err instanceof TuneSmithError;
}

/** Human-readable single line for logs and IPC error payloads. */
export function describeError(err: unknown): string {
  if (isTuneSmithError(err)) return err.detail ? `${err.message} (${err.detail})` : err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
