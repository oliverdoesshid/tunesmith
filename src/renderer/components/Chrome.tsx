import type { ReactNode } from 'react';
import type { RiskLevel } from '../../shared/types';
import type { SessionStatus } from '../../shared/session';
import { FEATURE_DEFINITIONS, type FeatureKey, type FeatureVisibility } from '../lib/features';
import { riskLabel, statusLabel } from '../lib/format';

export function RiskBadge({ risk }: { risk: RiskLevel }): ReactNode {
  return <span className={`badge badge-${risk}`}>{riskLabel(risk)}</span>;
}

export function StatusPill({ status }: { status: SessionStatus }): ReactNode {
  const tone =
    status === 'applied'
      ? 'ok'
      : status === 'failed' || status === 'rollback-failed'
        ? 'danger'
        : status === 'applying'
          ? 'warn'
          : 'muted';
  return <span className={`pill pill-${tone}`}>{statusLabel(status)}</span>;
}

export function Chip({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'accent' }): ReactNode {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

interface HeaderProps {
  signature: string | null;
  isElevated: boolean;
  isMock: boolean;
  busy: boolean;
  features: FeatureVisibility;
  onToggleFeature: (key: FeatureKey) => void;
  onShowAllFeatures: () => void;
  onRefresh: () => void;
}

export function Header({
  signature,
  isElevated,
  isMock,
  busy,
  features,
  onToggleFeature,
  onShowAllFeatures,
  onRefresh,
}: HeaderProps): ReactNode {
  const visible = FEATURE_DEFINITIONS.filter((feature) => features[feature.key]).length;
  const hidden = FEATURE_DEFINITIONS.length - visible;

  return (
    <header className="header">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          <span>TS</span>
          <small>01</small>
        </div>
        <div className="brand-copy">
          <div className="brand-line">
            <h1>TuneSmith</h1>
            <span className="brand-kicker">WIN32 MACHINE CONTROL</span>
          </div>
          <p className="brand-sub" title={signature ?? undefined}>
            <span className="brand-sub-label">SIG</span>
            {signature === null ? <span className="brand-pending">detecting hardware…</span> : <code>{signature}</code>}
          </p>
        </div>
      </div>

      <div className="header-right">
        {isMock && <span className="pill pill-warn">PREVIEW</span>}
        <span className={`header-state ${isElevated ? 'is-ok' : 'is-warn'}`}>
          <span className="header-state-dot" aria-hidden="true" />
          {isElevated ? 'ADMIN SESSION' : 'USER SESSION'}
        </span>
        <button type="button" className="button button-ghost header-refresh" onClick={onRefresh} disabled={busy}>
          {busy ? 'SYNCING…' : 'REFRESH'}
        </button>

        <details className="workspace-menu">
          <summary className="workspace-trigger" aria-label="Choose visible workspace modules">
            <span className="workspace-trigger-glyph" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </span>
            <span>Workspace</span>
            <b>{hidden === 0 ? `${visible} ON` : `${hidden} OFF`}</b>
          </summary>

          <div className="workspace-popover">
            <div className="workspace-head">
              <span>MODULE VISIBILITY</span>
              <code>
                {visible}/{FEATURE_DEFINITIONS.length}
              </code>
            </div>

            <div className="workspace-options">
              {FEATURE_DEFINITIONS.map((feature) => (
                <label key={feature.key} className={`workspace-option ${features[feature.key] ? 'is-on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={features[feature.key]}
                    onChange={() => onToggleFeature(feature.key)}
                  />
                  <span className="workspace-check" aria-hidden="true" />
                  <span className="workspace-code">{feature.code}</span>
                  <span className="workspace-option-copy">
                    <strong>{feature.label}</strong>
                    <small>{feature.description}</small>
                  </span>
                </label>
              ))}
            </div>

            <div className="workspace-foot">
              <span>Saved on this machine</span>
              <button
                type="button"
                className="button button-ghost small"
                onClick={onShowAllFeatures}
                disabled={hidden === 0}
              >
                Show all
              </button>
            </div>
          </div>
        </details>
      </div>
    </header>
  );
}
