/**
 * Persistent logging for the main process.
 *
 * This module deliberately has no Electron import: the CLI bundles parts of the main
 * process, and importing Electron there would turn a headless command into a crash. The
 * Electron entry point initialises the file sink and supplies its metadata; until then
 * `logger` is a no-op. Existing `console.*` calls are mirrored into the file once the sink
 * is active, so older subsystems get persistent diagnostics without being rewritten.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggingOptions {
  directory: string;
  /** Include app version, Electron version, launch arguments, etc. */
  meta?: Record<string, unknown>;
  maxFileBytes?: number;
  maxFiles?: number;
}

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

const MAX_LINE_CHARS = 16_000;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

let initialized = false;
let logDirectory: string | null = null;
let logFile: string | null = null;
let writeFailureReported = false;
let hooksInstalled = false;

function inspectValue(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  if (typeof value === 'undefined') return 'undefined';
  try {
    return inspect(value, {
      depth: 5,
      breakLength: Infinity,
      compact: true,
      maxArrayLength: 40,
      maxStringLength: 6000,
      colors: false,
    });
  } catch {
    return String(value);
  }
}

function formatArgs(args: readonly unknown[]): string {
  return args.map((arg) => inspectValue(arg)).join(' ');
}

function appendLine(level: LogLevel, scope: string, message: string, details?: unknown, mirror = false): void {
  if (logFile === null) return;

  const detailsText = details === undefined ? '' : ` ${inspectValue(details)}`;
  const raw = `${new Date().toISOString()} ${LEVEL_LABEL[level]} [pid ${String(process.pid)}] [${scope}] ${message}${detailsText}`;
  const line = `${raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}…[truncated]` : raw}\n`;

  try {
    appendFileSync(logFile, line, 'utf8');
  } catch (error) {
    if (!writeFailureReported) {
      writeFailureReported = true;
      originalConsole.error('[logging] could not write log file', error);
    }
  }

  if (mirror) {
    if (level === 'error') originalConsole.error(line.trimEnd());
    else if (level === 'warn') originalConsole.warn(line.trimEnd());
    else if (level === 'debug') originalConsole.debug(line.trimEnd());
    else originalConsole.info(line.trimEnd());
  }
}

export const logger = {
  debug(scope: string, message: string, details?: unknown): void {
    appendLine('debug', scope, message, details, true);
  },
  info(scope: string, message: string, details?: unknown): void {
    appendLine('info', scope, message, details, true);
  },
  warn(scope: string, message: string, details?: unknown): void {
    appendLine('warn', scope, message, details, true);
  },
  error(scope: string, message: string, details?: unknown): void {
    appendLine('error', scope, message, details, true);
  },
};

function rotateLogs(directory: string, file: string, maxFileBytes: number, maxFiles: number): void {
  try {
    if (statSync(file).size < maxFileBytes) return;
  } catch {
    return;
  }

  for (let index = maxFiles; index >= 1; index -= 1) {
    const destination = path.join(directory, `tunesmith.${String(index)}.log`);
    const source = index === 1 ? file : path.join(directory, `tunesmith.${String(index - 1)}.log`);
    try {
      if (existsSync(destination)) unlinkSync(destination);
      if (existsSync(source)) renameSync(source, destination);
    } catch (error) {
      originalConsole.error('[logging] log rotation failed', error);
    }
  }
}

function installConsoleCapture(): void {
  console.log = (...args: unknown[]): void => {
    appendLine('info', 'console', formatArgs(args));
    originalConsole.log(...args);
  };
  console.info = (...args: unknown[]): void => {
    appendLine('info', 'console', formatArgs(args));
    originalConsole.info(...args);
  };
  console.warn = (...args: unknown[]): void => {
    appendLine('warn', 'console', formatArgs(args));
    originalConsole.warn(...args);
  };
  console.error = (...args: unknown[]): void => {
    appendLine('error', 'console', formatArgs(args));
    originalConsole.error(...args);
  };
  console.debug = (...args: unknown[]): void => {
    appendLine('debug', 'console', formatArgs(args));
    originalConsole.debug(...args);
  };
}

function installProcessHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  // `uncaughtExceptionMonitor` runs before Node's normal uncaught-exception handling, so
  // the crash is logged without replacing the process's existing exit behaviour.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    logger.error('process', `uncaught exception (${origin})`, {
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('process', 'unhandled rejection', {
      reason: reason instanceof Error ? reason.stack ?? reason.message : String(reason),
    });
  });
  process.on('warning', (warning) => {
    const code = (warning as Error & { code?: string }).code ?? null;
    logger.warn('process', `${warning.name}: ${warning.message}`, { code });
  });
  process.on('exit', (code) => {
    logger.info('process', 'process exiting', { code });
  });
}

/** Initialise the rotating file sink and hook the process console into it. */
export function initLogging(options: LoggingOptions): string | null {
  if (initialized) return logDirectory;
  initialized = true;

  try {
    const directory = options.directory;
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'tunesmith.log');
    rotateLogs(
      directory,
      file,
      options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      options.maxFiles ?? DEFAULT_MAX_FILES,
    );

    logDirectory = directory;
    logFile = file;
    installConsoleCapture();
    installProcessHooks();

    logger.info('app', 'persistent logging started', {
      logFile,
      ...options.meta,
    });
    return logDirectory;
  } catch (error) {
    originalConsole.error('[logging] file logging unavailable', error);
    logDirectory = null;
    logFile = null;
    return null;
  }
}

export function getLogDirectory(): string | null {
  return logDirectory;
}

export function getLogFile(): string | null {
  return logFile;
}
