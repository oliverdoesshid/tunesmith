/**
 * Performance OSD types.
 *
 * The overlay is a separate, display-only window. It never receives a filesystem
 * handle, a shell command, or a path to execute: just the active profile summary and
 * read-only counters.
 */

/** One rolling frame-rate sample from the ETW present monitor. */
export interface FrameSample {
  /** Frames per second over the most recent second. Null when no presents arrived. */
  fps: number | null;
  /** FPS implied by the average of the slowest 1% of frame times in the last 10 s. */
  low1Fps: number | null;
  /** Average frame time in milliseconds for the most recent second. */
  frameTimeMs: number | null;
  /** Number of present intervals used for `fps`. */
  frames: number;
  at: string;
}

export type FrameSource = 'etw' | 'unavailable';

/** Everything the overlay window draws. It is sent only while the OSD is visible. */
export interface OsdState {
  profileName: string;
  exe: string;
  pid: number;
  startedAt: string;
  elapsedMs: number;
  fps: number | null;
  low1Fps: number | null;
  frameTimeMs: number | null;
  cpuTempC: number | null;
  gpuTempC: number | null;
  powerDrawW: number | null;
  applied: number;
  skipped: number;
  frameSource: FrameSource;
  frameMessage: string | null;
  telemetryMessage: string | null;
  updatedAt: string;
}

/** Renderer-facing OSD availability. No privileged operation is exposed. */
export interface OsdStatus {
  enabled: boolean;
  visible: boolean;
  /** Human-readable reason when the overlay is enabled but not currently visible. */
  message: string | null;
}

/** The only bridge the overlay preload exposes. */
export interface TuneSmithOsdApi {
  onState(listener: (state: OsdState) => void): () => void;
}
