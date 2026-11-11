import { useState, type ReactNode } from 'react';
import type { RollbackReport, SessionSummary } from '../../shared/session';
import { formatDate } from '../lib/format';
import { StatusPill } from './Chrome';

export function SessionPanel({
  sessions,
  busy,
  onRollback,
  onRestoreDefaults,
}: {
  sessions: SessionSummary[];
  busy: boolean;
  onRollback: (sessionId: string) => void;
  onRestoreDefaults: () => void;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const pending = sessions.filter((s) => s.pendingRollback > 0).length;
  const interrupted = sessions.filter((s) => s.interrupted);

  return (
    <section className="panel sessions">
      <div className="panel-head">
        <h2>Sessions</h2>
        <button
          type="button"
          className={`button ${confirming ? 'button-danger' : 'button-ghost'}`}
          disabled={busy || pending === 0}
          onClick={() => {
            if (!confirming) {
              setConfirming(true);
              return;
            }
            setConfirming(false);
            onRestoreDefaults();
          }}
          onBlur={() => setConfirming(false)}
        >
          {confirming ? 'Click again to restore everything' : 'Restore to default'}
        </button>
      </div>

      {interrupted.length > 0 && (
        <div className="banner banner-warn session-recovery" role="alert">
          <div className="banner-body">
            <strong>Interrupted session detected</strong>
            <p className="small">
              TuneSmith closed while changes were being applied. Use “Restore Previous State” below to
              undo only the entries recorded in that session’s journal, newest first.
            </p>
          </div>
        </div>
      )}

      {sessions.length === 0 ? (
        <p className="muted empty">
          No tuning sessions yet. Applied presets appear here with a one-click rollback.
        </p>
      ) : (
        <ul className="session-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <div className="session-main">
                <div>
                  <span className="session-name">{session.presetName}</span>
                  <span className="muted small">
                    {' '}
                    v{session.presetVersion} · {formatDate(session.createdAt)}
                  </span>
                </div>
                <div className="chip-row">
                  <StatusPill status={session.status} />
                  {session.interrupted && <span className="chip chip-warn">interrupted</span>}
                  {session.pendingRollback > 0 && (
                    <span className="chip chip-accent">{session.pendingRollback} active change(s)</span>
                  )}
                  {session.restorePoint.attempted && !session.restorePoint.ok && (
                    <span className="chip chip-warn" title={session.restorePoint.detail}>
                      no restore point
                    </span>
                  )}
                </div>
              </div>
              {(session.pendingRollback > 0 || session.interrupted) && (
                <button
                  type="button"
                  className="button button-ghost small"
                  disabled={busy}
                  onClick={() => onRollback(session.id)}
                >
                  {session.interrupted ? 'Restore Previous State' : 'Undo'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function summarizeReports(reports: RollbackReport[]): string {
  if (reports.length === 0) return 'Nothing to restore.';
  const restored = reports.reduce((sum, r) => sum + r.restored, 0);
  const failed = reports.reduce((sum, r) => sum + r.failed, 0);
  return failed === 0
    ? `Restored ${restored} change(s) across ${reports.length} session(s).`
    : `Restored ${restored} change(s); ${failed} failed. Check the session log.`;
}
