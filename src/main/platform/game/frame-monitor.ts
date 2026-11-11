/**
 * Child-process wrapper around the ETW present sampler.
 *
 * The sampler is optional: if ETW is unavailable the overlay keeps showing the active
 * profile and hardware temperatures, and the FPS fields say why they are empty. A
 * malformed line is ignored rather than allowed to desynchronise the OSD.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { FrameSample } from '../../../shared/game/osd';
import { buildFrameMonitorScript } from './frame-script';

export type FrameMonitorState = 'starting' | 'running' | 'unavailable';

export interface FrameMonitorStatus {
  state: FrameMonitorState;
  message: string | null;
}

export interface FrameMonitorOptions {
  pid: number;
  intervalMs?: number;
  onSample: (sample: FrameSample) => void;
  onStatus: (status: FrameMonitorStatus) => void;
  log?: (line: string) => void;
}

export interface FrameMonitorHandle {
  readonly pid: number;
  stop(): void;
}

const MAX_LINE_BYTES = 32 * 1024;

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Exported for tests: validates every number and never trusts the helper's JSON. */
export function parseFrameMonitorLine(line: string): FrameSample | FrameMonitorStatus | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;

  if (record.type === 'status') {
    const state = record.state;
    if (state !== 'starting' && state !== 'running' && state !== 'unavailable') return null;
    return {
      state,
      message: typeof record.message === 'string' && record.message.length > 0 ? record.message.slice(0, 240) : null,
    };
  }

  if (record.type !== 'sample') return null;
  const fps = finite(record.fps);
  const low1Fps = finite(record.low1Fps);
  const frameTimeMs = finite(record.frameTimeMs);
  const frames = finite(record.frames);
  if (fps !== null && (fps <= 0 || fps > 100_000)) return null;
  if (low1Fps !== null && (low1Fps <= 0 || low1Fps > 100_000)) return null;
  if (frameTimeMs !== null && (frameTimeMs <= 0 || frameTimeMs > 10_000)) return null;

  return {
    fps,
    low1Fps,
    frameTimeMs,
    frames: frames === null ? 0 : Math.max(0, Math.min(100_000, Math.round(frames))),
    at: typeof record.at === 'string' && record.at.length > 0 ? record.at : new Date().toISOString(),
  };
}

export function startFrameMonitor(options: FrameMonitorOptions): FrameMonitorHandle {
  const script = buildFrameMonitorScript(options.pid, options.intervalMs ?? 1_000);
  let stopping = false;
  let buffer = '';
  let announcedUnavailable = false;

  // A huge C# body cannot travel through the Windows command line (32767 chars).
  // `-Command -` reads the static script from stdin, so there is no temp file and no
  // argv-length limit. Only `pid` and interval integers were substituted into it.
  const child: ChildProcessWithoutNullStreams = spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    { windowsHide: true, stdio: 'pipe' },
  );
  // If PowerShell exits before consuming the script, the broken pipe must not become an
  // unhandled EventEmitter error; the exit handler below reports the real failure.
  child.stdin.on('error', () => {});
  child.stdin.end(script, 'utf8');

  const unavailable = (message: string): void => {
    if (announcedUnavailable) return;
    announcedUnavailable = true;
    options.onStatus({ state: 'unavailable', message });
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES) {
      buffer = '';
      unavailable('The frame monitor produced an oversized response.');
      child.kill();
      return;
    }

    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '').trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        const parsed = parseFrameMonitorLine(line);
        if (parsed !== null) {
          // The union is discriminated by shape: a sample has numeric counters, while a
          // status has a `state` string. A malformed object is ignored above.
          if ('state' in parsed) {
            options.onStatus(parsed);
            if (parsed.state === 'unavailable' && parsed.message !== null) {
              announcedUnavailable = true;
              options.log?.(`[osd] ${parsed.message}`);
            }
          } else {
            options.onSample(parsed);
          }
        }
      }
      newline = buffer.indexOf('\n');
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    const text = chunk.trim();
    if (text.length > 0) options.log?.(`[osd] ${text.slice(0, 400)}`);
  });

  child.on('error', (error) => {
    unavailable(`The frame monitor could not start: ${error.message}`);
  });

  child.on('exit', (code) => {
    if (stopping) return;
    unavailable(`The frame monitor exited (code ${code ?? 'unknown'}).`);
  });

  return {
    pid: options.pid,
    stop(): void {
      stopping = true;
      child.kill();
    },
  };
}
