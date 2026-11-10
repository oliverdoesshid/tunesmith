import type { ReactNode } from 'react';
import type { MarketStatus } from '../../shared/market/types';
import { Chip, RiskBadge } from './Chrome';

interface MarketplacePanelProps {
  status: MarketStatus | null;
  busy: boolean;
  onRefresh: () => void;
  onInstall: (presetId: string) => void;
  onConsent: (consent: boolean) => void;
}

function scoreTone(label: 'safe' | 'good' | 'caution' | 'risky'): string {
  if (label === 'safe' || label === 'good') return 'pill-ok';
  if (label === 'caution') return 'pill-muted';
  return 'pill-danger';
}

export function MarketplacePanel({
  status,
  busy,
  onRefresh,
  onInstall,
  onConsent,
}: MarketplacePanelProps): ReactNode {
  const telemetry = status?.telemetry ?? null;

  return (
    <section className="panel presets">
      <div className="panel-head">
        <h2>Marketplace</h2>
        <div className="preset-tools">
          <button type="button" className="button button-ghost small" onClick={onRefresh} disabled={busy || status === null}>
            Refresh catalog
          </button>
        </div>
      </div>

      <p className="muted small">
        Every entry is verified with Ed25519 against a pinned key and matched to its published SHA-256 before it is
        listed. Installing writes only those signed bytes; preview and consent still apply afterwards.
      </p>

      {status === null ? (
        <p className="muted">Loading marketplace…</p>
      ) : !status.configured ? (
        <p className="muted small">
          No marketplace is configured for this build. Set <code>TUNESMITH_MARKET_URL</code> and{' '}
          <code>TUNESMITH_MARKET_KEYS</code>, or ship <code>market/config.json</code> beside the app.
        </p>
      ) : (
        <>
          {status.error !== null && <p className="small badge-aggressive">Catalog error: {status.error}</p>}

          {status.rejected.length > 0 && (
            <p className="muted small">
              {status.rejected.length} entr{status.rejected.length === 1 ? 'y was' : 'ies were'} excluded by
              verification: {status.rejected.slice(0, 2).map((rejected) => rejected.reason).join(' · ')}
            </p>
          )}

          {status.entries.length === 0 && status.error === null && (
            <p className="muted">The catalog contains no verified entries.</p>
          )}

          <div className="preset-grid">
            {status.entries.map((entry) => {
              const installed = entry.installedVersion !== null;
              return (
                <article key={entry.id} className="card preset-card">
                  <div className="card-top">
                    <div>
                      <h3>{entry.name}</h3>
                      <p className="muted small">
                        v{entry.version} · {entry.authors.join(', ') || 'unknown author'} · {entry.license}
                      </p>
                    </div>
                    <span className={`pill ${scoreTone(entry.safety.label)}`} title={entry.safety.reasons.join('\n')}>
                      {entry.safety.score}/100 · {entry.safety.label}
                    </span>
                  </div>

                  <p className="preset-description">{entry.description}</p>

                  <div className="chip-row">
                    <RiskBadge risk={entry.risk} />
                    {entry.tags.slice(0, 3).map((tag) => (
                      <Chip key={tag}>{tag}</Chip>
                    ))}
                    <Chip tone="accent">signature verified</Chip>
                  </div>

                  <p className="muted small">
                    Community: 👍 {entry.ratings.up} · 👎 {entry.ratings.down} · reported crashes {entry.ratings.crashes}
                  </p>
                  <p className="muted small">
                    Local: {entry.stats.applies} apply(s) · {entry.stats.interrupted} interrupted · crash rate{' '}
                    {(entry.stats.crashRate * 100).toFixed(1)}%
                  </p>
                  <p className="muted small" title={entry.safety.reasons.join('\n')}>
                    Safety: {entry.safety.reasons.slice(0, 2).join(' · ')}
                  </p>

                  <div className="card-actions">
                    <button
                      type="button"
                      className="button button-primary"
                      disabled={busy || (installed && !entry.updateAvailable)}
                      onClick={() => onInstall(entry.id)}
                    >
                      {installed ? (entry.updateAvailable ? 'Update' : 'Installed') : 'Install'}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}

      <div className="row">
        <label className="small">
          <input
            type="checkbox"
            checked={telemetry?.consent ?? false}
            disabled={busy || status === null}
            onChange={(event) => onConsent(event.target.checked)}
          />{' '}
          Share anonymous crash statistics
        </label>
      </div>

      <p className="muted small">
        Local telemetry powers the crash rate shown above. Only preset id/version, the app version and an outcome are
        ever sent — no hardware signature, paths, session ids or free text. Upload is off until you enable it here.
        {telemetry !== null && ` ${telemetry.pending} event(s) queued.`}
        {telemetry !== null && !telemetry.uploadConfigured && ' No upload endpoint is configured.'}
      </p>

      {telemetry?.lastUploadError != null && (
        <p className="small badge-aggressive">Last upload failed: {telemetry.lastUploadError}</p>
      )}
    </section>
  );
}
