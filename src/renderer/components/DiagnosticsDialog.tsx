import { useEffect, useState, type ReactNode } from 'react';
import type {
  DiagnosticsExportResult,
  DiagnosticsStatus,
} from '../../shared/diagnostics/types';
import { errorMessage, getBridge } from '../lib/bridge';

interface DiagnosticsDialogProps {
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

/**
 * Review/redact/export drawer for local crash evidence. The bridge asks the main process
 * for a native save path; this component never receives an arbitrary filesystem handle.
 */
export function DiagnosticsDialog({ onClose }: DiagnosticsDialogProps): ReactNode {
  const [status, setStatus] = useState<DiagnosticsStatus | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [redact, setRedact] = useState(true);
  const [includeDumps, setIncludeDumps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DiagnosticsExportResult | null>(null);

  useEffect(() => {
    let alive = true;
    void getBridge()
      .diagnostics.status()
      .then((next) => {
        if (!alive) return;
        setStatus(next);
        setSelected(new Set(next.reports.map((report) => report.id)));
      })
      .catch((err: unknown) => {
        if (alive) setError(errorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exportBundle = async (): Promise<void> => {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const next = await getBridge().diagnostics.exportBundle({
        reportIds: [...selected],
        redact,
        includeDumps,
      });
      setResult(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async (): Promise<void> => {
    try {
      await getBridge().diagnostics.openFolder();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="dialog diagnostics-dialog" role="dialog" aria-modal="true" aria-labelledby="diagnostics-title">
        <header className="dialog-head">
          <div>
            <span className="panel-kicker">SUPPORT / LOCAL EVIDENCE</span>
            <h2 id="diagnostics-title">Diagnostics</h2>
            <p className="muted small">Crash dumps, correlated logs and the durable journal — reviewed before export.</p>
          </div>
          <button type="button" className="button button-ghost small" onClick={onClose} disabled={busy}>
            Close
          </button>
        </header>

        <div className="dialog-body diagnostics-body">
          <section className="diagnostics-privacy">
            <strong>Nothing is uploaded automatically.</strong>
            <p className="muted small">
              TuneSmith stores crash evidence locally. Export is an explicit action; text reports can be redacted,
              while minidumps contain process memory and are never included unless you opt in below.
            </p>
            {status !== null && status.crashDir.length > 0 && (
              <code className="diagnostics-path">{status.crashDir}</code>
            )}
          </section>

          {error !== null && <div className="banner banner-warn" role="alert">{error}</div>}
          {status?.message != null && <p className="muted small">{status.message}</p>}

          <section>
            <div className="settings-section-head">
              <div>
                <h3 className="section-title">Crash reports</h3>
                <p className="muted small">
                  {status === null
                    ? 'Reading local evidence…'
                    : `${String(status.reportCount)} report(s) · ${String(status.dumpCount)} minidump(s) · ${formatBytes(status.totalDumpBytes)}`}
                </p>
              </div>
              {status !== null && status.reports.length > 0 && (
                <div className="settings-all-actions">
                  <button
                    type="button"
                    className="button button-ghost small"
                    onClick={() => setSelected(new Set(status.reports.map((report) => report.id)))}
                  >
                    Select all
                  </button>
                  <button type="button" className="button button-ghost small" onClick={() => setSelected(new Set())}>
                    Clear
                  </button>
                </div>
              )}
            </div>

            {status === null ? (
              <p className="muted small">Loading…</p>
            ) : status.reports.length === 0 ? (
              <p className="muted small">No crash reports are available. That is a good thing.</p>
            ) : (
              <div className="diagnostics-list">
                {status.reports.map((report) => (
                  <label
                    key={report.id}
                    className={`diagnostics-report ${selected.has(report.id) ? 'is-selected' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(report.id)}
                      onChange={() => toggle(report.id)}
                    />
                    <span className="diagnostics-report-copy">
                      <strong>{report.title}</strong>
                      <small>{report.summary}</small>
                      <small className="muted">
                        {report.dumpFiles.length === 0
                          ? 'No correlated minidump'
                          : `${String(report.dumpFiles.length)} minidump(s): ${report.dumpFiles.map((dump) => dump.name).join(', ')}`}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>

          <section className="diagnostics-options">
            <label className="workspace-option settings-option is-on">
              <input type="checkbox" checked={redact} onChange={(event) => setRedact(event.target.checked)} />
              <span className="workspace-check" aria-hidden="true" />
              <span className="workspace-code">R</span>
              <span className="workspace-option-copy">
                <strong>Redact identity</strong>
                <small>Replace your username, home directory and computer name in text artifacts.</small>
              </span>
            </label>
            <label className={`workspace-option settings-option ${includeDumps ? 'is-on' : 'is-disabled'}`}>
              <input
                type="checkbox"
                checked={includeDumps}
                disabled={status === null || status.dumpCount === 0}
                onChange={(event) => setIncludeDumps(event.target.checked)}
              />
              <span className="workspace-check" aria-hidden="true" />
              <span className="workspace-code">D</span>
              <span className="workspace-option-copy">
                <strong>Include minidumps</strong>
                <small>Binary process memory; cannot be redacted. Share only with people you trust.</small>
              </span>
            </label>
          </section>

          {result?.saved === true && result.path !== null && (
            <div className="banner banner-ok" role="status">
              <div className="banner-body">
                <strong>Bundle exported</strong>
                <p className="muted small">
                  {result.path} · {formatBytes(result.bytes)}
                </p>
              </div>
            </div>
          )}
          {result?.saved === false && <p className="muted small">{result.message}</p>}
        </div>

        <footer className="dialog-foot settings-foot">
          <button type="button" className="button button-ghost small" onClick={() => void openFolder()}>
            Open crash folder
          </button>
          <button
            type="button"
            className="button button-primary small"
            disabled={busy || selected.size === 0}
            onClick={() => void exportBundle()}
          >
            {busy ? 'Packaging…' : 'Export reviewed bundle'}
          </button>
        </footer>
      </div>
    </div>
  );
}
