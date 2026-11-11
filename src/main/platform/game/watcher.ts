/**
 * Game watcher: a lightweight `tasklist` poll for process presence, plus a one-time
 * event-driven foreground observer.
 *
 * The previous design kept a PowerShell/CIM loop alive and woke it every poll interval.
 * That cost CLR/CPU time even while the user was doing something else. Process presence is
 * now read with the native `tasklist` tool, and foreground changes/geometry are pushed by a
 * small WinEvent observer instead of being polled.
 *
 * The watcher stays deliberately dumb: it receives image names (already constrained by
 * `PROCESS_NAME_RE`) and reports pids plus the foreground identity. All matching, policy and
 * decisions live in the controller. A foreground-observer failure is restarted with backoff;
 * a failed process scan retries with its own backoff. Either one reports unhealthy rather
 * than silently watching nothing.
 */
import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RunningProcess } from '../../../shared/game/matcher';
import { PREAMBLE } from '../powershell';
import { FOREGROUND_SCRIPT } from './scripts';

export interface GameWindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GameSnapshot {
  foreground: RunningProcess | null;
  running: RunningProcess[];
  /** Physical-pixel rectangle of the foreground window when it is visible. */
  window?: GameWindowBounds | null;
}

export interface ForegroundSnapshot {
  foreground: RunningProcess | null;
  window: GameWindowBounds | null;
}

export interface WatcherOptions {
  watchNames: readonly string[];
  pollMs: number;
  onSnapshot: (snapshot: GameSnapshot) => void;
  onStatus: (healthy: boolean, error: string | null) => void;
  log?: (line: string) => void;
}

const MAX_LINE_BYTES = 64 * 1024;
const RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];
const TASKLIST_TIMEOUT_MS = 5_000;
const TASKLIST_MAX_BUFFER = 8 * 1024 * 1024;
const TASKLIST_RETRY_BASE_MS = 1_000;
const TASKLIST_RETRY_MAX_MS = 10_000;

export function clampPollMs(value: number): number {
  if (!Number.isFinite(value)) return 2_000;
  return Math.min(10_000, Math.max(750, Math.round(value)));
}

/** Build the foreground observer command. Exported for tests: the body is static. */
export function buildForegroundScript(): string {
  return `${PREAMBLE}\n${FOREGROUND_SCRIPT}`;
}

function aspect(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function toWindow(value: unknown): GameWindowBounds | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = value as Record<string, unknown>;
  const left = aspect(item.left);
  const top = aspect(item.top);
  const width = aspect(item.width);
  const height = aspect(item.height);
  if (!Number.isInteger(left) || !Number.isInteger(top)) return null;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (Math.abs(left) > 100_000 || Math.abs(top) > 100_000) return null;
  if (width <= 0 || height <= 0 || width > 32_768 || height > 32_768) return null;
  return { left, top, width, height };
}

function toProcess(value: unknown): RunningProcess | null {
  if (typeof value !== 'object' || value === null) return null;
  const item = value as Record<string, unknown>;
  const pid = typeof item.pid === 'number' ? item.pid : Number(item.pid);
  const exe = typeof item.exe === 'string' ? item.exe : '';
  if (!Number.isInteger(pid) || pid <= 0 || exe.length === 0) return null;

  const packageFamilyName =
    typeof item.packageFamilyName === 'string' && item.packageFamilyName.length > 0
      ? item.packageFamilyName
      : null;

  return {
    pid,
    exe,
    path: typeof item.path === 'string' && item.path.length > 0 ? item.path : null,
    title: typeof item.title === 'string' ? item.title : null,
    ...(packageFamilyName === null ? {} : { packageFamilyName }),
  };
}

/** Exported for tests: geometry is untrusted observer output until it is checked here. */
export function parseForegroundLine(line: string): ForegroundSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;

  const record = raw as { foreground?: unknown; window?: unknown };
  if (record.foreground === null || record.foreground === undefined) {
    return { foreground: null, window: null };
  }

  const foreground = toProcess(record.foreground);
  if (foreground === null) return null;
  return { foreground, window: toWindow(record.window) };
}

