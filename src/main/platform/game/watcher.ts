/**
 * Game watcher: one long-lived PowerShell process that reports the foreground process
 * and the running processes we care about.
 *
 * Why persistent: spawning PowerShell per poll costs ~100 ms of CPU every couple of
 * seconds, which is absurd in a performance tool. This loop blocks in `Start-Sleep`.
 *
 * The watcher is deliberately dumb. It receives image names (already constrained by
 * `PROCESS_NAME_RE`) and returns pids; all matching, policy and decisions live in the
 * controller. If the process dies, the wrapper restarts it with backoff and reports
 * unhealthy rather than silently watching nothing.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RunningProcess } from '../../../shared/game/matcher';
import { PREAMBLE, psQuote } from '../powershell';
import { WATCHER_SCRIPT } from './scripts';

export interface GameSnapshot {
  foreground: RunningProcess | null;
  running: RunningProcess[];
}

export interface WatcherOptions {
  watchNames: readonly string[];
  pollMs: number;
  onSnapshot: (snapshot: GameSnapshot) => void;
  onStatus: (healthy: boolean, error: string | null) => void;
  log?: (line: string) => void;
}

const MAX_LINE_BYTES = 256 * 1024;
const RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000];

export function clampPollMs(value: number): number {
  if (!Number.isFinite(value)) return 2_000;
  return Math.min(10_000, Math.max(750, Math.round(value)));
}

/** Build the encoded command. Exported for tests: the quoting is the security boundary. */
export function buildWatcherScript(watchNames: readonly string[], pollMs: number): string {
  const names = watchNames.map((name) => psQuote(name)).join(', ');
  const body = WATCHER_SCRIPT.replace('WATCH_NAMES', names).replace('INTERVAL_MS', String(clampPollMs(pollMs)));
  return `${PREAMBLE}\n${body}`;
}

function parseSnapshot(line: string): GameSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;

  const record = raw as { foreground?: unknown; running?: unknown };

  const toProcess = (value: unknown): RunningProcess | null => {
    if (typeof value !== 'object' || value === null) return null;
    const item = value as Record<string, unknown>;
    const pid = typeof item.pid === 'number' ? item.pid : Number(item.pid);
    const exe = typeof item.exe === 'string' ? item.exe : '';
    if (!Number.isInteger(pid) || pid <= 0 || exe.length === 0) return null;
    return {
      pid,
      exe,
      path: typeof item.path === 'string' && item.path.length > 0 ? item.path : null,
      title: typeof item.title === 'string' ? item.title : null,
    };
  };

  const runningRaw = Array.isArray(record.running) ? record.running : record.running === null ? [] : [record.running];
  const running = runningRaw.map(toProcess).filter((value): value is RunningProcess => value !== null);

  return { foreground: toProcess(record.foreground), running };
}

export class GameWatcher {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopping = false;
  private attempts = 0;
  private buffer = '';
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: WatcherOptions) {}

  start(): void {
    this.stopping = false;
    this.spawnChild();
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.child?.kill();
    this.child = null;
  }

  private spawnChild(): void {
    const script = buildWatcherScript(this.options.watchNames, this.options.pollMs);
    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: 'pipe' },
    );

    this.child = child;
    this.buffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text.length > 0) this.options.log?.(`[watcher] ${text.slice(0, 400)}`);
    });

    child.on('error', (error) => {
      this.options.onStatus(false, `Watcher failed to start: ${error.message}`);
    });

    child.on('exit', (code) => {
      this.child = null;
      if (this.stopping) return;
      this.options.onStatus(false, `Watcher exited (code ${code ?? 'unknown'}).`);
      this.scheduleRestart();
    });

    this.attempts = 0;
    this.options.onStatus(true, null);
  }

  private scheduleRestart(): void {
    if (this.restartTimer !== null) return;
    const delay = RESTART_DELAYS_MS[Math.min(this.attempts, RESTART_DELAYS_MS.length - 1)] ?? 10_000;
    this.attempts += 1;

    if (this.attempts > RESTART_DELAYS_MS.length) {
      this.options.onStatus(false, 'Watcher stopped after repeated failures. Toggle game mode off and on again.');
      return;
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.spawnChild();
    }, delay);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;

    // A single line should never approach this; if it does, the child is emitting garbage.
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = '';
      this.options.onStatus(false, 'Watcher produced an oversized line; restarting it.');
      this.child?.kill();
      return;
    }

    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '').trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) {
        const snapshot = parseSnapshot(line);
        if (snapshot !== null) this.options.onSnapshot(snapshot);
      }
      newline = this.buffer.indexOf('\n');
    }
  }
}
