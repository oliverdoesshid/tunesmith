import type { ReactNode } from 'react';
import type { PostApplyStatus } from '../../shared/post-apply';

function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

function temp(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(0)}°C`;
}

export function PostApplyBanner({ status }: { status: PostApplyStatus | null }): ReactNode {
  if (status === null || status.phase === 'idle' || status.phase === 'cancelled') return null;

  const danger =
    status.phase === 'rolled-back' ||
    status.phase === 'rollback-failed' ||
    status.phase === 'rolling-back';
  const stable = status.phase === 'stable';

  return (
    <div className={`banner ${danger ? 'banner-danger' : 'banner-warn'}`} role="status">
      <div className="banner-body">
        <strong>
          {stable
            ? 'Stability watchdog complete'
            : danger
              ? 'Stability watchdog triggered a rollback'
              : 'Post-apply stability watchdog'}
        </strong>
        <ul>
          <li>{status.message}</li>
          {status.active && <li className="banner-muted">Time remaining: {clock(status.remainingMs)} · {status.sampleCount} sample(s)</li>}
          {status.sample !== null && (
            <li className="banner-muted">
              CPU {temp(status.sample.cpuTempC)} · GPU {temp(status.sample.gpuTempC)} · DPC{' '}
              {status.sample.dpcPercent === null ? 'unavailable' : `${status.sample.dpcPercent.toFixed(1)}%`}
              {status.sample.cpuTempSource === 'none' && status.sample.gpuTempSource === 'none'
                ? ' · no temperature sensor provider detected'
                : ''}
            </li>
          )}
          {status.trip !== null && status.phase !== 'stable' && <li className="banner-muted">Trip: {status.trip.kind}</li>}
          {status.rollback !== null && <li className="banner-muted">Rollback: {status.rollback.message}</li>}
        </ul>
      </div>
    </div>
  );
}
