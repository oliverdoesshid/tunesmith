import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostApplyWatchdog, POST_APPLY_LIMITS } from '../src/main/engine/post-apply';
import type { PostApplyProbeSample } from '../src/shared/post-apply';
import type { RollbackReport } from '../src/shared/session';

const START = new Date('2026-01-01T00:00:00.000Z').getTime();

function sample(overrides: Partial<PostApplyProbeSample> = {}): PostApplyProbeSample {
  return {
    at: new Date(Date.now()).toISOString(),
    cpuTempC: 60,
    gpuTempC: 60,
    cpuTempSource: 'libre-hardware-monitor',
    gpuTempSource: 'nvidia-smi',
    dpcPercent: 1,
    dpcSource: 'cim-perf-counter',
    ...overrides,
  };
}

const OK_REPORT: RollbackReport = {
  sessionId: 'session-1',
  restored: 3,
  failed: 0,
  errors: [],
  ok: true,
  message: 'Restored 3 changes.',
};

function makeWatchdog(
  probe: () => Promise<PostApplyProbeSample>,
  rollback: (sessionId: string) => Promise<RollbackReport> = async () => OK_REPORT,
) {
  return new PostApplyWatchdog({ probe, rollback, now: () => Date.now() });
}

function start(watchdog: PostApplyWatchdog) {
  return watchdog.start({ sessionId: 'session-1', presetId: 'aggressive', presetName: 'Aggressive' });
}

describe('post-apply stability watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rolls back immediately when CPU temperature exceeds 90 °C', async () => {
    const rollback = vi.fn(async () => OK_REPORT);
    const watchdog = makeWatchdog(async () => sample({ cpuTempC: 91 }), rollback);

    start(watchdog);
    await vi.advanceTimersByTimeAsync(1);

    expect(rollback).toHaveBeenCalledWith('session-1');
    const status = watchdog.status();
    expect(status.phase).toBe('rolled-back');
    expect(status.trip?.kind).toBe('cpu-temp');
    expect(status.rollback?.restored).toBe(3);
    expect(status.active).toBe(false);
  });

  it('rolls back when GPU temperature exceeds 90 °C', async () => {
    const rollback = vi.fn(async () => OK_REPORT);
    const watchdog = makeWatchdog(async () => sample({ gpuTempC: 95 }), rollback);

    start(watchdog);
    await vi.advanceTimersByTimeAsync(1);

    expect(rollback).toHaveBeenCalledOnce();
    expect(watchdog.status().trip?.kind).toBe('gpu-temp');
  });

  it('requires two sustained DPC samples before tripping', async () => {
    const rollback = vi.fn(async () => OK_REPORT);
    const probe = vi.fn(async () => sample({ dpcPercent: 12 }));
    const watchdog = makeWatchdog(probe, rollback);

    start(watchdog);
    await vi.advanceTimersByTimeAsync(1);
    expect(rollback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(POST_APPLY_LIMITS.sampleMs);
    expect(rollback).toHaveBeenCalledWith('session-1');
    expect(watchdog.status().trip?.kind).toBe('dpc');
  });

  it('detects a freeze-sized event-loop stall and rolls back', async () => {
    const rollback = vi.fn(async () => OK_REPORT);
    const watchdog = makeWatchdog(async () => sample(), rollback);

    start(watchdog);
    await vi.advanceTimersByTimeAsync(1);

    vi.setSystemTime(START + POST_APPLY_LIMITS.freezeStallMs + 5_000);
    await vi.advanceTimersByTimeAsync(POST_APPLY_LIMITS.sampleMs);

    expect(rollback).toHaveBeenCalledOnce();
    expect(watchdog.status().trip?.kind).toBe('freeze');
  });

  it('finishes stable after five minutes without rolling back', async () => {
    const rollback = vi.fn(async () => OK_REPORT);
    const watchdog = makeWatchdog(async () => sample(), rollback);

    start(watchdog);
    for (let elapsed = 0; elapsed <= POST_APPLY_LIMITS.monitorMs; elapsed += POST_APPLY_LIMITS.sampleMs) {
      await vi.advanceTimersByTimeAsync(POST_APPLY_LIMITS.sampleMs);
    }

    expect(rollback).not.toHaveBeenCalled();
    expect(watchdog.status().phase).toBe('stable');
    expect(watchdog.status().sampleCount).toBeGreaterThan(1);
  });

  it('cancels without rolling back on a manual restore', () => {
    const rollback = vi.fn(async () => OK_REPORT);
    const watchdog = makeWatchdog(async () => sample(), rollback);

    start(watchdog);
    watchdog.cancel('Manual restore');
    expect(watchdog.status().phase).toBe('cancelled');
    expect(watchdog.status().active).toBe(false);
    expect(rollback).not.toHaveBeenCalled();
  });

  it('reports missing sensors rather than declaring the machine safe', async () => {
    const watchdog = makeWatchdog(async () =>
      sample({
        cpuTempC: null,
        gpuTempC: null,
        cpuTempSource: 'none',
        gpuTempSource: 'none',
        dpcPercent: null,
        dpcSource: 'unavailable',
      }),
    );

    start(watchdog);
    await vi.advanceTimersByTimeAsync(1);

    expect(watchdog.status().message).toContain('no sensor verdict is possible');
  });
});
