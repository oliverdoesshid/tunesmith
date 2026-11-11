import type { ReactNode } from 'react';
import type { HealthStatus } from '../../shared/health/types';

interface SystemHealthPanelProps {
  health: HealthStatus | null;
  busy: boolean;
  onCheck: () => void;
  onAcknowledge: () => void;
  onReapply: () => void;
  onFlush: () => void;
}

function checkedLabel(value: string | null): string {
  if (value === null) return 'not checked yet';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown time' : date.toLocaleString();
}

export function SystemHealthPanel({
  health,
  busy,
  onCheck,
  onAcknowledge,
  onReapply,
  onFlush,
}: SystemHealthPanelProps): ReactNode {
  const signals = health?.signals ?? [];
  const pinned = health?.pinnedPreset ?? null;
  const canReapply = pinned !== null && health?.pinnedPresetMissing !== true;
  const stale = health?.journals.stale ?? 0;

  return (
    <section className="panel system-health" aria-live="polite">
      <div className="panel-head">
        <h2>System health</h2>
        <span
          className={`pill ${
            health === null
              ? 'pill-muted'
              : health.watchdog === 'healthy'
                ? 'pill-ok'
                : health.watchdog === 'error'
                  ? 'pill-danger'
                  : 'pill-warn'
          }`}
        >
          {health === null ? 'Loading' : health.watchdog === 'healthy' ? 'Watching' : health.watchdog === 'error' ? 'Degraded' : 'Starting'}
        </span>
      </div>

      <p className="muted small">Passive, read-only OS and system-image checks. It never repairs or rewrites a journal on its own.</p>

      {health === null ? (
        <p className="muted small">Starting the health watchdog…</p>
      ) : (
        <>
          <p className="muted small health-meta">
            Last check {checkedLabel(health.lastCheckAt)} · baseline {checkedLabel(health.baselineCapturedAt)}
            {health.os === null
              ? ''
              : ` · Windows ${health.os.build}${health.os.revision === null ? '' : `.${health.os.revision}`}`}
          </p>

          {health.error !== null && (
            <p className="small badge-aggressive" role="alert">
              Watchdog error: {health.error}
            </p>
          )}

          {health.warnings.length > 0 && (
            <details className="health-warnings">
              <summary className="muted small">{health.warnings.length} probe warning(s)</summary>
              <ul className="muted small">
                {health.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          )}

          {signals.length === 0 ? (
            <p className="small health-ok">No drift detected since the accepted baseline.</p>
          ) : (
            <ul className="health-signals">
              {signals.map((signal) => (
                <li key={signal.id} className="health-signal">
                  <strong>{signal.title}</strong>
                  <span>{signal.detail}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="chip-row health-stats">
            <span className="chip">{health.journals.needingRollback} change(s) still applied</span>
            <span className={`chip ${stale > 0 ? 'chip-warn' : ''}`}>{stale} stale journal(s)</span>
            <span className="chip">cleanup after {health.journals.staleAfterDays} days</span>
          </div>

          <div className="health-pinned">
            {pinned === null ? (
              <span className="muted small">
                {health.pinnedPresetMissing
                  ? 'The pinned preset is no longer installed. Pin another preset below.'
                  : 'Pin a preset below to enable one-click recovery after an update.'}
              </span>
            ) : (
              <span className="small">
                Recovery preset: <strong>{pinned.name}</strong> <span className="muted">v{pinned.version}</span>
              </span>
            )}
          </div>

          <div className="card-actions health-actions">
            <button type="button" className="button button-ghost small" disabled={busy} onClick={onCheck}>
              Check now
            </button>
            {signals.length > 0 && (
              <button type="button" className="button button-ghost small" disabled={busy} onClick={onAcknowledge}>
                Mark reviewed
              </button>
            )}
            <button
              type="button"
              className="button button-primary small"
              disabled={busy || !canReapply}
              onClick={onReapply}
              title="Opens the normal plan review and consent flow; no preset is applied without confirmation."
            >
              Re-apply pinned preset
            </button>
            <button type="button" className="button button-ghost small" disabled={busy || stale === 0} onClick={onFlush}>
              Flush stale journals
            </button>
          </div>
        </>
      )}
    </section>
  );
}
