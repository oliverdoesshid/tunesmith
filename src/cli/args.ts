/**
 * Argument parsing for the headless CLI.
 *
 * Pure and dependency-free so it can be unit-tested without spawning a process. The
 * parser never resolves paths or touches the filesystem: it only decides *what* the
 * user asked for, and collects every problem instead of throwing on the first one.
 */

export const CLI_COMMANDS = ['apply', 'rollback', 'restore', 'sessions', 'presets', 'help', 'version'] as const;
export type CliCommand = (typeof CLI_COMMANDS)[number];

/** Same shape the preset schema enforces, so an id can never be a path. */
const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export interface ParsedArgs {
  command: CliCommand;
  presetId: string | null;
  sessionId: string | null;
  /** Compile and print; mutate nothing. */
  dryRun: boolean;
  /** Acknowledge consent-requiring (restricted / unlisted) changes. */
  yes: boolean;
  /** Acknowledge the blast radius of an `aggressive` preset. */
  risk: boolean;
  json: boolean;
  /** Override the shared session directory (must be absolute). */
  userData: string | null;
  /** Collected usage errors; a non-empty list means "do not run anything". */
  errors: string[];
}

function empty(): ParsedArgs {
  return {
    command: 'help',
    presetId: null,
    sessionId: null,
    dryRun: false,
    yes: false,
    risk: false,
    json: false,
    userData: null,
    errors: [],
  };
}

function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/');
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const result = empty();
  const positional: string[] = [];

  const takeValue = (name: string, inline: string | undefined, index: number): string | null => {
    if (inline !== undefined) {
      if (inline.length === 0) result.errors.push(`${name} needs a value.`);
      return inline.length === 0 ? null : inline;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('-')) {
      result.errors.push(`${name} needs a value.`);
      return null;
    }
    return next;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (arg === '--help' || arg === '-h') {
      result.command = 'help';
      positionHandled(result, positional);
      return result;
    }
    if (arg === '--version' || arg === '-v') {
      result.command = 'version';
      return result;
    }
    if (arg === '--dry-run') {
      result.dryRun = true;
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      result.yes = true;
      continue;
    }
    if (arg === '--risk') {
      result.risk = true;
      continue;
    }
    if (arg === '--json') {
      result.json = true;
      continue;
    }

    if (arg === '--preset' || arg.startsWith('--preset=')) {
      const value = takeValue('--preset', arg.startsWith('--preset=') ? arg.slice('--preset='.length) : undefined, index);
      if (arg === '--preset') index += 1;
      if (value !== null) {
        if (PRESET_ID_RE.test(value)) result.presetId = value;
        else result.errors.push(`"${value}" is not a valid preset id (lowercase kebab-case).`);
      }
      continue;
    }

    if (arg === '--session' || arg.startsWith('--session=')) {
      const value = takeValue('--session', arg.startsWith('--session=') ? arg.slice('--session='.length) : undefined, index);
      if (arg === '--session') index += 1;
      if (value !== null) {
        if (SESSION_ID_RE.test(value)) result.sessionId = value;
        else result.errors.push(`"${value}" is not a valid session id.`);
      }
      continue;
    }

    if (arg === '--user-data' || arg.startsWith('--user-data=')) {
      const value = takeValue('--user-data', arg.startsWith('--user-data=') ? arg.slice('--user-data='.length) : undefined, index);
      if (arg === '--user-data') index += 1;
      if (value !== null) {
        if (isAbsolutePath(value)) result.userData = value;
        else result.errors.push('--user-data needs an absolute path.');
      }
      continue;
    }

    if (arg.startsWith('-')) {
      result.errors.push(`Unknown option "${arg}".`);
      continue;
    }

    positional.push(arg);
  }

  positionHandled(result, positional);
  return result;
}

function positionHandled(result: ParsedArgs, positional: string[]): void {
  const first = positional[0];
  if (first === undefined) {
    // `--help` already set the command; a bare invocation defaults to help.
    return;
  }
  if (!(CLI_COMMANDS as readonly string[]).includes(first)) {
    result.errors.push(`Unknown command "${first}".`);
    return;
  }
  if (positional.length > 1) {
    result.errors.push(`Unexpected argument "${positional[1] ?? ''}".`);
  }
  result.command = first as CliCommand;
}

export function usage(version: string): string {
  return `TuneSmith CLI ${version}

Usage:
  tunesmith-cli presets [--json]
  tunesmith-cli apply --preset <id> [--dry-run] [--yes] [--risk] [--json]
  tunesmith-cli sessions [--json]
  tunesmith-cli rollback --session <id> [--json]
  tunesmith-cli restore [--json]
  tunesmith-cli --version

Options:
  --preset <id>       Preset to apply (list them with "presets")
  --session <id>      Session to roll back (list them with "sessions")
  --dry-run           Compile and print the plan; change nothing
  --yes               Acknowledge sensitive (consent-requiring) changes
  --risk              Acknowledge the risk of an aggressive preset
  --json              Machine-readable output on stdout
  --user-data <dir>   Absolute path to the shared session directory

Exit codes:
  0  success
  1  the operation failed (and was rolled back when possible)
  2  usage error
  3  administrator rights are required
  4  refused by policy or by a missing acknowledgement

The CLI shares the preset loader, compiler and rollback journal with the desktop
app. A session started here can be undone from the GUI, and vice versa.`;
}
