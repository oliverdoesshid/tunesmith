import type { ReactNode } from 'react';
import type { RiskLevel } from '../../shared/types';
import type { SessionStatus } from '../../shared/session';
import { riskLabel, statusLabel } from '../lib/format';

export function RiskBadge({ risk }: { risk: RiskLevel }): ReactNode {
  return <span className={`badge badge-${risk}`}>{riskLabel(risk)}</span>;
}

export function StatusPill({ status }: { status: SessionStatus }): ReactNode {
  const tone = status === 'applied' ? 'ok' : status === 'failed' || status === 'rollback-failed' ? 'danger' : status === 'applying' ? 'warn' : 'muted';
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
  onRefresh: () => void;
}

export function Header({ signature, isElevated, isMock, busy, onRefresh }: HeaderProps): ReactNode {
  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          TS
        </span>
        <div>
          <h1>TuneSmith</h1>
          <p>Community presets, matched to your exact hardware.</p>
        </div>
      </div>

      <div className="header-right">
        {signature !== null && (
          <code className="signature" title="Hardware signature">
            {signature}
          </code>
        )}
        {isMock && <span className="pill pill-warn">Browser preview</span>}
        <span className={`pill ${isElevated ? 'pill-ok' : 'pill-danger'}`}>
          {isElevated ? 'Administrator' : 'Not elevated'}
        </span>
        <button type="button" className="button button-ghost" onClick={onRefresh} disabled={busy}>
          {busy ? 'Working…' : 'Refresh'}
        </button>
      </div>
    </header>
  );
}