/** Parse one `tasklist /FO CSV /NH` line. Exported for tests. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? '';
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        value += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      fields.push(value);
      value = '';
    } else {
      value += character;
    }
  }

  fields.push(value);
  return fields;
}

/** Filter a `tasklist /FO CSV /NH` dump down to the watched image names. */
export function parseTasklist(stdout: string, watchNames: readonly string[]): RunningProcess[] {
  const wanted = new Set(watchNames.map((name) => name.toLowerCase()));
  const seen = new Set<number>();
  const running: RunningProcess[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const fields = parseCsvLine(line);
    const exe = fields[0]?.trim().toLowerCase() ?? '';
    const pidText = fields[1]?.trim() ?? '';
    if (exe.length === 0 || !/^\d+$/.test(pidText) || !wanted.has(exe)) continue;

    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    running.push({ pid, exe });
  }

  return running.sort((a, b) => a.pid - b.pid);
}

function sameForeground(a: ForegroundSnapshot | null, b: ForegroundSnapshot): boolean {
  if (a === null) return false;
  const left = a.foreground;
  const right = b.foreground;
  if (left === null || right === null) return left === right;
  return (
    left.pid === right.pid &&
    left.exe === right.exe &&
    (left.path ?? null) === (right.path ?? null) &&
    (left.packageFamilyName ?? null) === (right.packageFamilyName ?? null)
  );
}

export class GameWatcher {
  private foregroundChild: ChildProcessWithoutNullStreams | null = null;
  private pollChild: ChildProcess | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private attempts = 0;
  private foregroundBuffer = '';
  private foreground: ForegroundSnapshot | null = null;
  private running: RunningProcess[] = [];
  private foregroundHealthy = false;
  private tasklistHealthy = false;
  private polling = false;
  private pollAgain = false;
  private tasklistFailures = 0;
  private nextPollAt = 0;
  private lastStatus: { healthy: boolean; error: string | null } | null = null;

  constructor(private readonly options: WatcherOptions) {}

  start(): void {
    if (!this.stopping && this.pollTimer !== null) return;
    this.stopping = false;
    this.attempts = 0;
    this.foreground = null;
    this.running = [];
    this.foregroundHealthy = false;
    this.tasklistHealthy = false;
    this.tasklistFailures = 0;
    this.nextPollAt = 0;
    this.lastStatus = null;

    this.spawnForeground();
    this.pollTimer = setInterval(() => this.poll(), clampPollMs(this.options.pollMs));
    this.poll();
  }

  stop(): void {
    this.stopping = true;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.pollChild?.kill();
    this.pollChild = null;
    this.foregroundChild?.kill();
    this.foregroundChild = null;
    this.polling = false;
    this.pollAgain = false;
    this.foregroundBuffer = '';
    this.foreground = null;
    this.running = [];
    this.foregroundHealthy = false;
    this.tasklistHealthy = false;
  }

  private spawnForeground(): void {
    const encoded = Buffer.from(buildForegroundScript(), 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: 'pipe' },
    );

