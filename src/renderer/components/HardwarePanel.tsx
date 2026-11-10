import type { ReactNode } from 'react';
import type { PreflightReport } from '../../shared/session';
import type { HardwareSpec } from '../../shared/types';
import { formatClock, formatGb, storageSummary } from '../lib/format';

export function SafetyBanner({
  preflight,
  onRequestElevation,
  busy,
}: {
  preflight: PreflightReport | null;
  onRequestElevation: () => void;
  busy: boolean;
}): ReactNode {
  if (preflight === null) return null;

  const failures = preflight.checks.filter((c) => c.status === 'fail');
  const warnings = preflight.checks.filter((c) => c.status === 'warn');
  if (failures.length === 0 && warnings.length === 0) return null;

  const needsElevation = failures.some((c) => c.id === 'elevation');

  return (
    <div className={`banner ${failures.length > 0 ? 'banner-danger' : 'banner-warn'}`}>
      <div className="banner-body">
        <strong>{failures.length > 0 ? 'Applying is disabled' : 'Heads up'}</strong>
        <ul>
          {failures.map((c) => (
            <li key={c.id}>{c.detail}</li>
          ))}
          {warnings.map((c) => (
            <li key={c.id} className="banner-muted">
              {c.detail}
            </li>
          ))}
        </ul>
      </div>
      {needsElevation && !preflight.isElevated && (
        <button type="button" className="button button-primary" onClick={onRequestElevation} disabled={busy}>
          Restart as administrator
        </button>
      )}
    </div>
  );
}

function SpecRow({ label, value, hint }: { label: string; value: string; hint?: string }): ReactNode {
  return (
    <div className="spec-row">
      <dt>{label}</dt>
      <dd>
        <span title={value}>{value}</span>
        {hint !== undefined && <small>{hint}</small>}
      </dd>
    </div>
  );
}

export function HardwarePanel({ spec }: { spec: HardwareSpec | null }): ReactNode {
  if (spec === null) {
    return (
      <aside className="panel hardware">
        <h2>Hardware</h2>
        <p className="muted">Detecting…</p>
      </aside>
    );
  }

  const gpu = spec.primaryGpu;

  return (
    <aside className="panel hardware">
      <div className="panel-head">
        <h2>Hardware</h2>
        <span className="muted small">v{spec.signatureVersion}</span>
      </div>

      <dl className="spec-list">
        <SpecRow
          label="CPU"
          value={`${spec.cpu.cores}C / ${spec.cpu.threads}T`}
          hint={`${spec.cpu.rawName} · ${formatClock(spec.cpu.maxClockMhz)}`}
        />
        <SpecRow
          label="GPU"
          value={gpu === null ? 'None' : formatGb(gpu.vramGb)}
          hint={gpu === null ? 'No adapter detected' : `${gpu.rawName} · driver ${gpu.driverVersion ?? 'unknown'}`}
        />
        <SpecRow
          label="Memory"
          value={formatGb(spec.memory.totalGb)}
          hint={
            spec.memory.speedMhz === null
              ? spec.memory.moduleCount === null
                ? undefined
                : `${spec.memory.moduleCount} module(s)`
              : `${spec.memory.moduleCount ?? '?'} module(s) · ${spec.memory.speedMhz} MHz`
          }
        />
        <SpecRow label="Storage" value={spec.storage.primary?.mediaType ?? 'Unknown'} hint={storageSummary(spec)} />
        <SpecRow label="Windows" value={`Build ${spec.os.build}`} hint={spec.os.caption} />
      </dl>

      <div className="signature-block">
        <span className="label">Hardware signature</span>
        <code>{spec.signature}</code>
        <button
          type="button"
          className="button button-ghost small"
          onClick={() => void navigator.clipboard.writeText(spec.signature)}
        >
          Copy
        </button>
      </div>

      {spec.warnings.length > 0 && (
        <details className="warnings">
          <summary>{spec.warnings.length} detection note(s)</summary>
          <ul>
            {spec.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </aside>
  );
}
