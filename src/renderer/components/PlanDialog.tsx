import { useState, type ReactNode } from 'react';
import type { PresetSummary } from '../../shared/ipc';
import type { CompiledPlan, StepGroup } from '../../shared/preset/compiler';
import type { EngineProgress } from '../../shared/session';
import type { ServiceDependencyGraph } from '../../shared/service-graph';
import { RiskBadge } from './Chrome';
import { ServiceDependencyPanel } from './ServiceDependencyPanel';

const GROUPS: StepGroup[] = ['Registry', 'Services', 'Priorities', 'Power'];

export function PlanDialog({
  preset,
  plan,
  busy,
  progress,
  serviceGraph,
  serviceGraphError,
  onClose,
  onApply,
}: {
  preset: PresetSummary;
  plan: CompiledPlan;
  busy: boolean;
  progress: EngineProgress | null;
  serviceGraph: ServiceDependencyGraph | null;
  serviceGraphError: string | null;
  onClose: () => void;
  onApply: (options: { consent: boolean; risk: boolean }) => void;
}): ReactNode {
  const [consent, setConsent] = useState(!plan.needsConsent);
  const [risk, setRisk] = useState(plan.risk !== 'aggressive');

  const blockers = plan.findings.filter((f) => f.severity === 'block');
  const consents = plan.findings.filter((f) => f.severity === 'consent');
  const warnings = plan.findings.filter((f) => f.severity === 'warn');
  const canApply = blockers.length === 0 && !busy && (risk || plan.risk !== 'aggressive');

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={`${preset.name} plan`}>
      <div className="dialog">
        <header className="dialog-head">
          <div>
            <h2>{preset.name}</h2>
            <p className="muted small">
              v{plan.presetVersion} · {plan.steps.length} change(s) · signature {plan.signature}
            </p>
          </div>
          <RiskBadge risk={plan.risk} />
        </header>

        <div className="dialog-body">
          <section>
            <h3 className="section-title">Active profiles</h3>
            <div className="chip-row">
              {plan.activeProfiles.map((profile) => (
                <span key={profile.id} className={`chip ${profile.conditional ? 'chip-accent' : 'chip-muted'}`}>
                  {profile.name}
                  {profile.conditional ? ' · conditional' : ''}
                </span>
              ))}
              {plan.overrides > 0 && <span className="chip chip-muted">{plan.overrides} override(s)</span>}
            </div>
          </section>

          {plan.summary.Services > 0 && (
            <ServiceDependencyPanel graph={serviceGraph} error={serviceGraphError} />
          )}

          {blockers.length > 0 && (
            <section className="finding finding-block">
              <h3 className="section-title">Blocked</h3>
              <ul>
                {blockers.map((f) => (
                  <li key={`${f.code}-${f.message}`}>{f.message}</li>
                ))}
              </ul>
            </section>
          )}

          {GROUPS.map((group) => {
            const steps = plan.steps.filter((s) => s.group === group);
            if (steps.length === 0) return null;
            return (
              <section key={group}>
                <h3 className="section-title">
                  {group} <span className="muted">({steps.length})</span>
                </h3>
                <ul className="step-list">
                  {steps.map((step) => (
                    <li key={step.key}>
                      <div>
                        <span className="step-label">{step.label}</span>
                        {step.volatile && <span className="chip chip-warn tiny">not persisted</span>}
                        <code className="step-target">{step.target}</code>
                      </div>
                      <span className="step-detail">{step.detail}</span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}

          {(consents.length > 0 || warnings.length > 0) && (
            <section>
              <h3 className="section-title">Safety notes</h3>
              <ul className="finding finding-warn">
                {[...consents.map((f) => f.message), ...warnings.map((f) => f.message)].map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="restore-note">
            <strong>Before anything changes</strong>
            <p>
              {plan.restorePoint === 'none'
                ? 'This preset opts out of a restore point (conservative presets only).'
                : plan.restorePoint === 'required'
                  ? 'A System Restore checkpoint is required; the run aborts if it cannot be created.'
                  : 'TuneSmith attempts a System Restore checkpoint, then records every original value in a rollback journal.'}
            </p>
          </section>

          {plan.needsConsent && consents.length > 0 && (
            <label className="check">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>I have read the sensitive-change notes above.</span>
            </label>
          )}

          {plan.risk === 'aggressive' && (
            <label className="check">
              <input type="checkbox" checked={risk} onChange={(e) => setRisk(e.target.checked)} />
              <span>I understand this preset makes aggressive changes and may reduce stability.</span>
            </label>
          )}

          {progress !== null && busy && (
            <div className="progress">
              <div className="progress-head">
                <span>{progress.message}</span>
                {progress.total !== undefined && progress.current !== undefined && (
                  <span className="muted small">
                    {progress.current}/{progress.total}
                  </span>
                )}
              </div>
              <div className="progress-bar">
                <span
                  style={{
                    width:
                      progress.total !== undefined && progress.current !== undefined
                        ? `${Math.round((progress.current / progress.total) * 100)}%`
                        : '15%',
                  }}
                />
              </div>
            </div>
          )}
        </div>

        <footer className="dialog-foot">
          <button type="button" className="button button-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={!canApply || !consent}
            onClick={() => onApply({ consent, risk })}
          >
            {busy ? 'Applying…' : `Apply ${plan.steps.length} change(s)`}
          </button>
        </footer>
      </div>
    </div>
  );
}