    this.foregroundChild = child;
    this.foregroundBuffer = '';
    this.foregroundHealthy = false;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consumeForeground(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text.length > 0) this.options.log?.(`[watcher] ${text.slice(0, 400)}`);
    });

    child.on('error', (error) => {
      if (this.stopping || this.foregroundChild !== child) return;
      this.foregroundChild = null;
      this.foregroundHealthy = false;
      this.foreground = null;
      this.setStatus(false, `Foreground watcher failed to start: ${error.message}`);
      this.scheduleRestart();
    });

    child.on('exit', (code) => {
      // A replacement can already be running when the old child finally exits.
      if (this.stopping || this.foregroundChild !== child) return;
      this.foregroundChild = null;
      this.foregroundHealthy = false;
      this.foreground = null;
      this.setStatus(false, `Foreground watcher exited (code ${code ?? 'unknown'}).`);
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.stopping || this.restartTimer !== null) return;
    const delay = RESTART_DELAYS_MS[Math.min(this.attempts, RESTART_DELAYS_MS.length - 1)] ?? 10_000;
    this.attempts += 1;

    if (this.attempts > RESTART_DELAYS_MS.length) {
      this.setStatus(false, 'Game watcher stopped after repeated failures. Toggle game mode off and on again.');
      return;
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.spawnForeground();
    }, delay);
  }

  private consumeForeground(chunk: string): void {
    this.foregroundBuffer += chunk;

    if (this.foregroundBuffer.length > MAX_LINE_BYTES) {
      this.foregroundBuffer = '';
      this.setStatus(false, 'Foreground watcher produced an oversized line; restarting it.');
      this.foregroundChild?.kill();
      return;
    }

    let newline = this.foregroundBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.foregroundBuffer.slice(0, newline).replace(/\r$/, '').trim();
      this.foregroundBuffer = this.foregroundBuffer.slice(newline + 1);
      if (line.length > 0) {
        const parsed = parseForegroundLine(line);
        if (parsed !== null) {
          const changed = !sameForeground(this.foreground, parsed);
          this.foreground = parsed;
          if (!this.foregroundHealthy) {
            this.foregroundHealthy = true;
            this.attempts = 0;
            this.setStatus(true, null);
          }
          // A new foreground process needs a fresh process list before the controller
          // decides whether to activate. A geometry-only change can reuse the last one.
          if (changed) this.poll();
          else this.emitSnapshot();
        }
      }
      newline = this.foregroundBuffer.indexOf('\n');
    }
  }

  private poll(): void {
    if (this.stopping) return;
    if (Date.now() < this.nextPollAt) return;
    if (this.polling) {
      this.pollAgain = true;
      return;
    }

    this.polling = true;
    const child = execFile(
      'tasklist.exe',
      ['/FO', 'CSV', '/NH'],
      {
        timeout: TASKLIST_TIMEOUT_MS,
        maxBuffer: TASKLIST_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
        shell: false,
      },
      (error, stdout) => {
        if (this.pollChild === child) this.pollChild = null;
        this.polling = false;
        if (this.stopping) return;

        if (error !== null) {
          this.tasklistFailures += 1;
          const delay = Math.min(
            TASKLIST_RETRY_MAX_MS,
            TASKLIST_RETRY_BASE_MS * 2 ** Math.min(this.tasklistFailures - 1, 4),
          );
          this.nextPollAt = Date.now() + delay;
          this.tasklistHealthy = false;
          this.setStatus(false, `Process scan failed: ${error.message}`);
          return;
        }

        this.running = parseTasklist(stdout ?? '', this.options.watchNames);
        this.tasklistFailures = 0;
        this.nextPollAt = 0;
        this.tasklistHealthy = true;
        this.setStatus(true, null);
        this.emitSnapshot();

        if (this.pollAgain) {
          this.pollAgain = false;
          this.poll();
        }
      },
    );
    this.pollChild = child;
  }

  private emitSnapshot(): void {
    if (this.stopping || this.foreground === null) return;
    this.options.onSnapshot({
      foreground: this.foreground.foreground,
      running: this.running,
      window: this.foreground.window,
    });
  }

  private setStatus(healthy: boolean, error: string | null): void {
    const nextHealthy = healthy && this.foregroundHealthy && this.tasklistHealthy;
    // A successful process scan must not erase the reason the foreground observer is down.
    const nextError = nextHealthy ? null : (error ?? this.lastStatus?.error ?? null);
    if (this.lastStatus?.healthy === nextHealthy && this.lastStatus.error === nextError) return;
    this.lastStatus = { healthy: nextHealthy, error: nextError };
    this.options.onStatus(nextHealthy, nextError);
  }
}
