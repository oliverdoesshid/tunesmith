import type { FrameSample, FrameSource, OsdState } from '../../shared/game/osd';
import type { GameStatus, TelemetrySample } from '../../shared/game/types';

export interface OsdStateInput {
  status: GameStatus;
  frame: FrameSample | null;
  frameSource: FrameSource;
  frameMessage: string | null;
  telemetry: TelemetrySample | null;
  nowMs?: number;
}

/**
 * Build the display-only DTO. Returns null outside an active session; the window is
 * hidden in that case rather than showing a stale profile from the previous game.
 */
export function buildOsdState(input: OsdStateInput): OsdState | null {
  const active = input.status.phase === 'active' ? input.status.active : null;
  if (active === null) return null;

  const nowMs = input.nowMs ?? Date.now();
  const startedMs = Date.parse(active.startedAt);
  const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0;
  // Deliberately no fallback to `status.telemetry`: that sample may belong to the
  // previous session. The controller passes only a fresh sample here.
  const telemetry = input.telemetry;
  const hasTemperature =
    telemetry !== null &&
    (telemetry.cpuTempC !== null || telemetry.gpuTempC !== null || telemetry.powerDrawW !== null);

  const applied = active.adjustments.filter((adjustment) => adjustment.ok).length;
  const skipped = active.adjustments.length - applied;

  const frameMessage =
    input.frameMessage ??
    (input.frame === null && input.frameSource === 'etw' ? 'Waiting for the first presented frame.' : null);

  return {
    profileName: active.profileName,
    exe: active.exe,
    pid: active.pid ?? 0,
    startedAt: active.startedAt,
    elapsedMs,
    fps: input.frame?.fps ?? null,
    low1Fps: input.frame?.low1Fps ?? null,
    frameTimeMs: input.frame?.frameTimeMs ?? null,
    cpuTempC: telemetry?.cpuTempC ?? null,
    gpuTempC: telemetry?.gpuTempC ?? null,
    powerDrawW: telemetry?.powerDrawW ?? null,
    applied,
    skipped,
    frameSource: input.frameSource,
    frameMessage,
    telemetryMessage: hasTemperature ? null : 'Hardware temperatures unavailable.',
    updatedAt: new Date(nowMs).toISOString(),
  };
}
