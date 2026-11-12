import { useState, type ReactNode } from 'react';
import type { ShaderCacheRootStatus, ShaderCacheStatus } from '../../shared/shader-cache';
import { formatBytes, formatDate } from '../lib/format';

interface ShaderCachePanelProps {
  status: ShaderCacheStatus | null;
  busy: boolean;
  onScan: () => void;
  onPrune: () => void;
}

function rootTone(root: ShaderCacheRootStatus): string {
  if (!root.exists) return 'muted';
  if (!root.readable) return 'danger';
  if (root.orphanedFileCount > 0 || root.warnings.length > 0) return 'warn';
  return 'ok';
}

function rootLabel(root: ShaderCacheRootStatus): string {
  if (!root.exists) return 'Not present';
  if (!root.readable) return 'Unreadable';
  if (root.orphanedFileCount > 0) return `${root.orphanedFileCount} orphaned`;
  if (root.warnings.length > 0) return 'Check warnings';
  return 'Healthy';
}

export function ShaderCachePanel({ status, busy, onScan, onPrune }: ShaderCachePanelProps): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const roots = status?.roots ?? [];
  const present = roots.filter((root) => root.exists);
  const orphaned = status?.totals.orphanedFiles ?? 0;
  const hasCache = present.length > 0;
  const hasWarnings = (status?.warnings.length ?? 0) > 0 || roots.some((root) => root.warnings.length > 0);
  const tone =
    status === null
      ? 'muted'
      : status.error !== null
        ? 'danger'
        : orphaned > 0 || hasWarnings
          ? 'warn'
          : hasCache
            ? 'ok'
            : 'muted';
  const label =
    status === null
      ? 'Loading'
      : status.error !== null
        ? 'Degraded'
        : !hasCache
          ? 'Not found'
          : orphaned > 0
            ? 'Attention'
            : hasWarnings
              ? 'Check warnings'
              : 'Healthy';

  return (
    <section className="panel shader-cache" aria-live="polite">
      <div className="panel-head">
        <div>
          <h2>Shader cache</h2>
          <p className="muted small">
            DirectX PSO and GPU driver cache health. Orphan cleanup uses the cache&apos;s own app metadata;
            opaque vendor caches are never guessed at.
          </p>
        </div>
        <div className="panel-tools">
          <span className={`pill pill-${tone}`}>{label}</span>
          <button type="button" className="button button-ghost small" disabled={busy} onClick={onScan}>
            {busy ? 'Scanning…' : 'Scan now'}
          </button>
        </div>
      </div>

      {status === null ? (
        <p className="muted small">Reading the fixed LocalAppData shader-cache locations…</p>
      ) : (
        <>
          <div className="chip-row cache-totals">
            <span className="chip">{formatBytes(status.totals.totalBytes)}</span>
            <span className="chip">{status.totals.fileCount.toLocaleString()} files</span>
            <span className={`chip ${orphaned > 0 ? 'chip-warn' : 'chip-muted'}`}>
              {orphaned > 0 ? `${orphaned} orphaned · ${formatBytes(status.totals.orphanedBytes)}` : 'no orphaned files'}
            </span>
            <span className="chip chip-muted">
              {status.scannedAt === null ? 'not scanned' : `scan ${formatDate(status.scannedAt)}`}
            </span>
          </div>

          {status.error !== null && (
            <p className="badge-aggressive small" role="alert">
              Shader-cache scan failed: {status.error}
            </p>
          )}

          {status.warnings.length > 0 && (
            <details className="cache-warnings">
              <summary className="muted small">{status.warnings.length} scan warning(s)</summary>
              <ul className="muted small">
                {status.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          )}

          <ul className="cache-list">
            {roots.map((root) => (
              <li key={root.id} className="cache-row">
                <div className="cache-row-copy">
                  <div className="cache-row-top">
                    <strong>{root.label}</strong>
                    <span className={`pill pill-${rootTone(root)}`}>{rootLabel(root)}</span>
                  </div>
                  <code className="cache-path">{root.displayPath}</code>
                  <p className="muted small">
                    {root.exists
                      ? `${formatBytes(root.totalBytes)} · ${root.fileCount.toLocaleString()} file(s)`
                      : 'This cache location is not used on this machine.'}
                    {root.exists && root.orphanSupport === 'opaque' ? ' · opaque driver cache, read-only' : ''}
                    {root.exists && root.orphanSupport === 'metadata'
                      ? ` · ${root.orphanedFileCount} metadata-proven orphan(s)`
                      : ''}
                  </p>
                  {root.warnings.length > 0 && (
                    <p className="cache-root-warning small" title={root.warnings.join(' · ')}>
                      {root.warnings[0]}
                      {root.warnings.length > 1 ? ` (+${root.warnings.length - 1})` : ''}
                    </p>
                  )}
                </div>
              </li>
            ))}
            {roots.length === 0 && (
              <li className="muted small">
                LocalAppData is unavailable, so no shader-cache roots could be resolved.
              </li>
            )}
          </ul>

          <div className="card-actions cache-actions">
            <button
              type="button"
              className={`button ${confirming ? 'button-danger' : 'button-ghost'} small`}
              disabled={busy || orphaned === 0}
              onBlur={() => setConfirming(false)}
              onClick={() => {
                if (!confirming) {
                  setConfirming(true);
                  return;
                }
                setConfirming(false);
                onPrune();
              }}
            >
              {confirming ? 'Confirm orphan prune' : orphaned > 0 ? `Prune orphaned (${orphaned})` : 'Prune orphaned'}
            </button>
          </div>

          <p className="muted small cache-note">
            Only whole DirectX <code>.dxcache</code> files whose every recorded executable is gone and that
            have been untouched for 24 hours are eligible. DirectX rebuilds them on the next launch, so the
            first run of an affected title can hitch. NVIDIA and AMD caches are hashed, opaque files; TuneSmith
            reports their size but never deletes them without a game mapping.
          </p>
        </>
      )}
    </section>
  );
}
